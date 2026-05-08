// Real SlackAdapter `fetchThreadContext` tests (slice 18, adapters spec §7).
// These run the adapter end-to-end against an injected synchronous transport
// — no network, no `SLACK_TOKEN`, no child process. The integration test
// file (`slack_adapter_integration.test.ts`) covers the real-network code
// path behind `QUAY_INTEGRATION_TESTS=1`.

import { expect, test } from "bun:test";
import { QuayError } from "../../src/core/errors.ts";
import {
  SlackAdapter,
  type SlackTransport,
  type SlackTransportRequest,
  type SlackTransportResponse,
} from "../../src/adapters/slack.ts";

const THREAD_REF = "C123:1700.001";

interface CapturedRequest extends SlackTransportRequest {
  parsedQuery: URLSearchParams;
}

interface RecorderHandle {
  requests: CapturedRequest[];
  transport: SlackTransport;
}

function recorder(
  responder: (req: CapturedRequest) => SlackTransportResponse,
): RecorderHandle {
  const requests: CapturedRequest[] = [];
  const transport: SlackTransport = (req) => {
    const queryStart = req.url.indexOf("?");
    const parsedQuery =
      queryStart >= 0
        ? new URLSearchParams(req.url.slice(queryStart + 1))
        : new URLSearchParams();
    const captured: CapturedRequest = { ...req, parsedQuery };
    requests.push(captured);
    return responder(captured);
  };
  return { requests, transport };
}

function jsonResponse(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): SlackTransportResponse {
  return { status: 200, headers, body: JSON.stringify(body) };
}

function parentMessage(
  overrides: Partial<{
    ts: string;
    text: string;
    user: string;
    user_profile: { display_name?: string; real_name?: string };
  }> = {},
): Record<string, unknown> {
  return {
    type: "message",
    ts: overrides.ts ?? "1700.001",
    user: overrides.user ?? "U001",
    text: overrides.text ?? "Original ask in the thread.",
    user_profile: overrides.user_profile ?? {
      display_name: "Fabian",
      real_name: "Fabian Scherer",
    },
  };
}

function replyMessage(
  idx: number,
  overrides: {
    bot?: boolean;
    text?: string;
    authorName?: string | null;
  } = {},
): Record<string, unknown> {
  // Pad the index so numeric and lexical ordering of ts agree.
  const ts = `1700.${String(idx).padStart(6, "0")}`;
  if (overrides.bot === true) {
    return {
      type: "message",
      subtype: "bot_message",
      bot_id: "B999",
      ts,
      text: overrides.text ?? `bot reply #${idx}`,
      bot_profile: { name: overrides.authorName ?? "Quay-Bot" },
    };
  }
  const profile =
    overrides.authorName === undefined
      ? { display_name: `User${idx}`, real_name: `User Number ${idx}` }
      : overrides.authorName === null
        ? null
        : { display_name: overrides.authorName };
  return {
    type: "message",
    ts,
    user: `U${String(idx).padStart(3, "0")}`,
    text: overrides.text ?? `reply #${idx}`,
    user_profile: profile,
  };
}

function manyReplies(count: number): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 1; i <= count; i++) out.push(replyMessage(i));
  return out;
}

test("test_slack_adapter_fetch_thread_context_returns_parent_and_replies", async () => {
  // Single-page thread: parent + three replies (last one bot-authored).
  // Asserts the canonical shape — parent split out, replies in arrival
  // order, all fields surfaced.
  const handle = recorder(() =>
    jsonResponse({
      ok: true,
      messages: [
        parentMessage(),
        replyMessage(1),
        replyMessage(2),
        replyMessage(3, { bot: true }),
      ],
      has_more: false,
    }),
  );
  const adapter = new SlackAdapter({
    token: "test-token",
    transport: handle.transport,
  });
  const ctx = await adapter.fetchThreadContext(THREAD_REF);
  expect(ctx.parent.ts).toBe("1700.001");
  expect(ctx.parent.text).toBe("Original ask in the thread.");
  expect(ctx.replies.map((r) => r.ts)).toEqual([
    "1700.000001",
    "1700.000002",
    "1700.000003",
  ]);
  expect(ctx.replies[2]!.authorBot).toBe(true);
  // The transport sees one GET to conversations.replies with the parsed
  // channel + ts as query params, and a Bearer auth header.
  expect(handle.requests).toHaveLength(1);
  expect(handle.requests[0]!.method).toBe("GET");
  expect(handle.requests[0]!.url).toContain("conversations.replies");
  expect(handle.requests[0]!.parsedQuery.get("channel")).toBe("C123");
  expect(handle.requests[0]!.parsedQuery.get("ts")).toBe("1700.001");
  expect(handle.requests[0]!.headers.Authorization).toBe("Bearer test-token");
});

test("test_slack_adapter_fetch_thread_context_paginates", async () => {
  // Two-page thread: first page returns parent + first batch with
  // has_more=true and a next_cursor; second page returns the rest. The
  // adapter must stitch them in order and only count one parent.
  const pageOneMessages = [
    parentMessage(),
    replyMessage(1),
    replyMessage(2),
  ];
  const pageTwoMessages = [replyMessage(3), replyMessage(4), replyMessage(5)];
  const handle = recorder((req) => {
    const cursor = req.parsedQuery.get("cursor");
    if (cursor === null) {
      return jsonResponse({
        ok: true,
        messages: pageOneMessages,
        has_more: true,
        response_metadata: { next_cursor: "page-2-cursor" },
      });
    }
    expect(cursor).toBe("page-2-cursor");
    return jsonResponse({
      ok: true,
      messages: pageTwoMessages,
      has_more: false,
    });
  });
  const adapter = new SlackAdapter({
    token: "test-token",
    transport: handle.transport,
  });
  const ctx = await adapter.fetchThreadContext(THREAD_REF);
  expect(ctx.parent.ts).toBe("1700.001");
  expect(ctx.replies.map((r) => r.ts)).toEqual([
    "1700.000001",
    "1700.000002",
    "1700.000003",
    "1700.000004",
    "1700.000005",
  ]);
  expect(handle.requests).toHaveLength(2);
});

test("test_slack_adapter_fetch_thread_context_truncates_above_cap", async () => {
  // 500 replies + default cap (200) → first 100 + canonical marker + last
  // 100, K = 300. Marker text must match spec §7 exactly.
  const replies = manyReplies(500);
  const handle = recorder(() =>
    jsonResponse({
      ok: true,
      messages: [parentMessage(), ...replies],
      has_more: false,
    }),
  );
  const adapter = new SlackAdapter({
    token: "test-token",
    transport: handle.transport,
  });
  const ctx = await adapter.fetchThreadContext(THREAD_REF);
  expect(ctx.replies).toHaveLength(201);
  expect(ctx.replies.slice(0, 100).map((r) => r.text)).toEqual(
    replies.slice(0, 100).map((r) => r.text as string),
  );
  const marker = ctx.replies[100]!;
  expect(marker.text).toBe(
    "<!-- thread truncated: 300 intermediate messages omitted -->",
  );
  expect(marker.authorBot).toBe(true);
  expect(marker.authorName).toBeNull();
  expect(ctx.replies.slice(101).map((r) => r.text)).toEqual(
    replies.slice(400).map((r) => r.text as string),
  );
});

test("test_slack_adapter_fetch_thread_context_respects_config_override", async () => {
  // 60 replies + cap 50 → first 25 + marker + last 25, K = 10.
  const replies = manyReplies(60);
  const handle = recorder(() =>
    jsonResponse({
      ok: true,
      messages: [parentMessage(), ...replies],
      has_more: false,
    }),
  );
  const adapter = new SlackAdapter({
    token: "test-token",
    transport: handle.transport,
    maxThreadMessages: 50,
  });
  const ctx = await adapter.fetchThreadContext(THREAD_REF);
  expect(ctx.replies).toHaveLength(51);
  expect(ctx.replies.slice(0, 25).map((r) => r.text)).toEqual(
    replies.slice(0, 25).map((r) => r.text as string),
  );
  const marker = ctx.replies[25]!;
  expect(marker.text).toBe(
    "<!-- thread truncated: 10 intermediate messages omitted -->",
  );
  expect(marker.authorBot).toBe(true);
  expect(marker.authorName).toBeNull();
  expect(ctx.replies.slice(26).map((r) => r.text)).toEqual(
    replies.slice(35).map((r) => r.text as string),
  );
});

test("test_slack_adapter_fetch_thread_context_returns_full_thread_under_cap", async () => {
  // 50 replies vs default cap of 200 → no truncation, no marker.
  const replies = manyReplies(50);
  const handle = recorder(() =>
    jsonResponse({
      ok: true,
      messages: [parentMessage(), ...replies],
      has_more: false,
    }),
  );
  const adapter = new SlackAdapter({
    token: "test-token",
    transport: handle.transport,
  });
  const ctx = await adapter.fetchThreadContext(THREAD_REF);
  expect(ctx.replies).toHaveLength(50);
  expect(ctx.replies.map((r) => r.text)).toEqual(
    replies.map((r) => r.text as string),
  );
  for (const r of ctx.replies) {
    expect(r.text.startsWith("<!-- thread truncated")).toBe(false);
  }
});

test("test_slack_adapter_fetch_thread_context_marks_bot_messages", async () => {
  // Mix of human + bot replies → bots flagged via either `bot_id` (the
  // canonical Slack signal) or `subtype: "bot_message"`. Either signal
  // alone must light up `authorBot: true`.
  const handle = recorder(() =>
    jsonResponse({
      ok: true,
      messages: [
        parentMessage(),
        replyMessage(1),
        // Bot via bot_id alone (no subtype).
        {
          type: "message",
          ts: "1700.000002",
          bot_id: "B0BOTID",
          text: "bot via bot_id",
          bot_profile: { name: "Linear-Integration" },
        },
        // Bot via subtype alone.
        {
          type: "message",
          ts: "1700.000003",
          subtype: "bot_message",
          username: "Sentry",
          text: "bot via subtype",
        },
        replyMessage(4),
      ],
      has_more: false,
    }),
  );
  const adapter = new SlackAdapter({
    token: "test-token",
    transport: handle.transport,
  });
  const ctx = await adapter.fetchThreadContext(THREAD_REF);
  expect(ctx.replies.map((r) => r.authorBot)).toEqual([
    false,
    true,
    true,
    false,
  ]);
});

test("test_slack_adapter_fetch_thread_context_resolves_author_names_when_available", async () => {
  // Various author surfacings: user_profile.display_name (preferred),
  // user_profile.real_name fallback, bot_profile.name for app messages,
  // bare username for legacy bot messages, and `null` when the payload
  // surfaces nothing usable.
  const handle = recorder(() =>
    jsonResponse({
      ok: true,
      messages: [
        parentMessage(),
        // display_name preferred
        {
          type: "message",
          ts: "1700.000001",
          user: "U001",
          text: "with display name",
          user_profile: {
            display_name: "Fabian",
            real_name: "Fabian Scherer",
          },
        },
        // real_name fallback when display_name is empty
        {
          type: "message",
          ts: "1700.000002",
          user: "U002",
          text: "with real name only",
          user_profile: { display_name: "", real_name: "Marvin Gross" },
        },
        // bot_profile.name used for app-authored messages
        {
          type: "message",
          ts: "1700.000003",
          subtype: "bot_message",
          bot_id: "B0001",
          text: "from app",
          bot_profile: { name: "Linear-App" },
        },
        // legacy bot fallback via top-level username
        {
          type: "message",
          ts: "1700.000004",
          subtype: "bot_message",
          bot_id: "B0002",
          username: "Sentry",
          text: "legacy bot",
        },
        // No surfaceable name → null
        {
          type: "message",
          ts: "1700.000005",
          user: "U999",
          text: "no profile",
        },
      ],
      has_more: false,
    }),
  );
  const adapter = new SlackAdapter({
    token: "test-token",
    transport: handle.transport,
  });
  const ctx = await adapter.fetchThreadContext(THREAD_REF);
  expect(ctx.replies.map((r) => r.authorName)).toEqual([
    "Fabian",
    "Marvin Gross",
    "Linear-App",
    "Sentry",
    null,
  ]);
});

test("test_slack_adapter_fetch_thread_context_throws_on_thread_not_found", async () => {
  // Slack signals "thread not found" via HTTP 200 with `ok: false,
  // error: "thread_not_found"`. The adapter must throw — the caller
  // (`ticketContext.fetch`) then wraps as `adapter_error{adapter:"slack"}`.
  const handle = recorder(() =>
    jsonResponse({ ok: false, error: "thread_not_found" }),
  );
  const adapter = new SlackAdapter({
    token: "test-token",
    transport: handle.transport,
  });
  let caught: unknown;
  try {
    await adapter.fetchThreadContext(THREAD_REF);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toMatch(/thread_not_found/);
});

test("test_slack_adapter_fetch_thread_context_throws_on_429_with_retry_after", async () => {
  // Slack rate-limit: HTTP 429 with `Retry-After: 60` → adapter must
  // surface a QuayError("adapter_error", retryable: true, retry_after: 60).
  // Hermes (the polling layer) decides whether to back off or skip.
  const handle = recorder(() => ({
    status: 429,
    headers: { "Retry-After": "60" },
    body: '{"ok":false,"error":"ratelimited"}',
  }));
  const adapter = new SlackAdapter({
    token: "test-token",
    transport: handle.transport,
  });
  let caught: unknown;
  try {
    await adapter.fetchThreadContext(THREAD_REF);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(QuayError);
  const err = caught as QuayError;
  expect(err.code).toBe("adapter_error");
  expect(err.details?.adapter).toBe("slack");
  expect(err.details?.retryable).toBe(true);
  expect(err.details?.retry_after).toBe(60);
});

test("test_slack_adapter_fetch_thread_context_replaces_slice_14_placeholder", async () => {
  // Slice 14 left this method as `throw new Error("not implemented; landed
  // in slice 18")`. Pin that the real adapter no longer throws "not
  // implemented" — it issues a real API call (here against the injected
  // transport) and returns a structured SlackThread.
  const handle = recorder(() =>
    jsonResponse({
      ok: true,
      messages: [parentMessage(), replyMessage(1)],
      has_more: false,
    }),
  );
  const adapter = new SlackAdapter({
    token: "test-token",
    transport: handle.transport,
  });
  const ctx = await adapter.fetchThreadContext(THREAD_REF);
  expect(ctx.parent.ts).toBe("1700.001");
  expect(ctx.replies).toHaveLength(1);
  // Confirms the placeholder "not implemented" path is gone.
  expect(handle.requests).toHaveLength(1);
});
