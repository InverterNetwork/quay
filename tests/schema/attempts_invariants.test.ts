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
