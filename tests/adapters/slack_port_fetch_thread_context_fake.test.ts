// Tests for FakeSlack's fetchThreadContext extension. Adapters spec §7.
//
// The fake is the v1 substrate for downstream slices that compose briefs
// from a Slack thread (real adapter implementation lands in slice 18).
// These tests pin the contract — parent + ordered replies, the truncation
// shape (first half + canonical marker + last half) at both the default
// cap and a config override, and the throw on a missing thread.

import { expect, test } from "bun:test";
import type { SlackThreadMessage } from "../../src/ports/slack.ts";
import { FakeSlack } from "../support/fakes/slack.ts";

const THREAD_REF = "C123:1700.001";

function parent(): SlackThreadMessage {
  return {
    ts: "1700.001",
    authorBot: false,
    authorName: "Fabian",
    text: "Original ask in the thread.",
  };
}

function reply(idx: number, opts: { bot?: boolean } = {}): SlackThreadMessage {
  // Pad index so numeric and lexical ordering agree; tests assert order.
  const ts = `1700.${String(idx).padStart(6, "0")}`;
  return {
    ts,
    authorBot: opts.bot ?? false,
    authorName: opts.bot ? null : `User${idx}`,
    text: `reply #${idx}`,
  };
}

function manyReplies(count: number): SlackThreadMessage[] {
  const out: SlackThreadMessage[] = [];
  for (let i = 1; i <= count; i++) out.push(reply(i));
  return out;
}

test("test_slack_port_fake_fetch_thread_context_returns_parent_and_replies", () => {
  const fake = new FakeSlack();
  const replies = [reply(1), reply(2), reply(3, { bot: true })];
  fake.configureThreadContext(THREAD_REF, parent(), replies);

  const ctx = fake.fetchThreadContext(THREAD_REF);
  expect(ctx.parent.ts).toBe("1700.001");
  expect(ctx.parent.text).toBe("Original ask in the thread.");
  expect(ctx.replies.map((r) => r.ts)).toEqual([
    "1700.000001",
    "1700.000002",
    "1700.000003",
  ]);
  expect(ctx.replies[2]!.authorBot).toBe(true);
  expect(fake.fetchThreadContextCalls).toEqual([THREAD_REF]);
});

test("test_slack_port_fake_fetch_thread_context_truncates_above_cap", () => {
  const fake = new FakeSlack();
  // Default cap is 200 — so 500 replies should truncate to 100 + marker + 100.
  fake.configureThreadContext(THREAD_REF, parent(), manyReplies(500));

  const ctx = fake.fetchThreadContext(THREAD_REF);
  expect(ctx.replies).toHaveLength(201);
  // First 100 are the head of the original list.
  expect(ctx.replies.slice(0, 100).map((r) => r.text)).toEqual(
    manyReplies(500).slice(0, 100).map((r) => r.text),
  );
  // Marker sits at position 100. Literal canonical text per spec §7.
  const marker = ctx.replies[100]!;
  expect(marker.text).toBe(
    "<!-- thread truncated: 300 intermediate messages omitted -->",
  );
  expect(marker.authorBot).toBe(true);
  expect(marker.authorName).toBeNull();
  // Last 100 are the tail of the original list.
  expect(ctx.replies.slice(101).map((r) => r.text)).toEqual(
    manyReplies(500).slice(400).map((r) => r.text),
  );
});

test("test_slack_port_fake_fetch_thread_context_respects_config_override", () => {
  const fake = new FakeSlack();
  fake.setMaxThreadMessages(50);
  // 60-message thread → above the override cap → first 25 + marker + last 25.
  fake.configureThreadContext(THREAD_REF, parent(), manyReplies(60));

  const ctx = fake.fetchThreadContext(THREAD_REF);
  expect(ctx.replies).toHaveLength(51);
  expect(ctx.replies.slice(0, 25).map((r) => r.text)).toEqual(
    manyReplies(60).slice(0, 25).map((r) => r.text),
  );
  const marker = ctx.replies[25]!;
  expect(marker.text).toBe(
    "<!-- thread truncated: 10 intermediate messages omitted -->",
  );
  expect(marker.authorBot).toBe(true);
  expect(marker.authorName).toBeNull();
  expect(ctx.replies.slice(26).map((r) => r.text)).toEqual(
    manyReplies(60).slice(35).map((r) => r.text),
  );
});

test("test_slack_port_fake_fetch_thread_context_returns_full_thread_under_cap", () => {
  const fake = new FakeSlack();
  // 50 replies vs default cap of 200 → no truncation.
  const replies = manyReplies(50);
  fake.configureThreadContext(THREAD_REF, parent(), replies);

  const ctx = fake.fetchThreadContext(THREAD_REF);
  expect(ctx.replies).toHaveLength(50);
  expect(ctx.replies.map((r) => r.text)).toEqual(replies.map((r) => r.text));
  // No marker anywhere.
  for (const r of ctx.replies) {
    expect(r.text.startsWith("<!-- thread truncated")).toBe(false);
  }
});

test("test_slack_port_fake_fetch_thread_context_throws_on_thread_not_found", () => {
  const fake = new FakeSlack();
  // No configureThreadContext call → fake should throw, not return empty.
  // The caller (`ticketContext.fetch`) wraps as `adapter_error{adapter:"slack"}`.

  let caught: unknown;
  try {
    fake.fetchThreadContext(THREAD_REF);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toMatch(/thread not found/i);
});

test("test_slack_port_existing_methods_unchanged", () => {
  // Smoke-test the four pre-slice-14 methods on the fake to confirm the
  // interface extension didn't disturb their behavior. The slice-6/8 test
  // suites cover deeper semantics; this test pins the surface area.
  const fake = new FakeSlack();
  const ref = "C99:0.001";

  // post — appends a bot message and returns its ts.
  const posted = fake.post({ threadRef: ref, body: "hello with nonce ABC123" });
  expect(typeof posted.ts).toBe("string");
  expect(posted.ts.length).toBeGreaterThan(0);
  expect(fake.postCalls).toEqual([
    { threadRef: ref, body: "hello with nonce ABC123" },
  ]);

  // fenceTs — returns latest ts in the thread.
  const fence = fake.fenceTs(ref);
  expect(fence).toBe(posted.ts);
  expect(fake.fenceCalls).toEqual([ref]);

  // searchByNonce — finds bot messages whose body contains the nonce.
  const found = fake.searchByNonce(ref, "ABC123");
  expect(found).not.toBeNull();
  expect(found!.ts).toBe(posted.ts);
  expect(found!.authorBot).toBe(true);
  expect(fake.searchByNonce(ref, "missing")).toBeNull();

  // listReplies — returns messages strictly above the lower bound.
  fake.appendHumanReply(ref, "human answer");
  const after = fake.listReplies(ref, posted.ts);
  expect(after.map((r) => r.text)).toEqual(["human answer"]);
  expect(fake.listCalls.at(-1)).toEqual({
    threadRef: ref,
    lowerBoundTs: posted.ts,
  });
});
