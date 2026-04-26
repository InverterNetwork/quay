import { test, expect, afterEach } from "bun:test";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertPreamble, insertTask } from "../support/fixtures.ts";

const NOW = "2026-01-01T00:00:00.000Z";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_schema_rejects_orphan_attempts_artifacts_and_events", () => {
  h = createHarness();

  const fkRow = h.db
    .query<{ foreign_keys: number }, []>("PRAGMA foreign_keys")
    .get();
  expect(fkRow?.foreign_keys).toBe(1);

  const preambleId = insertPreamble(h.db);

  // Orphan attempt: no matching task row.
  expect(() =>
    h!.db
      .query(
        `INSERT INTO attempts (task_id, attempt_number, preamble_id, reason, consumed_budget)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("ghost-task", 1, preambleId, "initial", 1),
  ).toThrow();

  const taskId = insertTask(h.db);

  // Orphan artifact: attempt_id does not exist.
  expect(() =>
    h!.db
      .query(
        `INSERT INTO artifacts (task_id, attempt_id, kind, file_path, captured_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(taskId, 9999, "blocker", "/tmp/x.bin", NOW),
  ).toThrow();

  // Orphan artifact: task_id does not exist.
  expect(() =>
    h!.db
      .query(
        `INSERT INTO artifacts (task_id, attempt_id, kind, file_path, captured_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("ghost-task", null, "ticket_snapshot", "/tmp/x.bin", NOW),
  ).toThrow();

  // Orphan event: task_id does not exist.
  expect(() =>
    h!.db
      .query(
        `INSERT INTO events (task_id, event_type, occurred_at) VALUES (?, ?, ?)`,
      )
      .run("ghost-task", "spawned", NOW),
  ).toThrow();

  // Orphan event: payload_artifact_id does not exist.
  expect(() =>
    h!.db
      .query(
        `INSERT INTO events (task_id, event_type, payload_artifact_id, occurred_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(taskId, "blocker_ingested", 9999, NOW),
  ).toThrow();

  // Sanity check: a fully-linked chain still inserts cleanly.
  const attemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    preambleId,
    spawnedAt: NOW,
  });
  h.db
    .query(
      `INSERT INTO events (task_id, attempt_id, event_type, occurred_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(taskId, attemptId, "spawned", NOW);
});
