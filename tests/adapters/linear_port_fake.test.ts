// Tests for the in-process FakeLinearAdapter. Adapters spec §7.
//
// The fake is the v1 substrate for downstream slices (ticketContext.fetch,
// quay enqueue --linear-issue): the real `LinearAdapter` lands in slice 17.
// These tests pin the contract — `LinearIssue` field shape, `null` on 404,
// and the four QuayError throw paths (draft / 5xx / 429-with-retry-after /
// adapter_error semantics).

import { expect, test } from "bun:test";
import { QuayError } from "../../src/core/errors.ts";
import type { LinearIssue } from "../../src/ports/linear.ts";
import { FakeLinearAdapter } from "../support/fakes/linear.ts";

function sampleIssue(identifier = "ENG-1234"): LinearIssue {
  return {
    identifier,
    url: `https://linear.app/inverter/issue/${identifier}`,
    title: "Add cache invalidation for auth-session",
    body: "Body markdown including a quay-config fence.",
    comments: [
      {
        id: "comment-001",
        authorName: "Fabian Scherer",
        authorIsBot: false,
        body: "Original ask.",
        createdAt: "2026-04-01T10:00:00.000Z",
      },
      {
        id: "comment-002",
        authorName: "Linear (GitHub)",
        authorIsBot: true,
        body: "PR linked: #42",
        createdAt: "2026-04-02T11:30:00.000Z",
      },
    ],
  };
}

test("test_linear_port_fake_get_issue_returns_structured_payload", async () => {
  const fake = new FakeLinearAdapter();
  fake.setIssue(sampleIssue());

  const issue = await fake.getIssue("ENG-1234");
  expect(issue).not.toBeNull();
  expect(issue!.identifier).toBe("ENG-1234");
  expect(issue!.url).toBe("https://linear.app/inverter/issue/ENG-1234");
  expect(issue!.title).toBe("Add cache invalidation for auth-session");
  expect(issue!.body).toBe("Body markdown including a quay-config fence.");
  expect(issue!.comments).toHaveLength(2);
  expect(issue!.comments[0]!.authorName).toBe("Fabian Scherer");
  expect(issue!.comments[0]!.authorIsBot).toBe(false);
  expect(issue!.comments[1]!.authorIsBot).toBe(true);
  expect(fake.getIssueCalls).toEqual(["ENG-1234"]);
});

test("test_linear_port_fake_get_issue_returns_null_on_404", async () => {
  const fake = new FakeLinearAdapter();
  // No state configured for ENG-9999 → fake returns null (404 semantics),
  // not an exception.

  expect(await fake.getIssue("ENG-9999")).toBeNull();
  expect(fake.getIssueCalls).toEqual(["ENG-9999"]);
});

test("test_linear_port_fake_throws_on_draft_issue", async () => {
  const fake = new FakeLinearAdapter();
  fake.setDraft("ENG-1234");

  let caught: unknown;
  try {
    await fake.getIssue("ENG-1234");
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(QuayError);
  const err = caught as QuayError;
  expect(err.code).toBe("ticket_not_actionable");
});

test("test_linear_port_fake_throws_on_5xx_with_retryable_false", async () => {
  const fake = new FakeLinearAdapter();
  fake.set5xx("ENG-1234", "internal server error");

  let caught: unknown;
  try {
    await fake.getIssue("ENG-1234");
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(QuayError);
  const err = caught as QuayError;
  expect(err.code).toBe("adapter_error");
  expect(err.details?.adapter).toBe("linear");
  expect(err.details?.retryable).toBe(false);
});

test("test_linear_port_fake_throws_on_429_with_retryable_true_and_retry_after", async () => {
  const fake = new FakeLinearAdapter();
  fake.set429("ENG-1234", 42);

  let caught: unknown;
  try {
    await fake.getIssue("ENG-1234");
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(QuayError);
  const err = caught as QuayError;
  expect(err.code).toBe("adapter_error");
  expect(err.details?.adapter).toBe("linear");
  expect(err.details?.retryable).toBe(true);
  expect(err.details?.retry_after).toBe(42);
});

test("test_linear_port_fake_set_issue_state_records_calls_in_order", async () => {
  // The fake captures each non-idempotent setIssueState call so wiring
  // tests can assert on the writeback shape.
  const fake = new FakeLinearAdapter();

  await fake.setIssueState("ENG-1234", "In Progress");
  await fake.setIssueState("ENG-1234", "Waiting");
  await fake.setIssueState("AST-200", "Canceled");

  expect(fake.setIssueStateCalls).toEqual([
    { identifier: "ENG-1234", stateName: "In Progress" },
    { identifier: "ENG-1234", stateName: "Waiting" },
    { identifier: "AST-200", stateName: "Canceled" },
  ]);
});

test("test_linear_port_fake_set_issue_state_skips_when_already_at_target", async () => {
  // The fake mirrors the real adapter's read-before-write semantics: when
  // the seeded "current" state already matches the requested name, the
  // call is a no-op and nothing lands in `setIssueStateCalls`.
  const fake = new FakeLinearAdapter();
  fake.setCurrentState("ENG-1234", "Waiting");

  await fake.setIssueState("ENG-1234", "Waiting");

  expect(fake.setIssueStateCalls).toEqual([]);
});

test("test_linear_port_fake_set_issue_state_throws_when_failure_queued", async () => {
  // `failNextSetIssueState` lets tests pin the best-effort warn-and-
  // continue contract without poisoning the read side of the fake. Queued
  // errors are consumed in FIFO order; subsequent calls succeed.
  const fake = new FakeLinearAdapter();
  fake.failNextSetIssueState(new Error("simulated 500"));

  let caught: unknown;
  try {
    await fake.setIssueState("ENG-1", "In Progress");
  } catch (e) {
    caught = e;
  }
  expect((caught as Error).message).toBe("simulated 500");
  expect(fake.setIssueStateCalls).toEqual([]);

  await fake.setIssueState("ENG-1", "In Progress");
  expect(fake.setIssueStateCalls).toEqual([
    { identifier: "ENG-1", stateName: "In Progress" },
  ]);
});
