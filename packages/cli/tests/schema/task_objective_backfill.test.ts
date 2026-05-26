import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createArtifactStore } from "../../src/artifacts/store.ts";
import { loadOriginalTaskObjective } from "../../src/core/worker_prompt.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import {
  insertAttempt,
  insertRepo,
  insertTask,
} from "../support/fixtures.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BACKFILL_SQL = readFileSync(
  join(REPO_ROOT, "migrations/0014_task_objective_backfill.sql"),
  "utf8",
);

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("0014 backfill creates task_objective rows for legacy tasks pointing at the first attempt's brief file", () => {
  h = createHarness();
  const repoId = insertRepo(h.db, "repo-legacy");
  const taskId = insertTask(h.db, {
    taskId: "task-legacy",
    repoId,
    state: "running",
  });
  const firstAttempt = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    spawnedAt: "2026-04-01T00:00:00.000Z",
  });
  const secondAttempt = insertAttempt(h.db, {
    taskId,
    attemptNumber: 2,
    reason: "ci_fail",
    spawnedAt: "2026-04-01T01:00:00.000Z",
  });
  const store = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });
  // Legacy shape: the first attempt's brief artifact IS the raw original
  // brief (pre-composer enqueue wrote input.brief verbatim there).
  const legacyBrief = store.writeArtifact({
    taskId,
    attemptId: firstAttempt,
    kind: "brief",
    content: "Legacy original task brief.",
    extension: "md",
  });
  // Later attempts wrote their own composed-ish briefs; backfill must not
  // pick these up.
  store.writeArtifact({
    taskId,
    attemptId: secondAttempt,
    kind: "brief",
    content: "Retry brief that nests the original.",
    extension: "md",
  });

  // Simulate the pre-migration state: drop the task_objective row that the
  // bootstrap migration may already have created when the harness ran
  // 0014 on init.
  h.db
    .query(
      `DELETE FROM artifacts
        WHERE task_id = ? AND kind = 'task_objective' AND attempt_id IS NULL`,
    )
    .run(taskId);

  h.db.exec(BACKFILL_SQL);

  const objectiveRow = h.db
    .query<
      { artifact_id: number; file_path: string; content_hash: string },
      [string]
    >(
      `SELECT artifact_id, file_path, content_hash FROM artifacts
        WHERE task_id = ? AND kind = 'task_objective' AND attempt_id IS NULL`,
    )
    .get(taskId);
  expect(objectiveRow).not.toBeNull();
  expect(objectiveRow!.file_path).toBe(legacyBrief.filePath);
  expect(objectiveRow!.content_hash).toBe(legacyBrief.contentHash);

  // loadOriginalTaskObjective happily reads it.
  const objective = loadOriginalTaskObjective(h.db, taskId);
  expect(objective.body).toBe("Legacy original task brief.");
  expect(objective.artifactId).toBe(objectiveRow!.artifact_id);

  // Backfill is idempotent.
  h.db.exec(BACKFILL_SQL);
  const count = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM artifacts
        WHERE task_id = ? AND kind = 'task_objective' AND attempt_id IS NULL`,
    )
    .get(taskId)!.n;
  expect(count).toBe(1);
});

test("0014 backfill skips tasks that already have a task_objective artifact", () => {
  h = createHarness();
  const repoId = insertRepo(h.db, "repo-already-migrated");
  const taskId = insertTask(h.db, {
    taskId: "task-already-migrated",
    repoId,
    state: "queued",
  });
  const firstAttempt = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    spawnedAt: "2026-04-01T00:00:00.000Z",
  });
  const store = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });
  store.writeArtifact({
    taskId,
    attemptId: firstAttempt,
    kind: "brief",
    content: "Brief body.",
    extension: "md",
  });
  const existingObjective = store.writeArtifact({
    taskId,
    attemptId: null,
    kind: "task_objective",
    content: "Pre-existing objective body.",
    extension: "md",
  });

  h.db.exec(BACKFILL_SQL);

  // Only the pre-existing row remains.
  const rows = h.db
    .query<{ artifact_id: number }, [string]>(
      `SELECT artifact_id FROM artifacts
        WHERE task_id = ? AND kind = 'task_objective' AND attempt_id IS NULL`,
    )
    .all(taskId);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.artifact_id).toBe(existingObjective.artifactId);
});

test("0014 backfill does not synthesize an objective when the task has no initial brief", () => {
  h = createHarness();
  const repoId = insertRepo(h.db, "repo-no-initial-brief");
  const taskId = insertTask(h.db, {
    taskId: "task-no-initial-brief",
    repoId,
    state: "queued",
  });
  // Attempt without an associated brief artifact.
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    spawnedAt: "2026-04-01T00:00:00.000Z",
  });

  h.db
    .query(
      `DELETE FROM artifacts
        WHERE task_id = ? AND kind = 'task_objective' AND attempt_id IS NULL`,
    )
    .run(taskId);

  h.db.exec(BACKFILL_SQL);
  const count = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM artifacts
        WHERE task_id = ? AND kind = 'task_objective' AND attempt_id IS NULL`,
    )
    .get(taskId)!.n;
  expect(count).toBe(0);
});
