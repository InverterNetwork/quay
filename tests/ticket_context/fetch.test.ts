// Tests for `fetchTicketContext`. Adapters spec §6 + §6.1.
//
// Slice 15 — composition layer: Linear identifier + LinearPort + SlackPort
// → TicketContext with canonical brief. The CLI wiring (slice 16) and the
// real adapter implementations (slices 17/18) live downstream.

import { expect, test } from "bun:test";
import { QuayError } from "../../src/core/errors.ts";
import {
  fetchTicketContext,
  type TicketContextDeps,
} from "../../src/core/ticket_context.ts";
import type {
  LinearComment,
  LinearIssue,
} from "../../src/ports/linear.ts";
import type { SlackThreadMessage } from "../../src/ports/slack.ts";
import { FakeLinearAdapter } from "../support/fakes/linear.ts";
import { FakeSlack } from "../support/fakes/slack.ts";

const FENCE = "```";

interface BlockOpts {
  tags?: string[];
  slack_thread?: string | null;
  authors?: { name: string; slack_id: string }[];
}

function quayConfigBlock(opts: BlockOpts = {}): string {
  const tags = opts.tags ?? ["auth-session", "cache"];
  const authors = opts.authors ?? [
    { name: "Fabian Scherer", slack_id: "U06TDC56VJB" },
  ];
  const lines: string[] = [`${FENCE}quay-config`, "tags:"];
  for (const t of tags) lines.push(`  - ${t}`);
  if (opts.slack_thread !== null && opts.slack_thread !== undefined) {
    lines.push(`slack_thread: ${opts.slack_thread}`);
  }
  lines.push("authors:");
  for (const a of authors) {
    lines.push(`  - name: ${a.name}`);
    lines.push(`    slack_id: ${a.slack_id}`);
  }
  lines.push(FENCE);
  return lines.join("\n");
}

function makeIssue(opts: Partial<LinearIssue> & { block?: BlockOpts } = {}): LinearIssue {
  const identifier = opts.identifier ?? "ENG-1276";
  const blockText = quayConfigBlock(opts.block ?? {});
  const body =
    opts.body ??
    `## Context\n\nWe're seeing stale auth sessions.\n\n${blockText}\n\n## Acceptance Criteria\n\n- [ ] Cached values invalidate.\n`;
  return {
    identifier,
    url: opts.url ?? `https://linear.app/inverter/issue/${identifier}`,
    title: opts.title ?? "Cache invalidation under concurrent updates",
    body,
    comments: opts.comments ?? [],
  };
}

function makeUserComment(
  authorName: string,
  body: string,
  createdAt: string,
  id = `comment-${createdAt}`,
): LinearComment {
  return { id, authorName, authorIsBot: false, body, createdAt };
}

function makeBotComment(
  authorName: string,
  body: string,
  createdAt: string,
  id = `comment-${createdAt}`,
): LinearComment {
  return { id, authorName, authorIsBot: true, body, createdAt };
}

function setupFakes(opts: { slackEnabled?: boolean; linearEnabled?: boolean } = {}): {
  linear: FakeLinearAdapter;
  slack: FakeSlack;
  deps: TicketContextDeps;
} {
  const linear = new FakeLinearAdapter();
  const slack = new FakeSlack();
  const deps: TicketContextDeps = {
    linear,
    slack,
    config: {
      linearEnabled: opts.linearEnabled ?? true,
      slackEnabled: opts.slackEnabled ?? true,
    },
  };
  return { linear, slack, deps };
}

const SLACK_URL = "https://inverter.slack.com/archives/C0123ABC/p1700000123000001";
const SLACK_THREAD_REF = "C0123ABC:1700000123.000001";

function configureSampleSlackThread(slack: FakeSlack): {
  parent: SlackThreadMessage;
  replies: SlackThreadMessage[];
} {
  const parent: SlackThreadMessage = {
    ts: "1700000123.000001",
    authorBot: false,
    authorName: "Fabian Scherer",
    text: "Original ask: cache invalidation timing under concurrent writes?",
  };
  const replies: SlackThreadMessage[] = [
    {
      ts: "1700000200.000001",
      authorBot: false,
      authorName: "Marvin Gross",
      text: "Read replicas same-tick or eventual?",
    },
    {
      ts: "1700000300.000001",
      authorBot: false,
      authorName: "Fabian Scherer",
      text: "Default same-tick.",
    },
  ];
  slack.configureThreadContext(SLACK_THREAD_REF, parent, replies);
  return { parent, replies };
}

function expectQuayError(fn: () => unknown): QuayError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(QuayError);
  return caught as QuayError;
}

// ---------------------------------------------------------------------------

test("test_fetch_ticket_context_assembles_full_brief_when_both_adapters_enabled", () => {
  const { linear, slack, deps } = setupFakes();
  linear.setIssue(
    makeIssue({
      block: {
        tags: ["auth-session", "cache"],
        slack_thread: SLACK_URL,
        authors: [
          { name: "Fabian Scherer", slack_id: "U06TDC56VJB" },
          { name: "Marvin Gross", slack_id: "U07ABCDE" },
        ],
      },
      comments: [
        makeUserComment("Marvin Gross", "Worth confirming replicas.", "2026-04-25T14:02:00Z"),
        makeUserComment("Fabian Scherer", "Default same-tick.", "2026-04-25T14:18:00Z"),
      ],
    }),
  );
  configureSampleSlackThread(slack);

  const ctx = fetchTicketContext(deps, "ENG-1276");

  expect(ctx.external_ref).toBe("ENG-1276");
  expect(ctx.slack_thread_ref).toBe(SLACK_THREAD_REF);
  expect(ctx.tags).toEqual(["auth-session", "cache"]);
  expect(ctx.authors).toEqual([
    { name: "Fabian Scherer", slack_id: "U06TDC56VJB" },
    { name: "Marvin Gross", slack_id: "U07ABCDE" },
  ]);

  // Brief contains all canonical sections.
  expect(ctx.brief).toContain("# ENG-1276 — Cache invalidation under concurrent updates");
  expect(ctx.brief).toContain("## Contributors");
  expect(ctx.brief).toContain("**Fabian Scherer** (`<@U06TDC56VJB>`) *(primary)*");
  expect(ctx.brief).toContain("**Marvin Gross** (`<@U07ABCDE>`)");
  expect(ctx.brief).toContain("## Ticket Context");
  expect(ctx.brief).toContain("We're seeing stale auth sessions.");
  expect(ctx.brief).toContain("## Ticket Comments");
  expect(ctx.brief).toContain("Worth confirming replicas.");
  expect(ctx.brief).toContain("## Slack Context");
  expect(ctx.brief).toContain("Original ask: cache invalidation timing under concurrent writes?");

  // Sections appear in canonical order.
  const idxContributors = ctx.brief.indexOf("## Contributors");
  const idxTicketCtx = ctx.brief.indexOf("## Ticket Context");
  const idxComments = ctx.brief.indexOf("## Ticket Comments");
  const idxSlack = ctx.brief.indexOf("## Slack Context");
  expect(idxContributors).toBeGreaterThan(0);
  expect(idxTicketCtx).toBeGreaterThan(idxContributors);
  expect(idxComments).toBeGreaterThan(idxTicketCtx);
  expect(idxSlack).toBeGreaterThan(idxComments);

  expect(slack.fetchThreadContextCalls).toEqual([SLACK_THREAD_REF]);
});

test("test_fetch_ticket_context_omits_slack_section_when_no_thread_ref_parsed", () => {
  const { linear, slack, deps } = setupFakes();
  linear.setIssue(
    makeIssue({
      block: { tags: ["foo"], slack_thread: null, authors: [{ name: "A", slack_id: "U001" }] },
    }),
  );

  const ctx = fetchTicketContext(deps, "ENG-1276");

  expect(ctx.slack_thread_ref).toBeNull();
  expect(ctx.brief).not.toContain("## Slack Context");
  expect(slack.fetchThreadContextCalls).toEqual([]);
});

test("test_fetch_ticket_context_degrades_when_slack_disabled_but_link_parsed", () => {
  const { linear, slack, deps } = setupFakes({ slackEnabled: false });
  linear.setIssue(
    makeIssue({
      block: {
        tags: ["foo"],
        slack_thread: SLACK_URL,
        authors: [{ name: "A", slack_id: "U001" }],
      },
    }),
  );

  // Should not raise even though Slack would have fetched the thread.
  const ctx = fetchTicketContext(deps, "ENG-1276");

  expect(ctx.slack_thread_ref).toBeNull();
  expect(ctx.brief).not.toContain("## Slack Context");
  expect(slack.fetchThreadContextCalls).toEqual([]);
});

test("test_fetch_ticket_context_fails_closed_when_linear_disabled", () => {
  const { deps } = setupFakes({ linearEnabled: false });

  const err = expectQuayError(() => fetchTicketContext(deps, "ENG-1276"));
  expect(err.code).toBe("adapter_not_enabled");
});

test("test_fetch_ticket_context_fails_closed_on_linear_api_error", () => {
  const { linear, deps } = setupFakes();
  linear.set5xx("ENG-1276", "internal server error");

  const err = expectQuayError(() => fetchTicketContext(deps, "ENG-1276"));
  expect(err.code).toBe("adapter_error");
  expect(err.details?.adapter).toBe("linear");
});

test("test_fetch_ticket_context_fails_closed_on_slack_fetch_error_when_enabled", () => {
  const { linear, slack, deps } = setupFakes();
  linear.setIssue(
    makeIssue({
      block: {
        tags: ["foo"],
        slack_thread: SLACK_URL,
        authors: [{ name: "A", slack_id: "U001" }],
      },
    }),
  );
  // No `configureThreadContext` call → fake throws on fetch.
  void slack;

  const err = expectQuayError(() => fetchTicketContext(deps, "ENG-1276"));
  expect(err.code).toBe("adapter_error");
  expect(err.details?.adapter).toBe("slack");
});

test("test_fetch_ticket_context_returns_tags_in_block_order", () => {
  const { linear, deps } = setupFakes();
  linear.setIssue(
    makeIssue({
      block: {
        tags: ["zeta", "alpha", "mid", "beta"],
        authors: [{ name: "A", slack_id: "U001" }],
      },
    }),
  );

  const ctx = fetchTicketContext(deps, "ENG-1276");
  expect(ctx.tags).toEqual(["zeta", "alpha", "mid", "beta"]);
});

test("test_fetch_ticket_context_returns_authors_in_block_order", () => {
  const { linear, deps } = setupFakes();
  linear.setIssue(
    makeIssue({
      block: {
        tags: ["foo"],
        authors: [
          { name: "Primary", slack_id: "U001" },
          { name: "Second", slack_id: "U002" },
          { name: "Third", slack_id: "U003" },
        ],
      },
    }),
  );

  const ctx = fetchTicketContext(deps, "ENG-1276");
  expect(ctx.authors).toEqual([
    { name: "Primary", slack_id: "U001" },
    { name: "Second", slack_id: "U002" },
    { name: "Third", slack_id: "U003" },
  ]);
});

test("test_fetch_ticket_context_includes_user_comments_in_brief", () => {
  const { linear, deps } = setupFakes();
  linear.setIssue(
    makeIssue({
      comments: [
        makeUserComment(
          "Marvin Gross",
          "Worth confirming whether read replicas need same-tick invalidation.",
          "2026-04-25T14:02:00Z",
        ),
        makeUserComment(
          "Fabian Scherer",
          "Default same-tick for safety.",
          "2026-04-25T14:18:00Z",
        ),
      ],
    }),
  );

  const ctx = fetchTicketContext(deps, "ENG-1276");

  expect(ctx.brief).toContain("## Ticket Comments");
  expect(ctx.brief).toContain("**Marvin Gross** — 2026-04-25T14:02:00Z:");
  expect(ctx.brief).toContain(
    "Worth confirming whether read replicas need same-tick invalidation.",
  );
  expect(ctx.brief).toContain("**Fabian Scherer** — 2026-04-25T14:18:00Z:");
  expect(ctx.brief).toContain("Default same-tick for safety.");
  // Chronological order: Marvin's comment appears before Fabian's.
  const idxMarvin = ctx.brief.indexOf("Marvin Gross** — 2026-04-25T14:02");
  const idxFabian = ctx.brief.indexOf("Fabian Scherer** — 2026-04-25T14:18");
  expect(idxMarvin).toBeGreaterThan(0);
  expect(idxFabian).toBeGreaterThan(idxMarvin);
});

test("test_fetch_ticket_context_omits_comments_section_when_no_user_comments", () => {
  const { linear, deps } = setupFakes();
  linear.setIssue(
    makeIssue({
      comments: [
        makeBotComment("Linear (GitHub)", "PR linked: #42", "2026-04-26T09:00:00Z"),
      ],
    }),
  );

  const ctx = fetchTicketContext(deps, "ENG-1276");
  expect(ctx.brief).not.toContain("## Ticket Comments");
});

test("test_fetch_ticket_context_filters_bot_comments_from_brief", () => {
  const { linear, deps } = setupFakes();
  const issue = makeIssue({
    comments: [
      makeBotComment("Linear (GitHub)", "PR linked: #42", "2026-04-26T09:00:00Z"),
      makeUserComment(
        "Fabian Scherer",
        "Following up on the PR linkage.",
        "2026-04-26T10:00:00Z",
      ),
    ],
  });
  linear.setIssue(issue);

  const ctx = fetchTicketContext(deps, "ENG-1276");

  // Brief: bot comment filtered out, user comment retained.
  expect(ctx.brief).toContain("## Ticket Comments");
  expect(ctx.brief).toContain("Following up on the PR linkage.");
  expect(ctx.brief).not.toContain("PR linked: #42");

  // Snapshot: both archived for traceability.
  expect(ctx.ticket_snapshot).toContain("PR linked: #42");
  expect(ctx.ticket_snapshot).toContain("Following up on the PR linkage.");
});

test("test_fetch_ticket_context_brief_section_order_is_canonical", () => {
  const { linear, slack, deps } = setupFakes();
  linear.setIssue(
    makeIssue({
      block: {
        tags: ["foo"],
        slack_thread: SLACK_URL,
        authors: [{ name: "A", slack_id: "U001" }],
      },
      comments: [
        makeUserComment("A", "Body of comment.", "2026-04-26T09:00:00Z"),
      ],
    }),
  );
  configureSampleSlackThread(slack);

  const ctx = fetchTicketContext(deps, "ENG-1276");

  const sections = [
    "## Contributors",
    "## Ticket Context",
    "## Ticket Comments",
    "## Slack Context",
  ];
  let prev = -1;
  for (const heading of sections) {
    const idx = ctx.brief.indexOf(heading);
    expect(idx).toBeGreaterThan(prev);
    prev = idx;
  }

  // With a section omitted, remaining ones close ranks (no `## Ticket Comments` heading).
  const linearOnly = setupFakes();
  linearOnly.linear.setIssue(
    makeIssue({
      block: {
        tags: ["foo"],
        slack_thread: SLACK_URL,
        authors: [{ name: "A", slack_id: "U001" }],
      },
      comments: [],
    }),
  );
  configureSampleSlackThread(linearOnly.slack);
  const ctx2 = fetchTicketContext(linearOnly.deps, "ENG-1276");
  expect(ctx2.brief).not.toContain("## Ticket Comments");
  expect(ctx2.brief.indexOf("## Slack Context")).toBeGreaterThan(
    ctx2.brief.indexOf("## Ticket Context"),
  );
});

test("test_fetch_ticket_context_strips_quay_config_block_from_brief", () => {
  const { linear, deps } = setupFakes();
  linear.setIssue(
    makeIssue({
      block: {
        tags: ["foo"],
        authors: [{ name: "A", slack_id: "U001" }],
      },
    }),
  );

  const ctx = fetchTicketContext(deps, "ENG-1276");

  expect(ctx.brief).not.toContain("```quay-config");
  expect(ctx.brief).not.toContain("slack_id");

  // Snapshot retains the original body verbatim, fence intact.
  expect(ctx.ticket_snapshot).toContain("```quay-config");
  expect(ctx.ticket_snapshot).toContain("slack_id");
});

test("test_fetch_ticket_context_404_surfaces_as_ticket_not_found", () => {
  const { deps } = setupFakes();
  // No state configured for ENG-9999 → fake returns null (404).

  const err = expectQuayError(() => fetchTicketContext(deps, "ENG-9999"));
  expect(err.code).toBe("ticket_not_found");
});

test("test_fetch_ticket_context_block_invalid_propagates", () => {
  const { linear, deps } = setupFakes();
  linear.setIssue(
    makeIssue({
      // Body containing a `quay-config` fence with malformed YAML.
      body: `## Context\n\nFoo.\n\n${FENCE}quay-config\n:::!!! not yaml\n${FENCE}\n`,
    }),
  );

  const err = expectQuayError(() => fetchTicketContext(deps, "ENG-1276"));
  expect(err.code).toBe("ticket_block_invalid");
  expect(err.details?.detail).toBeDefined();
});

test("test_fetch_ticket_context_block_missing_returns_error", () => {
  const { linear, deps } = setupFakes();
  linear.setIssue(
    makeIssue({
      body: "## Context\n\nA Linear ticket body without any quay-config fence.\n",
    }),
  );

  const err = expectQuayError(() => fetchTicketContext(deps, "ENG-1276"));
  expect(err.code).toBe("ticket_block_invalid");
  expect(err.details?.detail).toBe(
    "no quay-config block found in ticket body",
  );
});
