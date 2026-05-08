// Default `quay cancel` cleanup with a currently-open PR (spec §15 case 81,
// §5 cleanup matrix).
//
// Local branch + worktree are deleted; the remote branch is RETAINED so the
// human keeps the option to take over the work via the existing open PR.

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { cancel_task } from "../../src/core/cancel.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_081_cancel_with_open_pr_retains_remote_branch", async () => {
  h = createHarness();
  h.clock.set("2026-04-28T10:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-081");
  const taskId = "task-081";
  const branchName = `quay/${taskId}`;
  const tmuxId = `tmux-${taskId}`;
  const worktreePath = join(h.dataDir, "worktrees", taskId);
  mkdirSync(worktreePath, { recursive: true });

  // Task in pr-open with an open PR on GitHub.
  h.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, state, branch_name, tmux_id, worktree_path,
         attempts_consumed, retry_budget, created_at, updated_at
       ) VALUES (?, ?, 'pr-open', ?, ?, ?, 1, 5, ?, ?)`,
    )
    .run(
      taskId,
      repoId,
      branchName,
      tmuxId,
      worktreePath,
      "2026-04-28T08:00:00.000Z",
      "2026-04-28T09:00:00.000Z",
    );
  const attemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-04-28T08:30:00.000Z",
  });
  h.db
    .query(
      `UPDATE attempts SET ended_at = ?, exit_kind = 'pr_opened', tmux_session = NULL
        WHERE attempt_id = ?`,
    )
    .run("2026-04-28T08:45:00.000Z", attemptId);

  const built = buildTickDeps(h);
  built.git.setLocalBranches(repoId, [branchName]);
  built.git.setWorktreeBranch(repoId, worktreePath, branchName);
  built.git.setRemoteBranches(repoId, [branchName]);
  built.github.setPrIsOpen(repoId, branchName, true);

  const result = await cancel_task(built.deps, { taskId }); // default flags
  expect(result.ok).toBe(true);

  // Task terminal.
  const final = h.db
    .query<{ state: string }, [string]>(
      `SELECT state FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(final!.state).toBe("cancelled");

  // Local branch deleted.
  expect(built.git.localBranches.get(repoId)?.has(branchName) ?? false).toBe(
    false,
  );
  // Remote branch RETAINED — the open PR keeps the human's takeover option.
  expect(built.git.remoteBranches.get(repoId)?.has(branchName) ?? false).toBe(
    true,
  );
  // No deleteRemoteBranch / closePr ever called.
  const remoteDeleteCalls = built.git.calls.filter(
    (c) => c.op === "deleteRemoteBranch",
  );
  expect(remoteDeleteCalls).toHaveLength(0);
  expect(built.github.closePrCalls).toHaveLength(0);

  // Worktree removed.
  expect(built.git.worktrees.has(worktreePath)).toBe(false);
});

test("test_cancel_keep_worktree_detaches_before_branch_delete", async () => {
  h = createHarness();
  h.clock.set("2026-04-28T10:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-081-keep");
  const taskId = "task-081-keep";
  const branchName = `quay/${taskId}`;
  const tmuxId = `tmux-${taskId}`;
  const worktreePath = join(h.dataDir, "worktrees", taskId);
  mkdirSync(worktreePath, { recursive: true });

  h.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, state, branch_name, tmux_id, worktree_path,
         attempts_consumed, retry_budget, created_at, updated_at
       ) VALUES (?, ?, 'awaiting-next-brief', ?, ?, ?, 1, 5, ?, ?)`,
    )
    .run(
      taskId,
      repoId,
      branchName,
      tmuxId,
      worktreePath,
      "2026-04-28T08:00:00.000Z",
      "2026-04-28T09:00:00.000Z",
    );
  const attemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-04-28T08:30:00.000Z",
  });
  h.db
    .query(
      `UPDATE attempts SET ended_at = ?, exit_kind = 'blocker_written'
        WHERE attempt_id = ?`,
    )
    .run("2026-04-28T08:45:00.000Z", attemptId);

  const built = buildTickDeps(h);
  built.git.setLocalBranches(repoId, [branchName]);
  built.git.setWorktreeBranch(repoId, worktreePath, branchName);
  built.git.setRemoteBranches(repoId, [branchName]);
  built.github.setPrIsOpen(repoId, branchName, false);

  const result = await cancel_task(built.deps, { taskId, keepWorktree: true });
  expect(result.ok).toBe(true);

  const final = h.db
    .query<{ state: string }, [string]>(
      `SELECT state FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(final!.state).toBe("cancelled");

  expect(existsSync(worktreePath)).toBe(true);
  expect(built.git.worktrees.has(worktreePath)).toBe(true);
  expect(built.git.worktreeBranches.has(worktreePath)).toBe(false);
  expect(built.git.localBranches.get(repoId)?.has(branchName) ?? false).toBe(
    false,
  );
  expect(built.git.remoteBranches.get(repoId)?.has(branchName) ?? false).toBe(
    false,
  );

  const detachIndex = built.git.calls.findIndex((c) => c.op === "worktreeDetach");
  const branchDeleteIndex = built.git.calls.findIndex(
    (c) => c.op === "branchDelete",
  );
  expect(detachIndex).toBeGreaterThanOrEqual(0);
  expect(branchDeleteIndex).toBeGreaterThan(detachIndex);
});
