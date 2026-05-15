// §5 pr-open polling: a fresh `mergeable: CONFLICTING` observation (when
// (head_sha:base_sha) doesn't match `last_conflict_observation`) snapshots
// the conflict slice, schedules a `conflict` attempt with
// `consumed_budget = 0`, and records the new observation. Budget preserved.
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tick_once } from "../../src/core/tick.ts";
import { ensurePreambleIdForAttemptReason } from "../../src/core/preamble.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo, insertTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_conflict_schedules_non_budget_respawn", async () => {
  h = createHarness();
  h.clock.set("2026-04-29T16:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-conflict");
  const taskId = insertTask(h.db, {
    taskId: "task-conflict",
    repoId,
    state: "pr-open",
  });
  const attemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-04-29T15:00:00.000Z",
  });
  h.db
    .query(`UPDATE tasks SET attempts_consumed = 1 WHERE task_id = ?`)
    .run(taskId);

  const built = buildTickDeps(h);
  built.artifactStore.writeArtifact({
    taskId,
    attemptId,
    kind: "brief",
    content: "initial implementation brief",
    extension: "md",
  });

  // Fresh conflict observation (head_sha:base_sha differs from any prior
  // value; `last_conflict_observation` is NULL).
  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    state: "open",
    headSha: "head-c1",
    baseSha: "base-c1",
    mergeable: "conflicting",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "head-c1",
      items: [
        { name: "build", workflow: null, bucket: "pending", required: true },
      ],
    },
  });

  const results = await tick_once(built.deps);
  expect(results).toEqual([
    { task_id: taskId, action: "conflict_respawn_scheduled" },
  ]);

  const task = h.db
    .query<
      {
        state: string;
        attempts_consumed: number;
        last_conflict_observation: string | null;
        non_budget_respawns_consumed: number;
      },
      [string]
    >(
      `SELECT state, attempts_consumed, last_conflict_observation,
              non_budget_respawns_consumed
         FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toEqual({
    state: "queued",
    attempts_consumed: 1, // unchanged
    last_conflict_observation: "head-c1:base-c1",
    non_budget_respawns_consumed: 1,
  });

  const pending = h.db
    .query<
      { reason: string; consumed_budget: number; spawned_at: string | null },
      [string]
    >(
      `SELECT reason, consumed_budget, spawned_at
         FROM attempts WHERE task_id = ? AND spawned_at IS NULL`,
    )
    .get(taskId);
  expect(pending).toEqual({
    reason: "conflict",
    consumed_budget: 0,
    spawned_at: null,
  });

  const slice = h.db
    .query<{ n: number; attempt_id: number | null }, [string]>(
      `SELECT COUNT(*) AS n, MIN(attempt_id) AS attempt_id
         FROM artifacts WHERE task_id = ? AND kind = 'conflict_slice'`,
    )
    .get(taskId);
  expect(slice?.n).toBe(1);
  expect(slice?.attempt_id).toBe(attemptId);

  const event = h.db
    .query<
      { from_state: string; to_state: string; payload_artifact_id: number },
      [string]
    >(
      `SELECT from_state, to_state, payload_artifact_id
         FROM events WHERE task_id = ? AND event_type = 'conflict'`,
    )
    .get(taskId);
  expect(event?.from_state).toBe("pr-open");
  expect(event?.to_state).toBe("queued");
});

test("conflict respawn after latest review_only uses worker preamble and worker brief", async () => {
  h = createHarness();
  h.clock.set("2026-05-15T08:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-conflict-after-review");
  const taskId = insertTask(h.db, {
    taskId: "task-conflict-after-review",
    repoId,
    state: "done",
  });
  const codePreambleId = ensurePreambleIdForAttemptReason(
    h.db,
    h.clock,
    "initial",
  );
  const reviewPreambleId = ensurePreambleIdForAttemptReason(
    h.db,
    h.clock,
    "review_only",
  );
  const workerAttemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    preambleId: codePreambleId,
    reason: "initial",
    consumedBudget: 1,
    spawnedAt: "2026-05-15T07:00:00.000Z",
  });
  const reviewAttemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 2,
    preambleId: reviewPreambleId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: "2026-05-15T07:30:00.000Z",
  });
  h.db
    .query(`UPDATE tasks SET attempts_consumed = 1 WHERE task_id = ?`)
    .run(taskId);

  const built = buildTickDeps(h);
  built.artifactStore.writeArtifact({
    taskId,
    attemptId: workerAttemptId,
    kind: "brief",
    content: "worker implementation brief",
    extension: "md",
  });
  built.artifactStore.writeArtifact({
    taskId,
    attemptId: reviewAttemptId,
    kind: "brief",
    content: "review-only latest brief",
    extension: "md",
  });
  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    state: "open",
    headSha: "head-conflict-review",
    baseSha: "base-conflict-review",
    mergeable: "conflicting",
    latestReview: { decision: "APPROVED", latestReviewId: "review-ok", comments: "" },
    checks: { checkSha: "head-conflict-review", items: [] },
  });

  const results = await tick_once(built.deps);
  expect(results).toEqual([
    { task_id: taskId, action: "conflict_respawn_scheduled" },
  ]);

  const pending = h.db
    .query<
      { attempt_id: number; preamble_id: number; reason: string },
      [string]
    >(
      `SELECT attempt_id, preamble_id, reason
         FROM attempts
        WHERE task_id = ? AND spawned_at IS NULL`,
    )
    .get(taskId);
  expect(pending!.reason).toBe("conflict");
  const kind = h.db
    .query<{ kind: string }, [number]>(
      `SELECT kind FROM preambles WHERE preamble_id = ?`,
    )
    .get(pending!.preamble_id);
  expect(kind!.kind).toBe("code");

  const finalPromptRow = h.db
    .query<{ file_path: string }, [string, number]>(
      `SELECT file_path FROM artifacts
        WHERE task_id = ? AND attempt_id = ? AND kind = 'final_prompt'`,
    )
    .get(taskId, pending!.attempt_id);
  const finalPrompt = readFileSync(finalPromptRow!.file_path, "utf8");
  expect(finalPrompt.startsWith("Quay protocol preamble")).toBe(true);
  expect(finalPrompt).not.toContain("You are running as a Quay reviewer worker");
  expect(finalPrompt).not.toContain("Do not modify code");
  expect(finalPrompt).not.toContain("Do not push");
  expect(finalPrompt).not.toContain("You do not push");
  expect(finalPrompt).toContain("worker implementation brief");
  expect(finalPrompt).not.toContain("review-only latest brief");
});

test("changes-requested respawn from done after latest review_only uses worker preamble", async () => {
  h = createHarness();
  h.clock.set("2026-05-15T08:30:00.000Z");

  const repoId = insertRepo(h.db, "repo-review-after-review");
  const taskId = insertTask(h.db, {
    taskId: "task-review-after-review",
    repoId,
    state: "done",
  });
  const codePreambleId = ensurePreambleIdForAttemptReason(
    h.db,
    h.clock,
    "initial",
  );
  const reviewPreambleId = ensurePreambleIdForAttemptReason(
    h.db,
    h.clock,
    "review_only",
  );
  const workerAttemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    preambleId: codePreambleId,
    reason: "initial",
    consumedBudget: 1,
    spawnedAt: "2026-05-15T07:00:00.000Z",
  });
  const reviewAttemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 2,
    preambleId: reviewPreambleId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: "2026-05-15T07:30:00.000Z",
  });
  h.db
    .query(`UPDATE tasks SET attempts_consumed = 1 WHERE task_id = ?`)
    .run(taskId);

  const built = buildTickDeps(h);
  built.artifactStore.writeArtifact({
    taskId,
    attemptId: workerAttemptId,
    kind: "brief",
    content: "worker implementation brief for review follow-up",
    extension: "md",
  });
  built.artifactStore.writeArtifact({
    taskId,
    attemptId: reviewAttemptId,
    kind: "brief",
    content: "review-only latest brief should be skipped",
    extension: "md",
  });
  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    state: "open",
    headSha: "head-review-follow-up",
    baseSha: "base-review-follow-up",
    mergeable: "mergeable",
    latestReview: {
      decision: "CHANGES_REQUESTED",
      latestReviewId: "review-needs-work",
      comments: "please fix this",
    },
    checks: { checkSha: "head-review-follow-up", items: [] },
  });

  const results = await tick_once(built.deps);
  expect(results).toEqual([
    { task_id: taskId, action: "review_respawn_scheduled" },
  ]);

  const pending = h.db
    .query<
      { attempt_id: number; preamble_id: number; reason: string },
      [string]
    >(
      `SELECT attempt_id, preamble_id, reason
         FROM attempts
        WHERE task_id = ? AND spawned_at IS NULL`,
    )
    .get(taskId);
  expect(pending!.reason).toBe("review");
  const kind = h.db
    .query<{ kind: string }, [number]>(
      `SELECT kind FROM preambles WHERE preamble_id = ?`,
    )
    .get(pending!.preamble_id);
  expect(kind!.kind).toBe("code");

  const finalPromptRow = h.db
    .query<{ file_path: string }, [string, number]>(
      `SELECT file_path FROM artifacts
        WHERE task_id = ? AND attempt_id = ? AND kind = 'final_prompt'`,
    )
    .get(taskId, pending!.attempt_id);
  const finalPrompt = readFileSync(finalPromptRow!.file_path, "utf8");
  expect(finalPrompt.startsWith("Quay protocol preamble")).toBe(true);
  expect(finalPrompt).not.toContain("You are running as a Quay reviewer worker");
  expect(finalPrompt).not.toContain("Do not modify code");
  expect(finalPrompt).not.toContain("Do not push");
  expect(finalPrompt).not.toContain("You do not push");
  expect(finalPrompt).toContain("worker implementation brief for review follow-up");
  expect(finalPrompt).not.toContain("review-only latest brief should be skipped");
});
