// A human closing a Quay-owned PR unmerged must cancel the task before the
// next tick can spawn another worker. The bug repro was a task that bounced
// from pr-review back to queued via CHANGES_REQUESTED: the queued state has
// no PR-state poll, so promoteAndSpawn would happily spawn the next worker,
// the worker would `gh pr create` against a branch whose PR was now closed,
// and Quay would open a replacement PR. These tests cover the queued and
// running paths of the closed-unmerged sweep.
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
  // Bug repro: the task bounced back from pr-review → queued via the
  // non-budget review respawn. pr_number stayed pinned to the original
  // (now closed) PR; a fresh pending attempt is waiting to be promoted.
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
  // Prior worker attempt that opened the now-closed PR.
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-05-17T19:00:00.000Z",
  });
  // Fresh pending attempt scheduled by the CHANGES_REQUESTED respawn.
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
  // No worker spawn was attempted — the sweep finalised the task before
  // promoteAndSpawn could run.
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
  // Worker pane was killed before terminal cleanup so it can't race a
  // replacement-PR `gh pr create`.
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
  // A stale snapshot at #999 must NOT cancel a task that never opened a PR.
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

// Bridge to the original repro path: PR was closed AFTER a CHANGES_REQUESTED
// review came back, with a pending non-budget review respawn already enqueued.
// Verifies that the sweep wins before promotion and that no replacement PR is
// attempted.
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
  // Belt-and-suspenders: even if something tried promoteAndSpawn's branch-
  // lookup, the branch has no PR. The sweep finalises via pr_number first.
  built.github.setPrExists(repoId, branchName, false);

  const results = await tick_once(built.deps);

  expect(results).toEqual([
    { task_id: taskId, action: "pr_closed_unmerged" },
  ]);
  expect(built.tmux.spawnAttempts).toEqual([]);
  // The cleanup matrix deleted the branch; a follow-up worker can no longer
  // push a fix commit and open a replacement PR even if one were spawned.
  expect(built.git.remoteBranches.get(repoId)?.has(branchName)).toBeFalsy();

  // Pending attempt row is orphan but harmless — the task is terminal.
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

