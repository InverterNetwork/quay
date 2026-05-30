// §5 "pr-open polls PR state": a `pr-open` task whose PR was closed without
// merge transitions to `closed_unmerged`. Per §5 cleanup matrix, both local
// and remote branches are deleted (the human chose to discard the work).
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo, insertTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_054_pr_open_closed_transitions_closed_unmerged", async () => {
  h = createHarness();
  h.clock.set("2026-04-29T13:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-pr-closed");
  const taskId = insertTask(h.db, {
    taskId: "task-pr-closed",
    repoId,
    state: "pr-open",
  });
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-04-29T12:00:00.000Z",
  });

  const worktreePath = h.db
    .query<{ worktree_path: string }, [string]>(
      `SELECT worktree_path FROM tasks WHERE task_id = ?`,
    )
    .get(taskId)!.worktree_path;
  mkdirSync(worktreePath, { recursive: true });

  const built = buildTickDeps(h);
  built.git.setLocalBranches(repoId, [`quay/${taskId}`]);
  built.git.setRemoteBranches(repoId, [`quay/${taskId}`]);

  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    state: "closed_unmerged",
    headSha: "head-closed",
    baseSha: "base-closed",
    mergeable: "unknown",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "head-closed",
      items: [
        { name: "build", workflow: null, bucket: "pending", required: true },
      ],
    },
  });

  const results = await tick_once(built.deps);
  expect(results).toEqual([{ task_id: taskId, action: "pr_closed_unmerged" }]);

  const task = h.db
    .query<{ state: string }, [string]>(
      `SELECT state FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task?.state).toBe("closed_unmerged");

  // Worktree removed; both branches deleted (closed_unmerged matrix row).
  expect(existsSync(worktreePath)).toBe(false);
  expect(built.git.localBranches.get(repoId)?.has(`quay/${taskId}`)).toBeFalsy();
  expect(built.git.remoteBranches.get(repoId)?.has(`quay/${taskId}`)).toBeFalsy();

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
    from_state: "pr-open",
    to_state: "closed_unmerged",
  });
});

test("closed-unmerged final umbrella PR leaves workflow active", async () => {
  h = createHarness();
  h.clock.set("2026-04-29T13:30:00.000Z");

  const repoId = insertRepo(h.db, "repo-final-umbrella-pr-closed");
  const taskId = insertTask(h.db, {
    taskId: "umbrella-final-pr-closed",
    repoId,
    state: "pr-open",
  });
  h.db
    .query(
      `UPDATE tasks
          SET external_ref = 'BRIX-1538',
              branch_name = 'quay/umbrella/BRIX-1538',
              base_branch = 'dev',
              pr_number = 1539,
              pr_url = 'https://github.example/repo/pull/1539'
        WHERE task_id = ?`,
    )
    .run(taskId);
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-04-29T13:00:00.000Z",
  });
  const workflow = h.db
    .query<{ umbrella_workflow_id: number }, [string, string, string, string, string, number, string, string, string]>(
      `INSERT INTO umbrella_workflows (
         external_ref, repo_id, base_branch, feature_branch, final_pr_task_id,
         final_pr_number, final_pr_url, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING umbrella_workflow_id`,
    )
    .get(
      "BRIX-1538",
      repoId,
      "dev",
      "quay/umbrella/BRIX-1538",
      taskId,
      1539,
      "https://github.example/repo/pull/1539",
      "2026-04-29T13:00:00.000Z",
      "2026-04-29T13:00:00.000Z",
    );
  expect(workflow).not.toBeNull();

  const built = buildTickDeps(h);
  built.git.setLocalBranches(repoId, ["quay/umbrella/BRIX-1538"]);
  built.git.setRemoteBranches(repoId, ["quay/umbrella/BRIX-1538"]);
  built.github.setPrSnapshot(repoId, "quay/umbrella/BRIX-1538", {
    state: "closed_unmerged",
    headSha: "head-final-closed",
    baseSha: "base-final-closed",
    mergeable: "unknown",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: { checkSha: "head-final-closed", items: [] },
  });

  const results = await tick_once(built.deps);
  expect(results).toEqual([{ task_id: taskId, action: "pr_closed_unmerged" }]);
  expect(built.github.mergePullRequestCalls).toEqual([]);
  const workflowState = h.db
    .query<{ state: string; updated_at: string }, [number]>(
      `SELECT state, updated_at
         FROM umbrella_workflows
        WHERE umbrella_workflow_id = ?`,
    )
    .get(workflow!.umbrella_workflow_id);
  expect(workflowState).toEqual({
    state: "active",
    updated_at: "2026-04-29T13:00:00.000Z",
  });
});
