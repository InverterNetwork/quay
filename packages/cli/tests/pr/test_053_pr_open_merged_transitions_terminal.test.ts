// §5 "pr-open polls PR state": a `pr-open` task whose PR was merged on
// GitHub (typically by a human) transitions to `merged` and runs terminal
// cleanup, even if CI was still pending. CI status is irrelevant once the
// PR is merged — the human's merge decision overrides CI.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, existsSync } from "node:fs";
import { tick_once } from "../../src/core/tick.ts";
import { createTaskDependency } from "../../src/core/task_dependencies.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo, insertTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_053_pr_open_merged_transitions_terminal", async () => {
  h = createHarness();
  h.clock.set("2026-04-29T12:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-pr-merged");
  const taskId = insertTask(h.db, {
    taskId: "task-pr-merged",
    repoId,
    state: "pr-open",
  });
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-04-29T11:00:00.000Z",
  });
  const dependentTaskId = insertTask(h.db, {
    taskId: "task-waiting-on-pr-merged",
    repoId,
    state: "waiting_dependencies",
  });
  createTaskDependency(h.db, {
    dependentTaskId,
    dependencyTaskId: taskId,
    dependencySource: "linear",
    dependencyExternalRef: "ENG-2100",
    dependencyRepoId: repoId,
    requiredState: "merged",
    now: "2026-04-29T11:30:00.000Z",
  });

  // Place a real worktree on disk so cleanup observably removes it.
  const worktreePath = h.db
    .query<{ worktree_path: string }, [string]>(
      `SELECT worktree_path FROM tasks WHERE task_id = ?`,
    )
    .get(taskId)!.worktree_path;
  mkdirSync(worktreePath, { recursive: true });

  const built = buildTickDeps(h);
  // Seed a local branch so we can assert it gets cleaned up.
  built.git.setLocalBranches(repoId, [`quay/${taskId}`]);

  // Snapshot says PR is merged. CI is still pending — must be ignored.
  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    state: "merged",
    headSha: "head-merge",
    baseSha: "base-merge",
    mergeable: "unknown",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "head-merge",
      items: [
        { name: "build", workflow: null, bucket: "pending", required: true },
      ],
    },
  });

  const results = await tick_once(built.deps);
  expect(results).toEqual([{ task_id: taskId, action: "pr_merged" }]);

  const task = h.db
    .query<{ state: string }, [string]>(
      `SELECT state FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task?.state).toBe("merged");
  const dependent = h.db
    .query<{ state: string }, [string]>(
      `SELECT state FROM tasks WHERE task_id = ?`,
    )
    .get(dependentTaskId);
  expect(dependent?.state).toBe("queued");
  const dep = h.db
    .query<{ satisfied_at: string | null }, [string]>(
      `SELECT satisfied_at FROM task_dependencies WHERE dependent_task_id = ?`,
    )
    .get(dependentTaskId);
  expect(dep?.satisfied_at).toBe("2026-04-29T12:00:00.000Z");

  // Worktree removed; local branch deleted; remote branch left to GitHub.
  expect(existsSync(worktreePath)).toBe(false);
  expect(built.git.localBranches.get(repoId)?.has(`quay/${taskId}`)).toBeFalsy();

  // Event recorded.
  const evt = h.db
    .query<
      { event_type: string; from_state: string; to_state: string },
      [string]
    >(
      `SELECT event_type, from_state, to_state FROM events
        WHERE task_id = ? AND event_type = 'merged'`,
    )
    .get(taskId);
  expect(evt).toEqual({
    event_type: "merged",
    from_state: "pr-open",
    to_state: "merged",
  });
  const dependencyEvt = h.db
    .query<
      { event_type: string; from_state: string; to_state: string },
      [string]
    >(
      `SELECT event_type, from_state, to_state FROM events
        WHERE task_id = ? AND event_type = 'dependencies_satisfied'`,
    )
    .get(dependentTaskId);
  expect(dependencyEvt).toEqual({
    event_type: "dependencies_satisfied",
    from_state: "waiting_dependencies",
    to_state: "queued",
  });
});

test("umbrella pr merge marks blocker merged to feature branch and releases dependents", async () => {
  h = createHarness();
  h.clock.set("2026-04-29T12:30:00.000Z");

  const repoId = insertRepo(h.db, "repo-umbrella-pr-merged");
  const blockerTaskId = insertTask(h.db, {
    taskId: "task-umbrella-blocker",
    repoId,
    state: "pr-open",
  });
  insertAttempt(h.db, {
    taskId: blockerTaskId,
    attemptNumber: 1,
    spawnedAt: "2026-04-29T12:00:00.000Z",
  });
  const dependentTaskId = insertTask(h.db, {
    taskId: "task-umbrella-dependent",
    repoId,
    state: "waiting_dependencies",
  });

  const workflow = h.db
    .query<{ umbrella_workflow_id: number }, [string, string, string, string, string, string]>(
      `INSERT INTO umbrella_workflows (
         external_ref, repo_id, base_branch, feature_branch, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       RETURNING umbrella_workflow_id`,
    )
    .get(
      "BRIX-1509",
      repoId,
      "dev",
      "feature/brix-1509",
      "2026-04-29T11:59:00.000Z",
      "2026-04-29T11:59:00.000Z",
    );
  expect(workflow).not.toBeNull();
  h.db
    .query(
      `INSERT INTO umbrella_tasks (
         umbrella_workflow_id, task_id, external_ref, created_at
       ) VALUES (?, ?, ?, ?)`,
    )
    .run(
      workflow!.umbrella_workflow_id,
      blockerTaskId,
      "BRIX-1510",
      "2026-04-29T12:00:00.000Z",
    );
  h.db
    .query(
      `INSERT INTO umbrella_tasks (
         umbrella_workflow_id, task_id, external_ref, created_at
       ) VALUES (?, ?, ?, ?)`,
    )
    .run(
      workflow!.umbrella_workflow_id,
      dependentTaskId,
      "BRIX-1511",
      "2026-04-29T12:00:00.000Z",
    );
  createTaskDependency(h.db, {
    dependentTaskId,
    dependencyTaskId: blockerTaskId,
    dependencySource: "quay",
    dependencyExternalRef: "BRIX-1510",
    dependencyRepoId: repoId,
    scope: "umbrella",
    requiredState: "merged_to_feature_branch",
    now: "2026-04-29T12:01:00.000Z",
  });

  const worktreePath = h.db
    .query<{ worktree_path: string }, [string]>(
      `SELECT worktree_path FROM tasks WHERE task_id = ?`,
    )
    .get(blockerTaskId)!.worktree_path;
  mkdirSync(worktreePath, { recursive: true });

  const built = buildTickDeps(h);
  built.git.setLocalBranches(repoId, [`quay/${blockerTaskId}`]);
  built.github.setPrSnapshot(repoId, `quay/${blockerTaskId}`, {
    state: "merged",
    headSha: "head-umbrella-merge",
    baseSha: "base-umbrella-merge",
    mergeable: "unknown",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "head-umbrella-merge",
      items: [],
    },
  });

  const results = await tick_once(built.deps);
  expect(results).toEqual([{ task_id: blockerTaskId, action: "pr_merged" }]);

  const blocker = h.db
    .query<{ state: string }, [string]>(
      `SELECT state FROM tasks WHERE task_id = ?`,
    )
    .get(blockerTaskId);
  expect(blocker?.state).toBe("merged_to_feature_branch");
  const dependent = h.db
    .query<{ state: string }, [string]>(
      `SELECT state FROM tasks WHERE task_id = ?`,
    )
    .get(dependentTaskId);
  expect(dependent?.state).toBe("queued");
  const dep = h.db
    .query<{ satisfied_at: string | null; required_state: string }, [string]>(
      `SELECT satisfied_at, required_state
         FROM task_dependencies
        WHERE dependent_task_id = ?`,
    )
    .get(dependentTaskId);
  expect(dep).toEqual({
    satisfied_at: "2026-04-29T12:30:00.000Z",
    required_state: "merged_to_feature_branch",
  });

  expect(existsSync(worktreePath)).toBe(false);
  const event = h.db
    .query<
      { event_type: string; from_state: string; to_state: string },
      [string]
    >(
      `SELECT event_type, from_state, to_state FROM events
        WHERE task_id = ? AND event_type = 'merged'`,
    )
    .get(blockerTaskId);
  expect(event).toEqual({
    event_type: "merged",
    from_state: "pr-open",
    to_state: "merged_to_feature_branch",
  });
});
