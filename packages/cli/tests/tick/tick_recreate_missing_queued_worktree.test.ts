import { afterEach, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import {
  insertAttempt,
  insertFinalPromptArtifact,
  insertRepo,
  insertTask,
} from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

// A queued respawn (attempt_number > 1) whose recorded worktree directory has
// vanished. Points the task's worktree_path at a controllable location under
// the harness temp dir so the "missing" precondition is deterministic and the
// recreated directory is cleaned up with the harness.
function seedQueuedRespawnWithMissingWorktree(
  built: ReturnType<typeof buildTickDeps>,
  repoId: string,
  taskId: string,
): string {
  const worktreePath = join(h!.dataDir, "wt", taskId);
  insertTask(h!.db, { taskId, repoId });
  h!.db
    .query(`UPDATE tasks SET worktree_path = ? WHERE task_id = ?`)
    .run(worktreePath, taskId);
  const attemptId = insertAttempt(h!.db, {
    taskId,
    attemptNumber: 2,
    reason: "manual_resume",
    consumedBudget: 1,
  });
  insertFinalPromptArtifact(h!.db, h!.artifactRoot, h!.clock, taskId, attemptId);
  built.github.setPrExists(repoId, `quay/${taskId}`, false);
  // Guard against any stray directory from a prior run — recreate only fires
  // when the path is genuinely absent.
  rmSync(worktreePath, { recursive: true, force: true });
  return worktreePath;
}

function recreatedEvent(taskId: string): Record<string, unknown> {
  const row = h!.db
    .query<{ event_data: string | null }, [string]>(
      `SELECT event_data FROM events
        WHERE task_id = ? AND event_type = 'worktree_recreated'`,
    )
    .get(taskId);
  expect(row).not.toBeNull();
  return JSON.parse(row!.event_data!);
}

test("recreates missing queued worktree from the task remote branch when it exists", async () => {
  h = createHarness();
  h.clock.set("2026-04-26T10:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-recreate-remote");
  const taskId = "task-recreate-remote";
  const built = buildTickDeps(h);
  const worktreePath = seedQueuedRespawnWithMissingWorktree(built, repoId, taskId);
  // Task branch exists on origin -> recover from origin/<task branch>.
  built.git.setRemoteBranches(repoId, [`quay/${taskId}`]);

  const results = await tick_once(built.deps);

  expect(results).toEqual([{ task_id: taskId, action: "spawned" }]);
  expect(built.tmux.spawnCalls).toHaveLength(1);
  // Stale worktree metadata is pruned before re-adding the branch.
  expect(built.git.countCalls("worktreePrune")).toBe(1);
  expect(built.git.calls).toContainEqual({
    op: "worktreeAddExistingBranch",
    args: {
      repoId,
      worktreePath,
      branch: `quay/${taskId}`,
      baseRef: `origin/quay/${taskId}`,
    },
  });
  expect(built.commandRunner.calls).toEqual([
    { command: "bun install", cwd: worktreePath },
  ]);
  expect(recreatedEvent(taskId)).toEqual({
    reason: "missing_queued_worktree",
    branch_name: `quay/${taskId}`,
    recovery_base_branch: `quay/${taskId}`,
    recovery_base_ref: `origin/quay/${taskId}`,
    worktree_path: worktreePath,
  });
  expect(existsSync(worktreePath)).toBe(true);
});

test("recreates missing queued worktree from the base branch when no task remote branch exists", async () => {
  h = createHarness();
  h.clock.set("2026-04-26T10:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-recreate-base");
  const taskId = "task-recreate-base";
  const built = buildTickDeps(h);
  const worktreePath = seedQueuedRespawnWithMissingWorktree(built, repoId, taskId);
  // No remote task branch seeded -> fall back to origin/<base branch> (main).

  const results = await tick_once(built.deps);

  expect(results).toEqual([{ task_id: taskId, action: "spawned" }]);
  expect(built.git.countCalls("worktreePrune")).toBe(1);
  expect(built.git.calls).toContainEqual({
    op: "worktreeAddExistingBranch",
    args: {
      repoId,
      worktreePath,
      branch: `quay/${taskId}`,
      baseRef: "origin/main",
    },
  });
  expect(recreatedEvent(taskId)).toEqual({
    reason: "missing_queued_worktree",
    branch_name: `quay/${taskId}`,
    recovery_base_branch: "main",
    recovery_base_ref: "origin/main",
    worktree_path: worktreePath,
  });
});

test("recreates missing queued worktree despite stale Git worktree registration", async () => {
  h = createHarness();
  h.clock.set("2026-04-26T10:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-recreate-stale");
  const taskId = "task-recreate-stale";
  const built = buildTickDeps(h);
  const worktreePath = seedQueuedRespawnWithMissingWorktree(built, repoId, taskId);

  // Simulate a directory removed out of band: Git still registers the branch
  // as checked out at the (now missing) path. `worktreeAddExistingBranch`
  // would fail with "already used by worktree" unless the recovery prunes the
  // stale registration first.
  built.git.setWorktreeBranch(repoId, worktreePath, `quay/${taskId}`);
  rmSync(worktreePath, { recursive: true, force: true });

  const results = await tick_once(built.deps);

  expect(results).toEqual([{ task_id: taskId, action: "spawned" }]);
  expect(built.tmux.spawnCalls).toHaveLength(1);

  // Prune must run before the re-add so the branch/path are free to reuse.
  const pruneIdx = built.git.calls.findIndex((c) => c.op === "worktreePrune");
  const addIdx = built.git.calls.findIndex(
    (c) => c.op === "worktreeAddExistingBranch",
  );
  expect(pruneIdx).toBeGreaterThanOrEqual(0);
  expect(addIdx).toBeGreaterThan(pruneIdx);
  expect(recreatedEvent(taskId).reason).toBe("missing_queued_worktree");
  expect(existsSync(worktreePath)).toBe(true);
});

test("tears down the partial worktree when recreate dependency install fails", async () => {
  h = createHarness();
  h.clock.set("2026-04-26T10:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-recreate-install-fail");
  const taskId = "task-recreate-install-fail";
  const built = buildTickDeps(h);
  const worktreePath = seedQueuedRespawnWithMissingWorktree(built, repoId, taskId);
  built.commandRunner.failNext("install boom");

  const results = await tick_once(built.deps);

  expect(results).toEqual([
    {
      task_id: taskId,
      action: "spawn_substrate_failed",
      error: expect.stringContaining("install_cmd failed"),
    },
  ]);
  expect(built.tmux.spawnCalls).toHaveLength(0);
  // The half-initialized worktree is removed so the next tick repairs again
  // instead of the `existsSync` guard treating it as healthy.
  expect(built.git.countCalls("worktreeRemove")).toBe(1);
  expect(existsSync(worktreePath)).toBe(false);
  const task = h.db
    .query<{ state: string; attempts_consumed: number }, [string]>(
      `SELECT state, attempts_consumed FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toEqual({ state: "queued", attempts_consumed: 0 });

  // The very next tick (install now succeeds) repeats the full recreate+install
  // path and spawns from a freshly built worktree.
  const retry = await tick_once(built.deps);
  expect(retry).toEqual([{ task_id: taskId, action: "spawned" }]);
  expect(built.tmux.spawnCalls).toHaveLength(1);
  expect(existsSync(worktreePath)).toBe(true);
});
