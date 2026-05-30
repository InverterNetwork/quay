// §5 "pr-open polls PR state": a `pr-open` task whose PR was merged on
// GitHub (typically by a human) transitions to `merged` and runs terminal
// cleanup, even if CI was still pending. CI status is irrelevant once the
// PR is merged — the human's merge decision overrides CI.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, existsSync } from "node:fs";
import { getTask } from "../../src/cli/format.ts";
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
      `INSERT INTO umbrella_expected_tasks (
         umbrella_workflow_id, external_ref, title, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      workflow!.umbrella_workflow_id,
      "BRIX-1510",
      "Blocker",
      "2026-04-29T12:00:00.000Z",
      "2026-04-29T12:00:00.000Z",
    );
  h.db
    .query(
      `INSERT INTO umbrella_expected_tasks (
         umbrella_workflow_id, external_ref, title, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      workflow!.umbrella_workflow_id,
      "BRIX-1511",
      "Dependent",
      "2026-04-29T12:00:00.000Z",
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
    umbrellaWorkflowId: workflow!.umbrella_workflow_id,
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

test("merged final umbrella PR marks workflow completed", async () => {
  h = createHarness();
  h.clock.set("2026-04-29T12:45:00.000Z");

  const repoId = insertRepo(h.db, "repo-final-umbrella-pr-merged");
  const finalTaskId = insertTask(h.db, {
    taskId: "umbrella-final-pr-1538",
    repoId,
    state: "pr-open",
  });
  const subtaskId = insertTask(h.db, {
    taskId: "task-final-umbrella-subtask",
    repoId,
    state: "merged_to_feature_branch",
  });
  h.db
    .query(
      `UPDATE tasks
          SET external_ref = 'BRIX-1538',
              branch_name = 'quay/umbrella/BRIX-1538',
              base_branch = 'dev',
              pr_number = 1538,
              pr_url = 'https://github.example/repo/pull/1538'
        WHERE task_id = ?`,
    )
    .run(finalTaskId);
  insertAttempt(h.db, {
    taskId: finalTaskId,
    attemptNumber: 1,
    spawnedAt: "2026-04-29T12:30:00.000Z",
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
      finalTaskId,
      1538,
      "https://github.example/repo/pull/1538",
      "2026-04-29T12:00:00.000Z",
      "2026-04-29T12:00:00.000Z",
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
      subtaskId,
      "BRIX-1539",
      "2026-04-29T12:05:00.000Z",
    );

  const worktreePath = h.db
    .query<{ worktree_path: string }, [string]>(
      `SELECT worktree_path FROM tasks WHERE task_id = ?`,
    )
    .get(finalTaskId)!.worktree_path;
  mkdirSync(worktreePath, { recursive: true });

  const built = buildTickDeps(h);
  built.git.setLocalBranches(repoId, ["quay/umbrella/BRIX-1538"]);
  built.github.setPrSnapshot(repoId, "quay/umbrella/BRIX-1538", {
    prNumber: 1538,
    state: "merged",
    headSha: "head-final-merge",
    baseSha: "base-final-merge",
    mergeable: "unknown",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: { checkSha: "head-final-merge", items: [] },
  });

  const results = await tick_once(built.deps);
  expect(results).toEqual([{ task_id: finalTaskId, action: "pr_merged" }]);
  expect(built.github.mergePullRequestCalls).toEqual([]);

  const workflowState = h.db
    .query<{ state: string; updated_at: string }, [number]>(
      `SELECT state, updated_at
         FROM umbrella_workflows
        WHERE umbrella_workflow_id = ?`,
    )
    .get(workflow!.umbrella_workflow_id);
  expect(workflowState).toEqual({
    state: "completed",
    updated_at: "2026-04-29T12:45:00.000Z",
  });
  expect(getTask(h.db, finalTaskId)?.umbrella_status).toMatchObject({
    role: "final_pr",
    state: "completed",
    final_pr_task_id: finalTaskId,
    final_pr_number: 1538,
  });
  expect(getTask(h.db, subtaskId)?.umbrella_status).toMatchObject({
    role: "subtask",
    state: "completed",
    final_pr_task_id: finalTaskId,
  });
});

test("approved green umbrella subtask auto-merges into feature branch", async () => {
  h = createHarness();
  h.clock.set("2026-04-29T13:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-umbrella-auto-merge");
  const taskId = insertTask(h.db, {
    taskId: "task-umbrella-auto-merge",
    repoId,
    state: "done",
  });
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-04-29T12:30:00.000Z",
  });

  const workflow = h.db
    .query<{ umbrella_workflow_id: number }, [string, string, string, string, string, string]>(
      `INSERT INTO umbrella_workflows (
         external_ref, repo_id, base_branch, feature_branch, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       RETURNING umbrella_workflow_id`,
    )
    .get(
      "BRIX-1510",
      repoId,
      "dev",
      "feature/brix-1510",
      "2026-04-29T12:20:00.000Z",
      "2026-04-29T12:20:00.000Z",
    );
  h.db
    .query(
      `INSERT INTO umbrella_tasks (
         umbrella_workflow_id, task_id, external_ref, created_at
       ) VALUES (?, ?, ?, ?)`,
    )
    .run(workflow!.umbrella_workflow_id, taskId, "BRIX-1511", "2026-04-29T12:25:00.000Z");

  const worktreePath = h.db
    .query<{ worktree_path: string }, [string]>(
      `SELECT worktree_path FROM tasks WHERE task_id = ?`,
    )
    .get(taskId)!.worktree_path;
  mkdirSync(worktreePath, { recursive: true });

  const built = buildTickDeps(h);
  built.git.setLocalBranches(repoId, [`quay/${taskId}`]);
  const snapshot = {
    prNumber: 1510,
    state: "open" as const,
    headSha: "head-auto-merge",
    baseSha: "base-auto-merge",
    baseRef: "feature/brix-1510",
    mergeable: "mergeable" as const,
    latestReview: {
      decision: "APPROVED" as const,
      latestReviewId: "R_auto_approved",
      submittedHeadSha: "head-auto-merge",
      comments: "",
    },
    checks: {
      checkSha: "head-auto-merge",
      items: [{ name: "build", workflow: null, bucket: "pass" as const, required: true }],
    },
  };
  built.github.setPrSnapshot(repoId, `quay/${taskId}`, snapshot);
  built.github.setPrSnapshotByNumber(repoId, 1510, snapshot);
  built.github.setPrView(repoId, 1510, {
    number: 1510,
    title: "fix: umbrella subtask",
    body: "",
    url: "https://github.example/pr/1510",
    headRefName: `quay/${taskId}`,
    headSha: "head-auto-merge",
    baseRef: "feature/brix-1510",
  });

  const results = await tick_once(built.deps);
  expect(results).toEqual([{ task_id: taskId, action: "pr_merged" }]);
  expect(built.github.mergePullRequestCalls).toEqual([
    { repoId, prNumber: 1510, expectedHeadSha: "head-auto-merge" },
  ]);

  const task = h.db
    .query<{ state: string; tick_error: string | null }, [string]>(
      `SELECT state, tick_error FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toEqual({ state: "merged_to_feature_branch", tick_error: null });
  expect(existsSync(worktreePath)).toBe(false);
});

test("normal done task is not auto-merged even when approved and green", async () => {
  h = createHarness();
  h.clock.set("2026-04-29T13:30:00.000Z");

  const repoId = insertRepo(h.db, "repo-normal-no-auto-merge");
  const taskId = insertTask(h.db, {
    taskId: "task-normal-no-auto-merge",
    repoId,
    state: "done",
  });
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-04-29T13:00:00.000Z",
  });

  const built = buildTickDeps(h);
  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    prNumber: 1512,
    state: "open",
    headSha: "head-normal",
    baseSha: "base-normal",
    baseRef: "dev",
    mergeable: "mergeable",
    latestReview: {
      decision: "APPROVED",
      latestReviewId: "R_normal_approved",
      submittedHeadSha: "head-normal",
      comments: "",
    },
    checks: {
      checkSha: "head-normal",
      items: [{ name: "build", workflow: null, bucket: "pass", required: true }],
    },
  });

  const results = await tick_once(built.deps);
  expect(results).toEqual([]);
  expect(built.github.mergePullRequestCalls).toEqual([]);
  const task = h.db
    .query<{ state: string }, [string]>(`SELECT state FROM tasks WHERE task_id = ?`)
    .get(taskId);
  expect(task?.state).toBe("done");
});

test("umbrella subtask auto-merge guard blocks wrong PR base", async () => {
  h = createHarness();
  h.clock.set("2026-04-29T14:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-umbrella-auto-merge-guard");
  const taskId = insertTask(h.db, {
    taskId: "task-umbrella-auto-merge-guard",
    repoId,
    state: "done",
  });
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-04-29T13:30:00.000Z",
  });
  const workflow = h.db
    .query<{ umbrella_workflow_id: number }, [string, string, string, string, string, string]>(
      `INSERT INTO umbrella_workflows (
         external_ref, repo_id, base_branch, feature_branch, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       RETURNING umbrella_workflow_id`,
    )
    .get(
      "BRIX-1510",
      repoId,
      "dev",
      "feature/brix-1510",
      "2026-04-29T13:20:00.000Z",
      "2026-04-29T13:20:00.000Z",
    );
  h.db
    .query(
      `INSERT INTO umbrella_tasks (
         umbrella_workflow_id, task_id, external_ref, created_at
       ) VALUES (?, ?, ?, ?)`,
    )
    .run(workflow!.umbrella_workflow_id, taskId, "BRIX-1511", "2026-04-29T13:25:00.000Z");

  const built = buildTickDeps(h);
  const snapshot = {
    prNumber: 1513,
    state: "open" as const,
    headSha: "head-wrong-base",
    baseSha: "base-wrong-base",
    baseRef: "dev",
    mergeable: "mergeable" as const,
    latestReview: {
      decision: "APPROVED" as const,
      latestReviewId: "R_wrong_base",
      submittedHeadSha: "head-wrong-base",
      comments: "",
    },
    checks: {
      checkSha: "head-wrong-base",
      items: [{ name: "build", workflow: null, bucket: "pass" as const, required: true }],
    },
  };
  built.github.setPrSnapshot(repoId, `quay/${taskId}`, snapshot);
  built.github.setPrSnapshotByNumber(repoId, 1513, snapshot);
  built.github.setPrView(repoId, 1513, {
    number: 1513,
    title: "fix: wrong base",
    body: "",
    url: null,
    headRefName: `quay/${taskId}`,
    headSha: "head-wrong-base",
    baseRef: "dev",
  });

  const results = await tick_once(built.deps);
  expect(results).toEqual([{ task_id: taskId, action: "tick_error", error: expect.any(String) }]);
  expect(built.github.mergePullRequestCalls).toEqual([]);
  const task = h.db
    .query<{ state: string; tick_error: string | null }, [string]>(
      `SELECT state, tick_error FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task?.state).toBe("done");
  expect(task?.tick_error).toContain("umbrella auto-merge guard failed");
  expect(task?.tick_error).toContain("does not exactly match umbrella feature branch");
});
