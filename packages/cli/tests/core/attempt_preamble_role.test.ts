import { afterEach, expect, test } from "bun:test";
import {
  ensurePreambleIdForAttemptReason,
  loadPreambleBody,
  preambleKindForAttemptReason,
  reviewPreambleUsesStructuredResultProtocol,
} from "../../src/core/preamble.ts";
import { insertPreamble } from "../support/fixtures.ts";
import { createHarness, type Harness } from "../support/harness.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("attempt reasons map to the correct preamble role", () => {
  h = createHarness();
  h.clock.set("2026-05-15T09:30:00.000Z");

  const workerReasons = [
    "initial",
    "ci_fail",
    "crash",
    "stale",
    "wall_clock",
    "malformed_signal",
    "review",
    "conflict",
    "blocker_resolved",
    "advice_answered",
  ];

  for (const reason of workerReasons) {
    expect(preambleKindForAttemptReason(reason)).toBe("code");
    const preambleId = ensurePreambleIdForAttemptReason(h.db, h.clock, reason);
    const kind = h.db
      .query<{ kind: string }, [number]>(
        `SELECT kind FROM preambles WHERE preamble_id = ?`,
      )
      .get(preambleId);
    const body = loadPreambleBody(h.db, preambleId);
    expect(kind!.kind).toBe("code");
    expect(body).not.toContain("You are running as a Quay reviewer worker");
    expect(body).not.toContain("Do not modify code");
    expect(body).not.toContain("Do not push");
    expect(body).not.toContain("You do not push");
  }

  expect(preambleKindForAttemptReason("review_only")).toBe("review");
  const reviewerPreambleId = ensurePreambleIdForAttemptReason(
    h.db,
    h.clock,
    "review_only",
  );
  const reviewerKind = h.db
    .query<{ kind: string }, [number]>(
      `SELECT kind FROM preambles WHERE preamble_id = ?`,
    )
    .get(reviewerPreambleId);
  const reviewerBody = loadPreambleBody(h.db, reviewerPreambleId);
  expect(reviewerKind!.kind).toBe("review");
  expect(reviewerBody).toContain("You are running as a Quay reviewer worker");
  expect(reviewerBody).toContain("Do not modify code");
  expect(reviewerBody).toContain("You do not push");
});

test("review preamble fallback supersedes stale direct-post protocol", () => {
  h = createHarness();
  const staleId = insertPreamble(
    h.db,
    "You are running as a Quay reviewer worker. Post the review directly to GitHub via `gh pr review`.",
    "review",
  );

  const reviewerPreambleId = ensurePreambleIdForAttemptReason(
    h.db,
    h.clock,
    "review_only",
  );

  expect(reviewerPreambleId).toBeGreaterThan(staleId);
  const reviewerBody = loadPreambleBody(h.db, reviewerPreambleId);
  expect(reviewerBody).toContain(".quay-review-result.json");
  expect(reviewerBody).toContain("Do not call `gh pr review`");
  expect(reviewerBody).not.toContain("Post the review directly");
});

test("explicit review preamble override must require structured result file", () => {
  h = createHarness();
  const staleId = insertPreamble(
    h.db,
    "You are running as a Quay reviewer worker. Post the review directly to GitHub via `gh pr review`.",
    "review",
  );
  const db = h.db;
  const clock = h.clock;

  expect(() =>
    ensurePreambleIdForAttemptReason(db, clock, "review_only", {
      overridePreambleId: staleId,
    }),
  ).toThrow(/does not require \.quay-review-result\.json/);
});


test("review preamble protocol check accepts custom do-not-post wording", () => {
  expect(
    reviewPreambleUsesStructuredResultProtocol(
      [
        "You are running as a Quay reviewer worker.",
        "Write `.quay-review-result.json` when the review is complete.",
        "Do not post the review directly to GitHub via gh pr review.",
      ].join("\n"),
    ),
  ).toBe(true);
});

test("review preamble protocol check rejects stale direct-post wording with filename mention", () => {
  expect(
    reviewPreambleUsesStructuredResultProtocol(
      [
        "You are running as a Quay reviewer worker.",
        "Submit your review with gh pr review.",
        "The file `.quay-review-result.json` may be mentioned in docs.",
      ].join("\n"),
    ),
  ).toBe(false);
});
