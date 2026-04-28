import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertRepo, insertRunningTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_045_spawn_failure_no_evidence_rolls_back_budget_and_requeues", () => {
  h = createHarness();
  h.clock.set("2026-04-28T13:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-spawn-fail");
  const t = insertRunningTask(h.db, {
    taskId: "task-spawn-fail",
    repoId,
    worktreesRoot: join(h.dataDir, "worktrees"),
    tmuxSession: null,
    attemptsConsumed: 1,
    remoteShaAtSpawn: null,
  });

  const built = buildTickDeps(h);
  built.git.setRemoteHeadSha(repoId, t.branchName, null);
  built.github.setPrExists(repoId, t.branchName, false);

  expect(tick_once(built.deps)).toEqual([
    { task_id: t.taskId, action: "spawn_failed" },
  ]);
  const task = h.db
    .query<
      { state: string; attempts_consumed: number; spawn_failures_consecutive: number },
      [string]
    >(
      `SELECT state, attempts_consumed, spawn_failures_consecutive
       FROM tasks WHERE task_id = ?`,
    )
    .get(t.taskId);
  expect(task).toEqual({
    state: "queued",
    attempts_consumed: 0,
    spawn_failures_consecutive: 1,
  });
  expect(pendingReason(t.taskId)).toBe("initial");
});

test("test_046b_spawn_window_push_without_pr_takes_spawn_failed_default", () => {
  h = createHarness();
  const repoId = insertRepo(h.db, "repo-pushed-no-pr");
  const t = insertRunningTask(h.db, {
    taskId: "task-pushed-no-pr",
    repoId,
    worktreesRoot: join(h.dataDir, "worktrees"),
    tmuxSession: null,
    attemptsConsumed: 1,
    remoteShaAtSpawn: "old",
  });

  const built = buildTickDeps(h);
  built.git.setRemoteHeadSha(repoId, t.branchName, "new");
  built.github.setPrExists(repoId, t.branchName, false);

  tick_once(built.deps);
  const attempt = h.db
    .query<{ exit_kind: string | null }, [number]>(
      `SELECT exit_kind FROM attempts WHERE attempt_id = ?`,
    )
    .get(t.attemptId);
  expect(attempt!.exit_kind).toBe("spawn_failed");
  expect(pendingReason(t.taskId)).toBe("initial");
});

test("test_062_max_spawn_failures_parks_worktree_error", () => {
  h = createHarness();
  const repoId = insertRepo(h.db, "repo-spawn-cap");
  const t = insertRunningTask(h.db, {
    taskId: "task-spawn-cap",
    repoId,
    worktreesRoot: join(h.dataDir, "worktrees"),
    tmuxSession: null,
    attemptsConsumed: 1,
  });
  h.db
    .query(`UPDATE tasks SET spawn_failures_consecutive = 2 WHERE task_id = ?`)
    .run(t.taskId);

  const built = buildTickDeps(h);
  built.git.setRemoteHeadSha(repoId, t.branchName, null);
  built.github.setPrExists(repoId, t.branchName, false);

  tick_once(built.deps);
  const task = h.db
    .query<{ state: string; spawn_failures_consecutive: number }, [string]>(
      `SELECT state, spawn_failures_consecutive FROM tasks WHERE task_id = ?`,
    )
    .get(t.taskId);
  expect(task).toEqual({
    state: "worktree_error",
    spawn_failures_consecutive: 3,
  });
});

test("test_063_evidence_found_recovery_resets_spawn_failures", () => {
  h = createHarness();
  const repoId = insertRepo(h.db, "repo-evidence-reset");
  const t = insertRunningTask(h.db, {
    taskId: "task-evidence-reset",
    repoId,
    worktreesRoot: join(h.dataDir, "worktrees"),
    tmuxSession: null,
    attemptsConsumed: 1,
    prExistedAtSpawn: 0,
    remoteShaAtSpawn: "sha",
  });
  h.db
    .query(`UPDATE tasks SET spawn_failures_consecutive = 2 WHERE task_id = ?`)
    .run(t.taskId);

  const built = buildTickDeps(h);
  built.git.setRemoteHeadSha(repoId, t.branchName, "sha");
  built.github.setPrExists(repoId, t.branchName, true);

  tick_once(built.deps);
  const task = h.db
    .query<{ state: string; spawn_failures_consecutive: number }, [string]>(
      `SELECT state, spawn_failures_consecutive FROM tasks WHERE task_id = ?`,
    )
    .get(t.taskId);
  expect(task).toEqual({ state: "pr-open", spawn_failures_consecutive: 0 });
});

function pendingReason(taskId: string): string | null {
  if (!h) throw new Error("missing harness");
  return (
    h.db
      .query<{ reason: string }, [string]>(
        `SELECT reason FROM attempts WHERE task_id = ? AND spawned_at IS NULL`,
      )
      .get(taskId)?.reason ?? null
  );
}
