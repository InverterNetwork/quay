import { afterEach, expect, test } from "bun:test";
import {
  createPreamble,
  ensurePreambleIdForAttemptReason,
  loadPreambleBody,
  preambleKindForAttemptReason,
  REVIEWER_PROTOCOL_PREAMBLE_BODY,
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

test("review preamble fallback keeps latest reviewer guidance even when it lacks protocol", () => {
  h = createHarness();
  const guidanceId = insertPreamble(
    h.db,
    "Focus especially on API boundary regressions.",
    "review",
  );

  const reviewerPreambleId = ensurePreambleIdForAttemptReason(
    h.db,
    h.clock,
    "review_only",
  );

  expect(reviewerPreambleId).toBe(guidanceId);
  const reviewerBody = loadPreambleBody(h.db, reviewerPreambleId);
  expect(reviewerBody).toBe("Focus especially on API boundary regressions.");
  expect(REVIEWER_PROTOCOL_PREAMBLE_BODY).toContain(".quay-review-result.json");
  expect(REVIEWER_PROTOCOL_PREAMBLE_BODY).toContain("Do not modify source files");
  expect(REVIEWER_PROTOCOL_PREAMBLE_BODY).toContain("call `gh pr review`");
  expect(REVIEWER_PROTOCOL_PREAMBLE_BODY).toContain("`severity` (`blocking` or `non_blocking`)");
  expect(REVIEWER_PROTOCOL_PREAMBLE_BODY).toContain("optional `principle_text`");
  expect(REVIEWER_PROTOCOL_PREAMBLE_BODY).toContain("optional `locations`");
  expect(REVIEWER_PROTOCOL_PREAMBLE_BODY).toContain("`## Review Findings`");
  expect(REVIEWER_PROTOCOL_PREAMBLE_BODY).toContain("`### Blocking`");
  expect(REVIEWER_PROTOCOL_PREAMBLE_BODY).toContain("`### Non-blocking`");
  expect(REVIEWER_PROTOCOL_PREAMBLE_BODY).toContain("`quay-principle` fenced block");
});

test("explicit review preamble override validates only review kind", () => {
  h = createHarness();
  const guidanceId = insertPreamble(
    h.db,
    "Custom repo review guidance.",
    "review",
  );
  const db = h.db;
  const clock = h.clock;

  expect(
    ensurePreambleIdForAttemptReason(db, clock, "review_only", {
      overridePreambleId: guidanceId,
    }),
  ).toBe(guidanceId);
});

test("review preamble resolution rejects stale direct-post guidance", () => {
  h = createHarness();
  const staleGuidanceId = insertPreamble(
    h.db,
    "Post the review directly to GitHub via `gh pr review`.",
    "review",
  );

  expect(() =>
    ensurePreambleIdForAttemptReason(h!.db, h!.clock, "review_only", {
      overridePreambleId: staleGuidanceId,
    }),
  ).toThrow(/conflict with the static reviewer protocol/);
});

test("review preamble creation rejects stale direct-post guidance", () => {
  h = createHarness();

  expect(() =>
    createPreamble(
      h!.db,
      h!.clock,
      "review",
      "Post the review directly to GitHub via `gh pr review`.",
    ),
  ).toThrow(/conflict with the static reviewer protocol/);
  expect(
    h.db.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM preambles`).get(),
  ).toEqual({ count: 0 });
});
