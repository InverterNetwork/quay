import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { tick_once } from "../../src/core/tick.ts";
import type { PrSnapshot } from "../../src/ports/github.ts";
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

function closedUnmergedSnapshot(prNumber: number): PrSnapshot {
  return {
    prNumber,
    prUrl: `https://example.invalid/pr/${prNumber}`,
    state: "closed_unmerged",
    headSha: `head-${prNumber}`,
    baseSha: `base-${prNumber}`,
    mergeable: "unknown",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: `head-${prNumber}`,
      items: [
        { name: "build", workflow: null, bucket: "pending", required: true },
      ],
    },
  };
}

test("queued task whose Quay-owned PR is closed unmerged finalises before spawn", async () => {
  h = createHarness();
  h.clock.set("2026-05-17T20:10:00.000Z");

  const repoId = insertRepo(h.db, "repo-closed-unmerged-queued");
  const taskId = insertTask(h.db, {
    taskId: "task-closed-unmerged-queued",
    repoId,
    state: "queued",
  });
  const branchName = `quay/${taskId}`;
  const worktreePath = h.db
    .query<{ worktree_path: string }, [string]>(
      `SELECT worktree_path FROM tasks WHERE task_id = ?`,
    )
    .get(taskId)!.worktree_path;
  mkdirSync(worktreePath, { recursive: true });
  h.db
    .query(`UPDATE tasks SET pr_number = 176 WHERE task_id = ?`)
    .run(taskId);
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-05-17T19:00:00.000Z",
  });
  const pendingAttemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 2,
    reason: "review",
    consumedBudget: 0,
    spawnedAt: null,
  });
  insertFinalPromptArtifact(
    h.db,
    h.artifactRoot,
    h.clock,
    taskId,
    pendingAttemptId,
  );

  const built = buildTickDeps(h);
  built.git.setLocalBranches(repoId, [branchName]);
  built.git.setRemoteBranches(repoId, [branchName]);
  built.github.setPrSnapshotByNumber(repoId, 176, closedUnmergedSnapshot(176));

  const results = await tick_once(built.deps);

  expect(results).toEqual([
    { task_id: taskId, action: "pr_closed_unmerged" },
  ]);
  expect(built.tmux.spawnAttempts).toEqual([]);

  const task = h.db
    .query<{ state: string }, [string]>(
      `SELECT state FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task?.state).toBe("closed_unmerged");

  expect(existsSync(worktreePath)).toBe(false);
  expect(built.git.localBranches.get(repoId)?.has(branchName)).toBeFalsy();
  expect(built.git.remoteBranches.get(repoId)?.has(branchName)).toBeFalsy();

  const evt = h.db
    .query<
      { event_type: string; from_state: string; to_state: string },
      [string]
    >(
      `SELECT event_type, from_state, to_state FROM events
        WHERE task_id = ? AND event_type = 'closed'`,
    )
    .get(taskId);
  expect(evt).toEqual({
    event_type: "closed",
    from_state: "queued",
    to_state: "closed_unmerged",
  });
});

test("running task whose Quay-owned PR is closed unmerged kills worker and finalises", async () => {
  h = createHarness();
  h.clock.set("2026-05-17T20:11:00.000Z");

  const repoId = insertRepo(h.db, "repo-closed-unmerged-running");
  const taskId = insertTask(h.db, {
    taskId: "task-closed-unmerged-running",
    repoId,
    state: "running",
  });
  const branchName = `quay/${taskId}`;
  const worktreePath = h.db
    .query<{ worktree_path: string }, [string]>(
      `SELECT worktree_path FROM tasks WHERE task_id = ?`,
    )
    .get(taskId)!.worktree_path;
  mkdirSync(worktreePath, { recursive: true });
  h.db
    .query(`UPDATE tasks SET pr_number = 176 WHERE task_id = ?`)
    .run(taskId);
  const attemptNumber = 2;
  const sessionName = `quay-task-${taskId}-${attemptNumber}`;
  insertAttempt(h.db, {
    taskId,
    attemptNumber,
    reason: "review",
    consumedBudget: 0,
    spawnedAt: "2026-05-17T20:00:00.000Z",
  });
  h.db
    .query(`UPDATE attempts SET tmux_session = ? WHERE task_id = ?`)
    .run(sessionName, taskId);

  const built = buildTickDeps(h);
  built.tmux.liveSessions.add(sessionName);
  built.git.setLocalBranches(repoId, [branchName]);
  built.git.setRemoteBranches(repoId, [branchName]);
  built.github.setPrSnapshotByNumber(repoId, 176, closedUnmergedSnapshot(176));

  const results = await tick_once(built.deps);

  expect(results).toContainEqual({
    task_id: taskId,
    action: "pr_closed_unmerged",
  });
  expect(built.tmux.killCalls).toContain(sessionName);

  const task = h.db
    .query<{ state: string }, [string]>(
      `SELECT state FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task?.state).toBe("closed_unmerged");

  expect(existsSync(worktreePath)).toBe(false);
  expect(built.git.remoteBranches.get(repoId)?.has(branchName)).toBeFalsy();

  const evt = h.db
    .query<
      { from_state: string; to_state: string },
      [string]
    >(
      `SELECT from_state, to_state FROM events
        WHERE task_id = ? AND event_type = 'closed'`,
    )
    .get(taskId);
  expect(evt).toEqual({
    from_state: "running",
    to_state: "closed_unmerged",
  });
});

// Spawn-window state: tmux session was created via tmux.spawn but the
// post-spawn `UPDATE attempts SET tmux_session = ?` hasn't run yet, so the
// column is NULL. The orphan worker is reachable only via the canonical
// session name and must be killed before the cleanup matrix runs.
test("running task in spawn window kills canonical session when tmux_session is null", async () => {
  h = createHarness();
  h.clock.set("2026-05-17T20:11:30.000Z");

  const repoId = insertRepo(h.db, "repo-closed-unmerged-spawn-window");
  const taskId = insertTask(h.db, {
    taskId: "task-closed-unmerged-spawn-window",
    repoId,
    state: "running",
  });
  const branchName = `quay/${taskId}`;
  const worktreePath = h.db
    .query<{ worktree_path: string; tmux_id: string }, [string]>(
      `SELECT worktree_path, tmux_id FROM tasks WHERE task_id = ?`,
    )
    .get(taskId)!;
  mkdirSync(worktreePath.worktree_path, { recursive: true });
  h.db
    .query(`UPDATE tasks SET pr_number = 176 WHERE task_id = ?`)
    .run(taskId);
  const attemptNumber = 2;
  const canonicalSession = `quay-task-${worktreePath.tmux_id}-${attemptNumber}`;
  insertAttempt(h.db, {
    taskId,
    attemptNumber,
    reason: "review",
    consumedBudget: 0,
    spawnedAt: "2026-05-17T20:00:00.000Z",
  });

  const built = buildTickDeps(h);
  built.tmux.liveSessions.add(canonicalSession);
  built.git.setLocalBranches(repoId, [branchName]);
  built.git.setRemoteBranches(repoId, [branchName]);
  built.github.setPrSnapshotByNumber(repoId, 176, closedUnmergedSnapshot(176));

  const results = await tick_once(built.deps);

  expect(results).toContainEqual({
    task_id: taskId,
    action: "pr_closed_unmerged",
  });
  expect(built.tmux.killCalls).toContain(canonicalSession);

  const task = h.db
    .query<{ state: string }, [string]>(
      `SELECT state FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task?.state).toBe("closed_unmerged");
});

test("queued task with no pr_number is not affected by the closed-unmerged sweep", async () => {
  h = createHarness();
  h.clock.set("2026-05-17T20:12:00.000Z");

  const repoId = insertRepo(h.db, "repo-closed-unmerged-first-attempt");
  const taskId = insertTask(h.db, {
    taskId: "task-closed-unmerged-first-attempt",
    repoId,
  });
  const pendingAttemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
    spawnedAt: null,
  });
  insertFinalPromptArtifact(
    h.db,
    h.artifactRoot,
    h.clock,
    taskId,
    pendingAttemptId,
  );

  const built = buildTickDeps(h);
  built.git.setRemoteHeadSha(repoId, `quay/${taskId}`, "deadbeef");
  built.github.setPrExists(repoId, `quay/${taskId}`, false);
  built.github.setPrSnapshotByNumber(repoId, 999, closedUnmergedSnapshot(999));

  const results = await tick_once(built.deps);

  expect(results).toEqual([{ task_id: taskId, action: "spawned" }]);
  expect(built.tmux.spawnAttempts.length).toBe(1);

  const task = h.db
    .query<{ state: string }, [string]>(
      `SELECT state FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task?.state).toBe("running");
});

test("CHANGES_REQUESTED → queued task is finalised when PR is closed before next spawn", async () => {
  h = createHarness();
  h.clock.set("2026-05-17T20:13:00.000Z");

  const repoId = insertRepo(h.db, "repo-closed-after-changes-requested");
  const taskId = insertTask(h.db, {
    taskId: "task-closed-after-changes-requested",
    repoId,
    state: "queued",
  });
  const branchName = `quay/${taskId}`;
  const worktreePath = h.db
    .query<{ worktree_path: string }, [string]>(
      `SELECT worktree_path FROM tasks WHERE task_id = ?`,
    )
    .get(taskId)!.worktree_path;
  mkdirSync(worktreePath, { recursive: true });
  h.db
    .query(
      `UPDATE tasks
          SET pr_number = 176,
              last_review_id_acted_on = 'PRR_changes_requested_abc',
              non_budget_respawns_consumed = 1
        WHERE task_id = ?`,
    )
    .run(taskId);
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-05-17T19:00:00.000Z",
  });
  const pendingAttemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 2,
    reason: "review",
    consumedBudget: 0,
    spawnedAt: null,
  });
  insertFinalPromptArtifact(
    h.db,
    h.artifactRoot,
    h.clock,
    taskId,
    pendingAttemptId,
  );

  const built = buildTickDeps(h);
  built.git.setLocalBranches(repoId, [branchName]);
  built.git.setRemoteBranches(repoId, [branchName]);
  built.github.setPrSnapshotByNumber(repoId, 176, closedUnmergedSnapshot(176));
  built.github.setPrExists(repoId, branchName, false);

  const results = await tick_once(built.deps);

  expect(results).toEqual([
    { task_id: taskId, action: "pr_closed_unmerged" },
  ]);
  expect(built.tmux.spawnAttempts).toEqual([]);
  expect(built.git.remoteBranches.get(repoId)?.has(branchName)).toBeFalsy();

  const pending = h.db
    .query<
      { spawned_at: string | null; ended_at: string | null },
      [number]
    >(
      `SELECT spawned_at, ended_at FROM attempts WHERE attempt_id = ?`,
    )
    .get(pendingAttemptId);
  expect(pending?.spawned_at).toBeNull();
});

// A transient probe failure must NOT fall through to promoteAndSpawn — that
// would re-introduce the regression the sweep exists to prevent. The task is
// marked tick_error and excluded from this tick's spawn snapshot.
test("probe failure on a candidate excludes it from spawn this tick", async () => {
  h = createHarness();
  h.clock.set("2026-05-17T20:14:00.000Z");

  const repoId = insertRepo(h.db, "repo-closed-unmerged-probe-fail");
  const taskId = insertTask(h.db, {
    taskId: "task-closed-unmerged-probe-fail",
    repoId,
    state: "queued",
  });
  const branchName = `quay/${taskId}`;
  const worktreePath = h.db
    .query<{ worktree_path: string }, [string]>(
      `SELECT worktree_path FROM tasks WHERE task_id = ?`,
    )
    .get(taskId)!.worktree_path;
  mkdirSync(worktreePath, { recursive: true });
  h.db
    .query(`UPDATE tasks SET pr_number = 176 WHERE task_id = ?`)
    .run(taskId);
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-05-17T19:00:00.000Z",
  });
  const pendingAttemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 2,
    reason: "review",
    consumedBudget: 0,
    spawnedAt: null,
  });
  insertFinalPromptArtifact(
    h.db,
    h.artifactRoot,
    h.clock,
    taskId,
    pendingAttemptId,
  );

  const built = buildTickDeps(h);
  built.git.setLocalBranches(repoId, [branchName]);
  built.git.setRemoteBranches(repoId, [branchName]);
  built.git.setRemoteHeadSha(repoId, branchName, "deadbeef");
  built.github.setPrExists(repoId, branchName, true);
  built.github.prSnapshotByNumber = (_repoId: string, _prNumber: number) => {
    throw new Error("simulated GitHub 500 on prSnapshotByNumber");
  };

  const results = await tick_once(built.deps);

  expect(results).toContainEqual({
    task_id: taskId,
    action: "tick_error",
    error: expect.stringContaining("simulated GitHub 500") as unknown as string,
  });
  expect(built.tmux.spawnAttempts).toEqual([]);

  const task = h.db
    .query<{ state: string; tick_error: string | null }, [string]>(
      `SELECT state, tick_error FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task?.state).toBe("queued");
  expect(task?.tick_error).toContain("simulated GitHub 500");
});
