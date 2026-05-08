// `fetchTicketContext` — turns a Linear identifier into a composed
// TicketContext. Adapters spec §6 + §6.1 (canonical brief format).
//
// Order is strict (spec §3 atomicity invariant):
//   linear.getIssue → parseQuayConfigBlock → optional slack.fetchThreadContext
//   → composeBrief / composeTicketSnapshot
// No substrate side-effects start here; the validator and the existing
// enqueue path are wired by the CLI layer in slice 16.

import { QuayError } from "./errors.ts";
import {
  parseQuayConfigBlock,
  stripQuayConfigBlock,
  type QuayConfigBlock,
} from "./quay_config_block.ts";
import { normalizeTags } from "./tag_normalize.ts";
import type {
  LinearComment,
  LinearIssue,
  LinearPort,
} from "../ports/linear.ts";
import type {
  SlackPort,
  SlackThread,
  SlackThreadMessage,
} from "../ports/slack.ts";
import type {
  TicketAuthor,
  TicketContext,
} from "../ports/ticket_context.ts";

// ---------------------------------------------------------------------------
// Prompt-injection hardening
// ---------------------------------------------------------------------------

const MAX_BYTES_DEFAULT = 16 * 1024; // 16 KB
const TRUNCATION_SUFFIX = " ... [truncated]";
// Pre-computed byte length of the suffix so the cap arithmetic is exact.
const TRUNCATION_SUFFIX_BYTES = new TextEncoder().encode(TRUNCATION_SUFFIX).byteLength;

/**
 * Sanitises untrusted string content before it is interpolated into the
 * agent prompt brief.
 *
 * Rules applied (in order):
 *  1. Length cap — input is measured in UTF-8 bytes. If it exceeds
 *     `opts.maxBytes` (default 16 384), it is truncated to 15 360 bytes and
 *     the suffix " … [truncated]" is appended.
 *  2. Newline stripping — every CRLF, CR, and LF is replaced with " ␤ "
 *     (space + pilcrow symbol + space). This prevents any content from
 *     forging Markdown headings, code-fences, or new sections.
 *  3. Mention neutralisation — every occurrence of the literal two-character
 *     sequence "<@" is replaced with "<​@" (a zero-width space is
 *     inserted after the angle-bracket). This makes `<@UADMIN>` look
 *     identical visually while being distinct from a real bot-tagging
 *     directive in the prompt.
 */
export function escapeUntrusted(
  s: string,
  opts?: { maxBytes?: number },
): string {
  const cap = opts?.maxBytes ?? MAX_BYTES_DEFAULT;
  // headBytes is the number of content bytes that fit within the cap once the
  // suffix occupies its own bytes.
  const headBytes = cap - TRUNCATION_SUFFIX_BYTES;

  // Step 1: length cap (UTF-8 byte budget).
  const encoded = new TextEncoder().encode(s);
  let working: string;
  if (encoded.byteLength > cap) {
    // Slice to headBytes bytes. TextDecoder with `ignoreBOM` and no `fatal`
    // mode handles partial multi-byte sequences by replacing them with U+FFFD,
    // but we want clean truncation — iterate back until we find a valid
    // boundary.
    let boundary = headBytes;
    while (boundary > 0 && (encoded[boundary]! & 0xc0) === 0x80) {
      boundary--;
    }
    const head = new TextDecoder().decode(encoded.slice(0, boundary));
    working = head + TRUNCATION_SUFFIX;
  } else {
    working = s;
  }

  // Step 2: strip newlines.
  working = working.replace(/\r\n|\r|\n/g, " ␤ ");

  // Step 3: neutralise <@ mention syntax.
  working = working.replace(/<@/g, "<​@");

  return working;
}

export interface TicketContextDeps {
  linear: LinearPort;
  slack: SlackPort;
  config: { linearEnabled: boolean; slackEnabled: boolean };
}

export async function fetchTicketContext(
  deps: TicketContextDeps,
  identifier: string,
): Promise<TicketContext> {
  return (await fetchTicketContextWithIssue(deps, identifier)).ctx;
}

export interface TicketContextWithIssue {
  ctx: TicketContext;
  issue: LinearIssue;
}

// Returns the assembled context AND the raw `LinearIssue` payload. Exists
// for the slice-16 enqueue-linear-issue path, which builds a validator
// payload that needs `body` from the raw issue (block intact, not the
// stripped brief). Splitting this avoids a second round-trip to Linear.
export async function fetchTicketContextWithIssue(
  deps: TicketContextDeps,
  identifier: string,
): Promise<TicketContextWithIssue> {
  if (!deps.config.linearEnabled) {
    throw new QuayError(
      "adapter_not_enabled",
      "[adapters.linear].enabled = false",
      { adapter: "linear" },
    );
  }

  let issue: LinearIssue | null;
  try {
    issue = await deps.linear.getIssue(identifier);
  } catch (e) {
    if (e instanceof QuayError) throw e;
    throw new QuayError(
      "adapter_error",
      `Linear getIssue failed: ${(e as Error).message}`,
      { adapter: "linear", retryable: false },
    );
  }

  if (issue === null) {
    throw new QuayError(
      "ticket_not_found",
      `Linear issue ${identifier} not found`,
      { identifier },
    );
  }

  const block = parseQuayConfigBlock(issue.body);
  if (block === null) {
    const detail = "no quay-config block found in ticket body";
    throw new QuayError("ticket_block_invalid", detail, { detail });
  }

  const externalRef = identifier.toUpperCase();

  let slackThreadRef: string | null = null;
  let slackThread: SlackThread | null = null;
  if (block.slack_thread_ref !== null && deps.config.slackEnabled) {
    slackThreadRef = block.slack_thread_ref;
    try {
      slackThread = await deps.slack.fetchThreadContext(slackThreadRef);
    } catch (e) {
      if (e instanceof QuayError) throw e;
      throw new QuayError(
        "adapter_error",
        `Slack fetchThreadContext failed: ${(e as Error).message}`,
        { adapter: "slack", retryable: false },
      );
    }
  }

  const brief = composeBrief({
    issue,
    externalRef,
    authors: block.authors,
    slackThread,
    slackThreadRef,
  });

  const ticket_snapshot = composeTicketSnapshot({
    issue,
    block,
    slackThreadRef,
    slackThread,
  });

  const ctx: TicketContext = {
    external_ref: externalRef,
    repo: block.repo,
    brief,
    ticket_snapshot,
    slack_thread_ref: slackThreadRef,
    tags: normalizeTags(block.tags),
    authors: block.authors,
  };
  return { ctx, issue };
}

// --- Brief composition (private; spec §6.1) -----------------------------

interface ComposeBriefArgs {
  issue: LinearIssue;
  externalRef: string;
  authors: TicketAuthor[];
  slackThread: SlackThread | null;
  slackThreadRef: string | null;
}

function composeBrief(args: ComposeBriefArgs): string {
  const sections: string[] = [];

  sections.push(`# ${args.externalRef} — ${escapeUntrusted(args.issue.title)}`);
  sections.push(composeContributors(args.authors));
  sections.push(composeTicketContext(args.issue.body));

  const userComments = args.issue.comments.filter((c) => !c.authorIsBot);
  if (userComments.length > 0) {
    sections.push(composeTicketComments(userComments));
  }

  if (args.slackThread !== null && args.slackThreadRef !== null) {
    sections.push(composeSlackContext(args.slackThread, args.slackThreadRef));
  }

  return sections.join("\n\n") + "\n";
}

function composeContributors(authors: TicketAuthor[]): string {
  const lines = ["## Contributors", ""];
  authors.forEach((a, idx) => {
    const primary = idx === 0 ? " *(primary)*" : "";
    lines.push(`- **${escapeUntrusted(a.name)}** (\`<@${a.slack_id}>\`)${primary}`);
  });
  return lines.join("\n");
}

function composeTicketContext(body: string): string {
  const stripped = stripQuayConfigBlock(body).trim();
  const content =
    stripped.length === 0 ? "_(no description)_" : escapeUntrusted(stripped);
  return `## Ticket Context\n\n${content}`;
}

function composeTicketComments(comments: LinearComment[]): string {
  const blocks: string[] = ["## Ticket Comments"];
  for (const c of comments) {
    const authorName = escapeUntrusted(c.authorName);
    const createdAt = escapeUntrusted(c.createdAt);
    const body = escapeUntrusted(c.body);
    blocks.push(`**${authorName}** — ${createdAt}:\n${body}`);
  }
  return blocks.join("\n\n");
}

function composeSlackContext(
  thread: SlackThread,
  threadRef: string,
): string {
  const channel = threadRef.split(":")[0] ?? threadRef;
  const startedIso = slackTsToIso(thread.parent.ts);
  const lines = [
    "## Slack Context",
    "",
    "> Original discussion thread.",
    `> Channel: ${channel}`,
    `> Started: ${startedIso}`,
    "",
    formatSlackMessage(thread.parent, true),
  ];
  for (const reply of thread.replies) {
    lines.push("");
    lines.push(formatSlackMessage(reply, false));
  }
  return lines.join("\n");
}

function formatSlackMessage(
  msg: SlackThreadMessage,
  isParent: boolean,
): string {
  const author = escapeUntrusted(msg.authorName ?? "(unknown)");
  let attribution = `**${author}**`;
  if (msg.authorBot) attribution += " *(bot)*";
  if (isParent) attribution += " *(parent)*";
  return `${attribution}:\n${escapeUntrusted(msg.text)}`;
}

function slackTsToIso(ts: string): string {
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds)) return ts;
  return new Date(seconds * 1000).toISOString();
}

// --- Ticket snapshot (private) ------------------------------------------

interface SnapshotArgs {
  issue: LinearIssue;
  block: QuayConfigBlock;
  slackThreadRef: string | null;
  slackThread: SlackThread | null;
}

function composeTicketSnapshot(args: SnapshotArgs): string {
  return JSON.stringify(
    {
      linear_issue: args.issue,
      quay_config_block: args.block,
      slack_thread_ref: args.slackThreadRef,
      slack_thread: args.slackThread,
    },
    null,
    2,
  );
}
