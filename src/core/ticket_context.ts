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

export interface TicketContextDeps {
  linear: LinearPort;
  slack: SlackPort;
  config: { linearEnabled: boolean; slackEnabled: boolean };
}

export function fetchTicketContext(
  deps: TicketContextDeps,
  identifier: string,
): TicketContext {
  if (!deps.config.linearEnabled) {
    throw new QuayError(
      "adapter_not_enabled",
      "[adapters.linear].enabled = false",
      { adapter: "linear" },
    );
  }

  let issue: LinearIssue | null;
  try {
    issue = deps.linear.getIssue(identifier);
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
      slackThread = deps.slack.fetchThreadContext(slackThreadRef);
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

  return {
    external_ref: externalRef,
    brief,
    ticket_snapshot,
    slack_thread_ref: slackThreadRef,
    tags: block.tags,
    authors: block.authors,
  };
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

  sections.push(`# ${args.externalRef} — ${args.issue.title}`);
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
    lines.push(`- **${a.name}** (\`<@${a.slack_id}>\`)${primary}`);
  });
  return lines.join("\n");
}

function composeTicketContext(body: string): string {
  const stripped = stripQuayConfigBlock(body).trim();
  const content = stripped.length === 0 ? "_(no description)_" : stripped;
  return `## Ticket Context\n\n${content}`;
}

function composeTicketComments(comments: LinearComment[]): string {
  const blocks: string[] = ["## Ticket Comments"];
  for (const c of comments) {
    blocks.push(`**${c.authorName}** — ${c.createdAt}:\n${c.body}`);
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
  const author = msg.authorName ?? "(unknown)";
  let attribution = `**${author}**`;
  if (msg.authorBot) attribution += " *(bot)*";
  if (isParent) attribution += " *(parent)*";
  return `${attribution}:\n${msg.text}`;
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
