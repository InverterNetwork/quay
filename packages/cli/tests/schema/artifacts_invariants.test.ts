import { test, expect, afterEach } from "bun:test";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertPreamble, insertTask } from "../support/fixtures.ts";

const NOW = "2026-01-01T00:00:00.000Z";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

function insertArtifact(
  h: Harness,
  args: {
    taskId: string;
    attemptId: number | null;
    kind: string;
    contentHash: string | null;
  },
) {
  return h.db
    .query(
      `INSERT INTO artifacts (task_id, attempt_id, kind, file_path, content_hash, captured_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.taskId,
      args.attemptId,
      args.kind,
      `/tmp/${args.kind}.bin`,
      args.contentHash,
      NOW,
    );
}

test("test_schema_enforces_recovery_artifact_idempotency", () => {
  h = createHarness();
  const taskId = insertTask(h.db);
  const preambleId = insertPreamble(h.db);
  const attemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    preambleId,
    spawnedAt: NOW,
  });

  insertArtifact(h, { taskId, attemptId, kind: "blocker", contentHash: "abc123" });
  expect(() =>
    insertArtifact(h!, { taskId, attemptId, kind: "blocker", contentHash: "abc123" }),
  ).toThrow();

  // Different content hash → allowed.
  insertArtifact(h, { taskId, attemptId, kind: "blocker", contentHash: "def456" });

  // NULL content_hash → not constrained (used for non-recovery kinds).
  insertArtifact(h, { taskId, attemptId, kind: "session_log", contentHash: null });
  insertArtifact(h, { taskId, attemptId, kind: "session_log", contentHash: null });

  // NULL attempt_id with same hash → allowed (predicate excludes NULL attempt_id).
  insertArtifact(h, { taskId, attemptId: null, kind: "ticket_snapshot", contentHash: "abc123" });
  insertArtifact(h, { taskId, attemptId: null, kind: "ticket_snapshot", contentHash: "abc123" });
});
