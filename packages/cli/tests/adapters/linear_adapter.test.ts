// Tests for the real LinearAdapter (adapters spec §7, §12, §17). These run
// the adapter end-to-end against an injected synchronous transport — no
// network, no `LINEAR_API_KEY`, no child process. The integration test file
// (`linear_integration.test.ts`) covers the real-network code path behind
// `QUAY_INTEGRATION_TESTS=1`.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { QuayError } from "../../src/core/errors.ts";
import {
  LinearAdapter,
  type LinearTransport,
  type LinearTransportRequest,
  type LinearTransportResponse,
} from "../../src/adapters/linear.ts";

interface CapturedRequest extends LinearTransportRequest {
  parsedBody: { query: string; variables: Record<string, unknown> };
}

interface RecorderHandle {
  requests: CapturedRequest[];
  transport: LinearTransport;
}

// Recorder: each call grabs the request and returns whatever the responder
// hands back. Responder receives the parsed GraphQL body (query +
// variables) so it can branch on the cursor for pagination tests.
function recorder(
  responder: (req: CapturedRequest) => LinearTransportResponse,
): RecorderHandle {
  const requests: CapturedRequest[] = [];
  const transport: LinearTransport = (req) => {
    const parsed = JSON.parse(req.body) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const captured: CapturedRequest = { ...req, parsedBody: parsed };
    requests.push(captured);
    return responder(captured);
  };
  return { requests, transport };
}

function jsonResponse(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): LinearTransportResponse {
  return { status: 200, headers, body: JSON.stringify(body) };
}

// One-page issue payload helper. `nodes` defaults to a single user comment.
function issuePayload(overrides: {
  identifier?: string;
  url?: string;
  title?: string;
  description?: string;
  draft?: boolean;
  state?: { type: string };
  comments?: {
    pageInfo?: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<Record<string, unknown>>;
  };
}): Record<string, unknown> {
  const issue: Record<string, unknown> = {
    identifier: overrides.identifier ?? "ENG-1234",
    url:
      overrides.url ??
      `https://linear.app/inverter/issue/${overrides.identifier ?? "ENG-1234"}`,
    title: overrides.title ?? "Cache invalidation under concurrent updates",
    description:
      overrides.description ??
      "Body markdown including a quay-config fence.",
    state: overrides.state ?? { type: "started" },
    comments: overrides.comments ?? {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [],
    },
  };
  if (overrides.draft === true) {
    issue.draft = true;
  }
  return { data: { issue } };
}

function relationsPayload(nodes: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    data: {
      issue: {
        identifier: "ENG-2000",
        relations: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes,
        },
      },
    },
  };
}

let savedApiKey: string | undefined;
beforeEach(() => {
  savedApiKey = process.env.LINEAR_API_KEY;
});
afterEach(() => {
  if (savedApiKey === undefined) {
    delete process.env.LINEAR_API_KEY;
  } else {
    process.env.LINEAR_API_KEY = savedApiKey;
  }
});

test("test_linear_adapter_get_issue_returns_structured_payload", async () => {
  const handle = recorder(() =>
    jsonResponse(
      issuePayload({
        identifier: "ENG-1234",
        url: "https://linear.app/inverter/issue/ENG-1234",
        title: "Cache invalidation under concurrent updates",
        description: "## Context\n\n```quay-config\ntags: []\n```",
        comments: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "comment-001",
              createdAt: "2026-04-25T14:02:00.000Z",
              body: "Worth confirming whether read replicas need same-tick invalidation.",
              user: { name: "marvin", displayName: "Marvin Gross" },
              botActor: null,
            },
          ],
        },
      }),
    ),
  );
  const adapter = new LinearAdapter({
    token: "test-token",
    transport: handle.transport,
  });
  const issue = await adapter.getIssue("ENG-1234");
  expect(issue).not.toBeNull();
  expect(issue!.identifier).toBe("ENG-1234");
  expect(issue!.url).toBe("https://linear.app/inverter/issue/ENG-1234");
  expect(issue!.title).toBe("Cache invalidation under concurrent updates");
  expect(issue!.body).toBe("## Context\n\n```quay-config\ntags: []\n```");
  expect(issue!.comments).toHaveLength(1);
  expect(issue!.comments[0]!.id).toBe("comment-001");
  expect(issue!.comments[0]!.authorName).toBe("Marvin Gross");
  expect(issue!.comments[0]!.authorIsBot).toBe(false);
  expect(issue!.comments[0]!.body).toContain("read replicas");
  expect(issue!.comments[0]!.createdAt).toBe("2026-04-25T14:02:00.000Z");
  expect(handle.requests.length).toBe(1);
  expect(handle.requests[0]!.headers.Authorization).toBe("test-token");
});

test("linear adapter returns native blocked-by relations with blocker metadata", async () => {
  const handle = recorder(() =>
    jsonResponse(
      relationsPayload([
        {
          id: "rel-1",
          type: "blocks",
          issue: {
            identifier: "ENG-1999",
            url: "https://linear.app/inverter/issue/ENG-1999",
            title: "Ship prerequisite",
            description: "blocker body",
            state: { type: "started" },
          },
          relatedIssue: {
            identifier: "ENG-2000",
            url: "https://linear.app/inverter/issue/ENG-2000",
            title: "Dependent",
            description: "dependent body",
            state: { type: "started" },
          },
        },
        {
          id: "rel-2",
          type: "blockedBy",
          issue: {
            identifier: "ENG-2000",
            url: "https://linear.app/inverter/issue/ENG-2000",
            title: "Dependent",
            description: "dependent body",
            state: { type: "started" },
          },
          relatedIssue: {
            identifier: "ENG-1500",
            url: "https://linear.app/inverter/issue/ENG-1500",
            title: "Earlier prerequisite",
            description: "earlier blocker body",
            state: { type: "completed" },
          },
        },
        {
          id: "rel-3",
          type: "blockedBy",
          issue: {
            identifier: "ENG-3000",
            url: "https://linear.app/inverter/issue/ENG-3000",
            title: "Downstream dependent",
            description: "downstream body",
            state: { type: "started" },
          },
          relatedIssue: {
            identifier: "ENG-2000",
            url: "https://linear.app/inverter/issue/ENG-2000",
            title: "Current issue",
            description: "current body",
            state: { type: "started" },
          },
        },
        {
          id: "rel-4",
          type: "related",
          issue: {
            identifier: "ENG-2000",
            url: "https://linear.app/inverter/issue/ENG-2000",
            title: "Dependent",
            description: "dependent body",
            state: { type: "started" },
          },
          relatedIssue: {
            identifier: "ENG-1000",
            url: "https://linear.app/inverter/issue/ENG-1000",
            title: "Related only",
            description: "related body",
            state: { type: "completed" },
          },
        },
      ]),
    ),
  );
  const adapter = new LinearAdapter({
    token: "test-token",
    transport: handle.transport,
  });

  const relations = await adapter.getBlockedByRelations("ENG-2000");

  expect(relations).toEqual([
    {
      relationId: "rel-2",
      blocker: {
        identifier: "ENG-1500",
        url: "https://linear.app/inverter/issue/ENG-1500",
        title: "Earlier prerequisite",
        body: "earlier blocker body",
        stateType: "completed",
      },
    },
    {
      relationId: "rel-1",
      blocker: {
        identifier: "ENG-1999",
        url: "https://linear.app/inverter/issue/ENG-1999",
        title: "Ship prerequisite",
        body: "blocker body",
        stateType: "started",
      },
    },
  ]);
  expect(handle.requests[0]!.parsedBody.query).toContain("relations");
});

test("test_linear_adapter_get_issue_returns_null_on_404", async () => {
  // Linear's `issue(id: ...)` returns `data.issue: null` when the
  // identifier doesn't resolve. The adapter must surface that as `null`,
  // not a thrown error (per LinearPort contract — null is a 404, throws
  // are reserved for harder failures).
  const handle = recorder(() =>
    jsonResponse({ data: { issue: null } }),
  );
  const adapter = new LinearAdapter({
    token: "test-token",
    transport: handle.transport,
  });
  expect(await adapter.getIssue("ENG-9999")).toBeNull();
});

test("test_linear_adapter_throws_on_5xx_with_useful_message", async () => {
  const responseBody =
    "<html><body>Internal Server Error: backend pool exhausted</body></html>";
  const handle = recorder(() => ({
    status: 503,
    headers: {},
    body: responseBody,
  }));
  const adapter = new LinearAdapter({
    token: "test-token",
    transport: handle.transport,
  });
  let caught: unknown;
  try {
    await adapter.getIssue("ENG-1234");
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(QuayError);
  const err = caught as QuayError;
  expect(err.code).toBe("adapter_error");
  expect(err.details?.adapter).toBe("linear");
  expect(err.details?.retryable).toBe(false);
  // Response body must surface in the error message so an operator
  // diagnosing a 5xx in the logs can see what the upstream actually said.
  expect(err.message).toContain("503");
  expect(err.message).toContain("backend pool exhausted");
});

test("test_linear_adapter_throws_on_429_with_retry_after", async () => {
  const handle = recorder(() => ({
    status: 429,
    headers: { "Retry-After": "30" },
    body: '{"errors":[{"message":"rate limited"}]}',
  }));
  const adapter = new LinearAdapter({
    token: "test-token",
    transport: handle.transport,
  });
  let caught: unknown;
  try {
    await adapter.getIssue("ENG-1234");
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(QuayError);
  const err = caught as QuayError;
  expect(err.code).toBe("adapter_error");
  expect(err.details?.adapter).toBe("linear");
  expect(err.details?.retryable).toBe(true);
  expect(err.details?.retry_after).toBe(30);
});

test("test_linear_adapter_paginates_comments_to_completion", async () => {
  // Mock issue with 4 comments split across 2 pages. The adapter must
  // walk to the second page and assemble the full chronological list.
  const pageOneNodes = [
    {
      id: "c1",
      createdAt: "2026-04-01T10:00:00.000Z",
      body: "first",
      user: { name: "alice", displayName: "Alice" },
      botActor: null,
    },
    {
      id: "c2",
      createdAt: "2026-04-02T10:00:00.000Z",
      body: "second",
      user: { name: "alice", displayName: "Alice" },
      botActor: null,
    },
  ];
  const pageTwoNodes = [
    {
      id: "c3",
      createdAt: "2026-04-03T10:00:00.000Z",
      body: "third",
      user: { name: "bob", displayName: "Bob" },
      botActor: null,
    },
    {
      id: "c4",
      createdAt: "2026-04-04T10:00:00.000Z",
      body: "fourth",
      user: { name: "bob", displayName: "Bob" },
      botActor: null,
    },
  ];
  const handle = recorder((req) => {
    const after = req.parsedBody.variables.commentsAfter as string | null;
    if (after === null) {
      return jsonResponse(
        issuePayload({
          identifier: "ENG-1234",
          comments: {
            pageInfo: { hasNextPage: true, endCursor: "cursor-page-1" },
            nodes: pageOneNodes,
          },
        }),
      );
    }
    expect(after).toBe("cursor-page-1");
    return jsonResponse(
      issuePayload({
        identifier: "ENG-1234",
        comments: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: pageTwoNodes,
        },
      }),
    );
  });
  const adapter = new LinearAdapter({
    token: "test-token",
    transport: handle.transport,
  });
  const issue = await adapter.getIssue("ENG-1234");
  expect(issue).not.toBeNull();
  expect(issue!.comments.map((c) => c.id)).toEqual(["c1", "c2", "c3", "c4"]);
  // Chronological order check — sorted by createdAt regardless of arrival.
  const timestamps = issue!.comments.map((c) => c.createdAt);
  expect([...timestamps].sort()).toEqual(timestamps);
  // Two HTTP calls: initial fetch + one pagination follow-up.
  expect(handle.requests.length).toBe(2);
});

test("test_linear_adapter_marks_bot_authored_comments", async () => {
  // Linear flags integration-authored comments via `botActor`. The adapter
  // must surface that as `authorIsBot: true` (and propagate the bot's
  // display name as authorName) regardless of whether `user` is also set.
  const handle = recorder(() =>
    jsonResponse(
      issuePayload({
        identifier: "ENG-1234",
        comments: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "human-comment",
              createdAt: "2026-04-01T10:00:00.000Z",
              body: "Original ask.",
              user: { name: "fab", displayName: "Fabian Scherer" },
              botActor: null,
            },
            {
              id: "github-bot-comment",
              createdAt: "2026-04-02T11:30:00.000Z",
              body: "PR linked: #42",
              user: null,
              botActor: { name: "Linear (GitHub)" },
            },
          ],
        },
      }),
    ),
  );
  const adapter = new LinearAdapter({
    token: "test-token",
    transport: handle.transport,
  });
  const issue = await adapter.getIssue("ENG-1234");
  expect(issue).not.toBeNull();
  expect(issue!.comments).toHaveLength(2);
  expect(issue!.comments[0]!.authorIsBot).toBe(false);
  expect(issue!.comments[0]!.authorName).toBe("Fabian Scherer");
  expect(issue!.comments[1]!.authorIsBot).toBe(true);
  expect(issue!.comments[1]!.authorName).toBe("Linear (GitHub)");
});

test("test_linear_adapter_rejects_draft_issues", async () => {
  // Defensive draft check (adapters spec §17): if the issue payload carries
  // a `draft: true` flag, throw `ticket_not_actionable` rather than feed an
  // uncommitted ticket into the enqueue pipeline.
  const handle = recorder(() =>
    jsonResponse(
      issuePayload({ identifier: "ENG-1234", draft: true }),
    ),
  );
  const adapter = new LinearAdapter({
    token: "test-token",
    transport: handle.transport,
  });
  let caught: unknown;
  try {
    await adapter.getIssue("ENG-1234");
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(QuayError);
  const err = caught as QuayError;
  expect(err.code).toBe("ticket_not_actionable");
});

test("test_linear_adapter_does_not_fetch_labels_field", async () => {
  // The LinearIssue v1 type deliberately omits `labels` (adapters spec §7
  // exclusion list). The query must too — even a stray `labels` selection
  // would over-fetch from Linear, leak organizational vocabulary into
  // `ticket_snapshot`, and risk consumers accidentally reading from it.
  const handle = recorder(() => jsonResponse(issuePayload({})));
  const adapter = new LinearAdapter({
    token: "test-token",
    transport: handle.transport,
  });
  await adapter.getIssue("ENG-1234");
  expect(handle.requests.length).toBe(1);
  const query = handle.requests[0]!.parsedBody.query;
  expect(query).not.toMatch(/\blabels\b/);
});

test("test_linear_adapter_resolves_token_from_env", async () => {
  // No explicit token: the adapter should read `LINEAR_API_KEY` lazily on
  // the first call and bail with a clear error if it is missing.
  delete process.env.LINEAR_API_KEY;
  const handle = recorder(() => jsonResponse(issuePayload({})));
  const noKeyAdapter = new LinearAdapter({ transport: handle.transport });
  await expect(noKeyAdapter.getIssue("ENG-1234")).rejects.toThrow(/LINEAR_API_KEY/);

  process.env.LINEAR_API_KEY = "env-resolved-token";
  const adapter = new LinearAdapter({ transport: handle.transport });
  await adapter.getIssue("ENG-1234");
  expect(handle.requests.length).toBe(1);
  expect(handle.requests[0]!.headers.Authorization).toBe(
    "env-resolved-token",
  );
});

test("test_linear_adapter_missing_token_throws_adapter_not_configured", async () => {
  // Spec §12: missing `LINEAR_API_KEY` is a deployment misconfiguration
  // (`adapter_not_configured`), not an upstream `adapter_error`.
  delete process.env.LINEAR_API_KEY;
  const handle = recorder(() => jsonResponse(issuePayload({})));
  const adapter = new LinearAdapter({ transport: handle.transport });
  let caught: unknown = null;
  try {
    await adapter.getIssue("ENG-1234");
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(QuayError);
  expect((caught as QuayError).code).toBe("adapter_not_configured");
  expect((caught as QuayError).details).toMatchObject({
    adapter: "linear",
    env_var: "LINEAR_API_KEY",
  });
  expect(handle.requests.length).toBe(0);
});

test("test_linear_adapter_honors_token_env_var_override", async () => {
  // Operators can re-point the env-var via [adapters.linear].api_key_env;
  // the adapter must read the named variable, not LINEAR_API_KEY.
  delete process.env.LINEAR_API_KEY;
  process.env.MY_CUSTOM_LINEAR_KEY = "custom-token";
  try {
    const handle = recorder(() => jsonResponse(issuePayload({})));
    const adapter = new LinearAdapter({
      transport: handle.transport,
      tokenEnvVar: "MY_CUSTOM_LINEAR_KEY",
    });
    await adapter.getIssue("ENG-1234");
    expect(handle.requests[0]!.headers.Authorization).toBe("custom-token");
  } finally {
    delete process.env.MY_CUSTOM_LINEAR_KEY;
  }
});

test("test_linear_adapter_throws_on_graphql_errors_even_if_issue_present", async () => {
  // Spec §12: any non-empty errors[] is a hard adapter failure. Even when
  // data.issue is populated (e.g. a deprecated-field warning), the adapter
  // must throw adapter_error rather than silently return the issue.
  const validIssue = issuePayload({ identifier: "ENG-1234" });
  const handle = recorder(() =>
    jsonResponse({
      ...validIssue,
      errors: [{ message: "deprecated field used" }],
    }),
  );
  const adapter = new LinearAdapter({
    token: "test-token",
    transport: handle.transport,
  });
  let caught: unknown;
  try {
    await adapter.getIssue("ENG-1234");
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(QuayError);
  const err = caught as QuayError;
  expect(err.code).toBe("adapter_error");
  expect(err.details?.adapter).toBe("linear");
  expect(err.message).toContain("deprecated field used");
});

test("test_linear_adapter_throws_when_pagination_returns_404_mid_fetch", async () => {
  // If a ticket disappears between page 1 and page 2, the adapter must throw
  // adapter_error{retryable:true} rather than returning a partial result.
  // The next poll cycle will receive a clean 404 the caller can handle.
  const handle = recorder((req) => {
    const after = req.parsedBody.variables.commentsAfter as string | null;
    if (after === null) {
      return jsonResponse(
        issuePayload({
          identifier: "ENG-1234",
          comments: {
            pageInfo: { hasNextPage: true, endCursor: "cursor-page-1" },
            nodes: [
              {
                id: "c1",
                createdAt: "2026-04-01T10:00:00.000Z",
                body: "first comment",
                user: { name: "alice", displayName: "Alice" },
                botActor: null,
              },
            ],
          },
        }),
      );
    }
    // Page 2: ticket not found (HTTP 404)
    return { status: 404, headers: {}, body: "" };
  });
  const adapter = new LinearAdapter({
    token: "test-token",
    transport: handle.transport,
  });
  let caught: unknown;
  try {
    await adapter.getIssue("ENG-1234");
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(QuayError);
  const err = caught as QuayError;
  expect(err.code).toBe("adapter_error");
  expect(err.details?.retryable).toBe(true);
  expect(handle.requests.length).toBe(2);
});

test("test_linear_adapter_throws_on_malformed_envelope_shapes", async () => {
  // Malformed envelopes (missing data key, data:null, or data without issue
  // field) must throw adapter_error{retryable:false}. Only {data:{issue:null}}
  // is the documented Linear 404 shape and must return null cleanly.

  const cases: Array<[string, Record<string, unknown>]> = [
    ["empty object", {}],
    ["data:null", { data: null }],
    ["data without issue field", { data: {} }],
  ];

  for (const [label, body] of cases) {
    const handle = recorder(() => ({ status: 200, headers: {}, body: JSON.stringify(body) }));
    const a = new LinearAdapter({ token: "test-token", transport: handle.transport });
    let caught: unknown;
    try {
      await a.getIssue("ENG-1234");
    } catch (e) {
      caught = e;
    }
    expect(caught, `expected throw for shape: ${label}`).toBeInstanceOf(QuayError);
    const err = caught as QuayError;
    expect(err.code, `expected adapter_error for shape: ${label}`).toBe("adapter_error");
    expect(err.details?.retryable, `expected retryable:false for shape: ${label}`).toBe(false);
  }

  // Real 404: {data:{issue:null}} must return null, not throw.
  const handle404 = recorder(() => jsonResponse({ data: { issue: null } }));
  const a404 = new LinearAdapter({ token: "test-token", transport: handle404.transport });
  expect(await a404.getIssue("ENG-9999")).toBeNull();
});

test("test_linear_adapter_throws_when_has_next_page_with_null_cursor", async () => {
  // If Linear returns hasNextPage:true but endCursor:null, continuing
  // pagination would silently truncate comments. Treat it as a hard failure.
  const handle = recorder(() =>
    jsonResponse(
      issuePayload({
        identifier: "ENG-1234",
        comments: {
          pageInfo: { hasNextPage: true, endCursor: null },
          nodes: [
            {
              id: "c1",
              createdAt: "2026-04-01T10:00:00.000Z",
              body: "only comment on page 1",
              user: { name: "alice", displayName: "Alice" },
              botActor: null,
            },
          ],
        },
      }),
    ),
  );
  const adapter = new LinearAdapter({
    token: "test-token",
    transport: handle.transport,
  });
  let caught: unknown;
  try {
    await adapter.getIssue("ENG-1234");
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(QuayError);
  const err = caught as QuayError;
  expect(err.code).toBe("adapter_error");
  expect(err.details?.retryable).toBe(false);
  expect(err.message).toContain("hasNextPage=true with null endCursor");
});
