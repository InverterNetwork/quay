import { test, expect, afterEach } from "bun:test";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertPreamble, insertTask } from "../support/fixtures.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_schema_enforces_one_pending_attempt_per_task", () => {
  h = createHarness();
  const taskId = insertTask(h.db);
  const preambleId = insertPreamble(h.db);

  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    preambleId,
    spawnedAt: null,
  });

  expect(() =>
    insertAttempt(h!.db, {
      taskId,
      attemptNumber: 2,
      preambleId,
      spawnedAt: null,
    }),
  ).toThrow();
});

test("test_schema_allows_new_pending_attempt_after_prior_pending_ended", () => {
  h = createHarness();
  const taskId = insertTask(h.db);
  const preambleId = insertPreamble(h.db);

  const first = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    preambleId,
    spawnedAt: null,
  });
  h.db
    .query(
      `UPDATE attempts
          SET ended_at = ?, review_verdict = 'superseded'
        WHERE attempt_id = ?`,
    )
    .run("2026-01-01T00:00:01.000Z", first);

  expect(() =>
    insertAttempt(h!.db, {
      taskId,
      attemptNumber: 2,
      preambleId,
      spawnedAt: null,
    }),
  ).not.toThrow();
});

test("test_schema_enforces_unique_attempt_number_per_task", () => {
  h = createHarness();
  const taskId = insertTask(h.db);
  const preambleId = insertPreamble(h.db);

  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    preambleId,
    spawnedAt: "2026-01-01T00:00:01.000Z",
  });

  expect(() =>
    insertAttempt(h!.db, {
      taskId,
      attemptNumber: 1,
      preambleId,
      spawnedAt: "2026-01-01T00:00:02.000Z",
    }),
  ).toThrow();
});

test("test_schema_rejects_invalid_consumed_budget", () => {
  h = createHarness();
  const taskId = insertTask(h.db);
  const preambleId = insertPreamble(h.db);

  expect(() =>
    h!.db
      .query(
        `INSERT INTO attempts (task_id, attempt_number, preamble_id, reason, consumed_budget)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(taskId, 1, preambleId, "initial", 2),
  ).toThrow();
});

test("test_schema_has_pr_review_attempt_columns_and_active_dedup_index", () => {
  h = createHarness();
  const cols = h.db
    .query<{ name: string }, []>(`PRAGMA table_info(attempts)`)
    .all()
    .map((c) => c.name);
  expect(cols).toContain("head_sha");
  expect(cols).toContain("review_verdict");
  expect(cols).toContain("review_id");

  const indexes = h.db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type = 'index'`,
    )
    .all()
    .map((r) => r.name);
  expect(indexes).toContain("attempts_review_dedup_idx");
});
