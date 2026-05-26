import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createArtifactStore } from "../../src/artifacts/store.ts";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import {
  insertAttempt,
  insertRepo,
  insertRunningTask,
  insertTask,
  seedTaskObjective,
  writeBlockerFile,
} from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_005_ci_fail_schedules_budget_consuming_retry", async () => {
  h = createHarness();
  h.clock.set("2026-04-28T10:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-ci");
  const taskId = insertTask(h.db, { taskId: "task-ci", repoId, state: "pr-open" });
  seedTaskObjective(h, taskId);
  const attemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-04-28T09:00:00.000Z",
  });
  artifactStore().writeArtifact({
    taskId,
    attemptId,
    kind: "brief",
    content: "latest implementation brief",
    extension: "md",
  });
  h.db
    .query(`UPDATE tasks SET attempts_consumed = 1 WHERE task_id = ?`)
    .run(taskId);

  const built = buildTickDeps(h);
  built.github.setPrCheckStatus(repoId, `quay/${taskId}`, {
    state: "fail",
    excerpt: "unit test failed in widget.spec.ts",
  });

  const results = await tick_once(built.deps);
  expect(results).toEqual([{ task_id: taskId, action: "ci_failed" }]);

  const pending = h.db
    .query<{ attempt_id: number; reason: string; consumed_budget: number }, [string]>(
      `SELECT attempt_id, reason, consumed_budget FROM attempts
       WHERE task_id = ? AND spawned_at IS NULL`,
    )
    .get(taskId);
  expect(pending).toMatchObject({ reason: "ci_fail", consumed_budget: 1 });

  const task = h.db
    .query<{ state: string; attempts_consumed: number }, [string]>(
      `SELECT state, attempts_consumed FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toEqual({ state: "queued", attempts_consumed: 1 });

  const ci = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM artifacts WHERE task_id = ? AND kind = 'ci_failure_excerpt'`,
    )
    .get(taskId);
  expect(ci!.n).toBe(1);

  const briefPath = h.db
    .query<{ file_path: string }, [number]>(
      `SELECT file_path FROM artifacts WHERE attempt_id = ? AND kind = 'brief'`,
    )
    .get(pending!.attempt_id)!.file_path;
  const retryBrief = readFileSync(briefPath, "utf8");
  expect(retryBrief).toContain('reason="ci_fail"');
  expect(retryBrief).toContain("unit test failed");
  // Stable task objective is first-class; the prior attempt's brief is no
  // longer nested into retry prompts.
  expect(retryBrief).toContain("Original task objective.");
  expect(retryBrief).not.toContain("latest implementation brief");
});

test("test_013_final_attempt_blocker_sets_budget_exhausted", async () => {
  h = createHarness();
  h.clock.set("2026-04-28T11:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-final-blocker");
  const t = insertRunningTask(h.db, {
    taskId: "task-final-blocker",
    repoId,
    worktreesRoot: join(h.dataDir, "worktrees"),
    attemptsConsumed: 5,
  });
  seedTaskObjective(h, t.taskId);
  h.db
    .query(`UPDATE tasks SET retry_budget = 5 WHERE task_id = ?`)
    .run(t.taskId);
  artifactStore().writeArtifact({
    taskId: t.taskId,
    attemptId: t.attemptId,
    kind: "brief",
    content: "brief before final blocker",
    extension: "md",
  });
  writeBlockerFile(t.worktreePath, "Need an API decision.");

  const built = buildTickDeps(h);
  built.tmux.markDead(t.sessionName!);

  const results = await tick_once(built.deps);
  expect(results).toEqual([{ task_id: t.taskId, action: "blocker_ingested" }]);

  const task = h.db
    .query<{ state: string; budget_exhausted: number }, [string]>(
      `SELECT state, budget_exhausted FROM tasks WHERE task_id = ?`,
    )
    .get(t.taskId);
  expect(task).toEqual({ state: "awaiting-next-brief", budget_exhausted: 1 });
  expect(pendingCount(t.taskId)).toBe(0);
  expect(artifactCount(t.taskId, "last_failure")).toBe(1);
  expect(handoffReasons(t.taskId)).toContain("worker_blocker");
  expect(handoffReasons(t.taskId)).toContain("budget_exhausted");
});

test("test_021_retry_budget_exhaustion_creates_last_failure", async () => {
  h = createHarness();
  h.clock.set("2026-04-28T12:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-budget-cap");
  const t = insertRunningTask(h.db, {
    taskId: "task-budget-cap",
    repoId,
    worktreesRoot: join(h.dataDir, "worktrees"),
    attemptsConsumed: 5,
  });
  seedTaskObjective(h, t.taskId);
  h.db.query(`UPDATE tasks SET retry_budget = 5 WHERE task_id = ?`).run(t.taskId);
  artifactStore().writeArtifact({
    taskId: t.taskId,
    attemptId: t.attemptId,
    kind: "brief",
    content: "last spawned brief",
    extension: "md",
  });

  const built = buildTickDeps(h);
  built.tmux.markDead(t.sessionName!);
  built.git.setRemoteHeadSha(repoId, t.branchName, null);
  built.github.setPrExists(repoId, t.branchName, false);

  const results = await tick_once(built.deps);
  expect(results).toEqual([{ task_id: t.taskId, action: "crashed" }]);
  const task = h.db
    .query<{ state: string; budget_exhausted: number }, [string]>(
      `SELECT state, budget_exhausted FROM tasks WHERE task_id = ?`,
    )
    .get(t.taskId);
  expect(task).toEqual({ state: "awaiting-next-brief", budget_exhausted: 1 });
  expect(pendingCount(t.taskId)).toBe(0);
  expect(artifactCount(t.taskId, "last_failure")).toBe(1);
  expect(handoffReasons(t.taskId)).toEqual(["budget_exhausted"]);
});

test("test_023_retry_brief_uses_stable_task_objective_not_prior_brief", async () => {
  h = createHarness();
  const repoId = insertRepo(h.db, "repo-latest-brief");
  const taskId = insertTask(h.db, {
    taskId: "task-latest-brief",
    repoId,
    state: "pr-open",
  });
  seedTaskObjective(h, taskId, "Stable original task objective.");
  const first = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-04-28T08:00:00.000Z",
  });
  const second = insertAttempt(h.db, {
    taskId,
    attemptNumber: 2,
    reason: "blocker_resolved",
    spawnedAt: "2026-04-28T09:00:00.000Z",
  });
  const store = artifactStore();
  store.writeArtifact({
    taskId,
    attemptId: first,
    kind: "brief",
    content: "initial composed brief body",
    extension: "md",
  });
  store.writeArtifact({
    taskId,
    attemptId: second,
    kind: "brief",
    content: "orchestrator follow-up brief",
    extension: "md",
  });

  const built = buildTickDeps(h);
  built.github.setPrCheckStatus(repoId, `quay/${taskId}`, {
    state: "fail",
    excerpt: "lint failed",
  });

  await tick_once(built.deps);
  const pending = h.db
    .query<{ attempt_id: number }, [string]>(
      `SELECT attempt_id FROM attempts WHERE task_id = ? AND spawned_at IS NULL`,
    )
    .get(taskId)!;
  const briefPath = h.db
    .query<{ file_path: string }, [number]>(
      `SELECT file_path FROM artifacts WHERE attempt_id = ? AND kind = 'brief'`,
    )
    .get(pending.attempt_id)!.file_path;
  const retryBrief = readFileSync(briefPath, "utf8");
  // The stable task objective stays first-class across attempts; prior
  // briefs (whether the original or an orchestrator follow-up) no longer
  // get nested into retry prompts.
  expect(retryBrief).toContain("Stable original task objective.");
  expect(retryBrief).not.toContain("orchestrator follow-up brief");
  expect(retryBrief).not.toContain("initial composed brief body");
});

test("retry brief preserves task-level PR screenshot request", async () => {
  h = createHarness();
  const repoId = insertRepo(h.db, "repo-screenshot-retry");
  const taskId = insertTask(h.db, {
    taskId: "task-screenshot-retry",
    repoId,
    state: "pr-open",
  });
  h.db
    .query(`UPDATE tasks SET pr_screenshots_requested = 1 WHERE task_id = ?`)
    .run(taskId);
  seedTaskObjective(h, taskId, "Update the billing UI.");
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-04-28T08:00:00.000Z",
  });

  const built = buildTickDeps(h);
  built.github.setPrCheckStatus(repoId, `quay/${taskId}`, {
    state: "fail",
    excerpt: "visual regression check failed",
  });

  await tick_once(built.deps);
  const pending = h.db
    .query<{ attempt_id: number }, [string]>(
      `SELECT attempt_id FROM attempts WHERE task_id = ? AND spawned_at IS NULL`,
    )
    .get(taskId)!;
  const briefPath = h.db
    .query<{ file_path: string }, [number]>(
      `SELECT file_path FROM artifacts WHERE attempt_id = ? AND kind = 'brief'`,
    )
    .get(pending.attempt_id)!.file_path;
  const retryBrief = readFileSync(briefPath, "utf8");
  expect(retryBrief).toContain("<quay-pr-screenshot-request");
  expect(retryBrief).toContain(
    "Attach or link the screenshot(s) in the PR body or a PR comment",
  );
});

function artifactStore() {
  if (!h) throw new Error("missing harness");
  return createArtifactStore({ db: h.db, artifactRoot: h.artifactRoot, clock: h.clock });
}

function pendingCount(taskId: string): number {
  if (!h) throw new Error("missing harness");
  return h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM attempts WHERE task_id = ? AND spawned_at IS NULL`,
    )
    .get(taskId)!.n;
}

function artifactCount(taskId: string, kind: string): number {
  if (!h) throw new Error("missing harness");
  return h.db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM artifacts WHERE task_id = ? AND kind = ?`,
    )
    .get(taskId, kind)!.n;
}

function handoffReasons(taskId: string): string[] {
  if (!h) throw new Error("missing harness");
  return h.db
    .query<{ reason: string }, [string]>(
      `SELECT reason FROM orchestrator_handoffs
        WHERE task_id = ?
        ORDER BY handoff_id`,
    )
    .all(taskId)
    .map((r) => r.reason);
}
