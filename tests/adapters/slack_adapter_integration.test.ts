// Slack adapter contract tests are gated behind QUAY_INTEGRATION_TESTS=1
// because they require a Slack bot token + a test channel. The default
// `bun test` run must remain green without credentials.

import { describe, expect, test } from "bun:test";
import { SlackAdapter } from "../../src/adapters/slack.ts";

const integration = process.env.QUAY_INTEGRATION_TESTS === "1";

describe.skipIf(!integration)("SlackAdapter contract (integration)", () => {
  test("instantiates without error", () => {
    expect(new SlackAdapter()).toBeDefined();
  });

  test("fetchThreadContext against a known sandbox thread returns a structured payload", () => {
    // Operators wire a sandbox thread ref via QUAY_SLACK_SANDBOX_THREAD_REF
    // (formatted as `<channel>:<ts>`) when running this opt-in suite.
    // Without it, this is a no-op so the gate stays useful even on partial
    // integration setups (mirrors the Linear sandbox pattern in
    // `linear_adapter_integration.test.ts`).
    const ref = process.env.QUAY_SLACK_SANDBOX_THREAD_REF;
    if (ref === undefined || ref === "") return;
    const adapter = new SlackAdapter();
    const ctx = adapter.fetchThreadContext(ref);
    expect(ctx.parent).toBeDefined();
    expect(typeof ctx.parent.ts).toBe("string");
    expect(Array.isArray(ctx.replies)).toBe(true);
  });
});

test("test_slack_adapter_fetch_thread_context_contract_tests_skipped_without_integration_flag", () => {
  // Pin the gate itself: this asserts the integration block does not run
  // by default. Mirrors the linear adapter's `_skipped_without_integration_flag`
  // test. Live calls against `https://slack.com/api/conversations.replies`
  // require credentials and a real channel; CI must stay green without
  // either.
  expect(integration).toBe(false);
});

test("slack adapter contract block is skipped by default", () => {
  // Existing pre-slice-18 gate test, kept for the original assertion.
  expect(integration).toBe(false);
});
