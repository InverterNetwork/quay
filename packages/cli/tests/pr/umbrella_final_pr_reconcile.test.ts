import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import {
  insertAttempt,
  insertRepo,
  insertTask,
  seedTaskObjective,
} from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

function insertIntegratedUmbrellaWorkflow(repoId: string): {
  workflowId: number;
  taskId: string;
} {
  if (h === null) throw new Error("harness not initialized");
  const taskId = insertTask(h.db, {
    taskId: "task-integrated-subtask",
    repoId,
    state: "merged_to_feature_branch",
  });
  h.db
    .query(
      `UPDATE tasks
          SET external_ref = 'BRIX-1512',
              pr_url = 'https://github.example/repo/pull/12',
              worktree_path = ?
        WHERE task_id = ?`,
    )
    .run(`${h.dataDir}/worktrees/${taskId}`, taskId);
  seedTaskObjective(h, taskId, "# Subtask title\n\nImplement one slice.");
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-05-29T11:00:00.000Z",
  });
  const row = h.db
    .query<{ umbrella_workflow_id: number }, [string, string, string, string, string, string]>(
      `INSERT INTO umbrella_workflows (
         external_ref, repo_id, base_branch, feature_branch, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       RETURNING umbrella_workflow_id`,
    )
    .get(
      "BRIX-1511",
      repoId,
      "dev",
      "quay/umbrella/BRIX-1511",
      "2026-05-29T10:00:00.000Z",
      "2026-05-29T10:00:00.000Z",
    );
  if (!row) throw new Error("workflow insert failed");
  h.db
    .query(
      `INSERT INTO umbrella_expected_tasks (
         umbrella_workflow_id, external_ref, title, state,
         linear_issue_url, created_at, updated_at
       ) VALUES (?, ?, ?, 'linked', ?, ?, ?)`,
    )
    .run(
      row.umbrella_workflow_id,
      "BRIX-1512",
      "Subtask title",
      "https://linear.app/inverter/issue/BRIX-1512",
      "2026-05-29T10:05:00.000Z",
      "2026-05-29T10:05:00.000Z",
    );
  h.db
    .query(
      `INSERT INTO umbrella_tasks (
         umbrella_workflow_id, task_id, external_ref, created_at
       ) VALUES (?, ?, ?, ?)`,
    )
    .run(
      row.umbrella_workflow_id,
      taskId,
      "BRIX-1512",
      "2026-05-29T10:05:00.000Z",
    );
  return { workflowId: row.umbrella_workflow_id, taskId };
}

function insertUmbrellaWorkflowOnly(repoId: string): number {
  if (h === null) throw new Error("harness not initialized");
  const row = h.db
    .query<{ umbrella_workflow_id: number }, [string, string, string, string, string, string]>(
      `INSERT INTO umbrella_workflows (
         external_ref, repo_id, base_branch, feature_branch, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       RETURNING umbrella_workflow_id`,
    )
    .get(
      "BRIX-1511",
      repoId,
      "dev",
      "quay/umbrella/BRIX-1511",
      "2026-05-29T10:00:00.000Z",
      "2026-05-29T10:00:00.000Z",
    );
  if (!row) throw new Error("workflow insert failed");
  return row.umbrella_workflow_id;
}

function insertExpectedUmbrellaTask(
  workflowId: number,
  input: {
    externalRef: string;
    title?: string | null;
    state?: "expected" | "linked" | "complete_without_quay";
    completionSource?: "linear" | "manual" | null;
    completionReason?: string | null;
    completedAt?: string | null;
  },
): void {
  if (h === null) throw new Error("harness not initialized");
  const now = h.clock.nowISO();
  h.db
    .query(
      `INSERT INTO umbrella_expected_tasks (
         umbrella_workflow_id, external_ref, title, linear_issue_url, state,
         completion_source, completion_reason, completed_at, created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      workflowId,
      input.externalRef,
      input.title ?? null,
      `https://linear.app/inverter/issue/${input.externalRef}`,
      input.state ?? "expected",
      input.completionSource ?? null,
      input.completionReason ?? null,
      input.completedAt ?? null,
      now,
      now,
    );
}

function seedUmbrellaFeatureBranch(
  built: ReturnType<typeof buildTickDeps>,
  repoId: string,
  branch = "quay/umbrella/BRIX-1511",
): void {
  const existing = built.git.remoteBranches.get(repoId) ?? new Set<string>();
  built.git.setRemoteBranches(repoId, [...existing, branch]);
}

test("tick creates final umbrella PR and pr-open Quay-owned task", async () => {
  h = createHarness();
  h.clock.set("2026-05-29T12:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-umbrella-final");
  const { workflowId } = insertIntegratedUmbrellaWorkflow(repoId);
  const built = buildTickDeps(h);
  seedUmbrellaFeatureBranch(built, repoId);
  built.commandRunner.setHandler((command, cwd) => {
    expect(command).toBe("bun install");
    expect(cwd).toBe(`${h!.dataDir}/worktrees/umbrella-final-pr-${workflowId}`);
    expect(existsSync(cwd)).toBe(true);
    expect(built.git.worktreeBranches.get(cwd)).toEqual({
      repoId,
      branch: "quay/umbrella/BRIX-1511",
    });
    return { exitCode: 0, stdout: "", stderr: "" };
  });

  const results = await tick_once(built.deps);

  expect(results).toEqual([
    {
      task_id: `umbrella-final-pr-${workflowId}`,
      action: "umbrella_final_pr_reconciled",
    },
  ]);
  expect(built.github.createPullRequestCalls).toHaveLength(1);
  expect(built.github.createPullRequestCalls[0]).toMatchObject({
    repoId,
    headBranch: "quay/umbrella/BRIX-1511",
    baseBranch: "dev",
    title: "feat: reconcile umbrella workflow (BRIX-1511)",
  });
  expect(built.github.createPullRequestCalls[0]!.body).toContain(
    "<!-- quay:umbrella-final-pr:start -->",
  );
  expect(built.github.createPullRequestCalls[0]!.body).toContain(
    "- BRIX-1512 - Subtask title (task task-integrated-subtask; subtask PR: https://github.example/repo/pull/12)",
  );
  expect(built.git.calls).toContainEqual({
    op: "fetch",
    args: { repoId, ref: "quay/umbrella/BRIX-1511" },
  });
  expect(built.git.calls).toContainEqual({
    op: "worktreeAddExistingBranch",
    args: {
      repoId,
      worktreePath: `${h.dataDir}/worktrees/umbrella-final-pr-${workflowId}`,
      branch: "quay/umbrella/BRIX-1511",
      baseRef: "origin/quay/umbrella/BRIX-1511",
    },
  });
  expect(built.commandRunner.calls).toEqual([
    {
      command: "bun install",
      cwd: `${h.dataDir}/worktrees/umbrella-final-pr-${workflowId}`,
    },
  ]);

  const workflow = h.db
    .query<
      { final_pr_task_id: string | null; final_pr_number: number | null; final_pr_url: string | null },
      []
    >(`SELECT final_pr_task_id, final_pr_number, final_pr_url FROM umbrella_workflows`)
    .get();
  expect(workflow).toEqual({
    final_pr_task_id: `umbrella-final-pr-${workflowId}`,
    final_pr_number: 1001,
    final_pr_url: "https://github.example/repo-umbrella-final/pull/1001",
  });
  const task = h.db
    .query<
      { state: string; authoring_mode: string; branch_name: string; base_branch: string | null; external_ref: string | null },
      [string]
    >(
      `SELECT state, authoring_mode, branch_name, base_branch, external_ref
         FROM tasks WHERE task_id = ?`,
    )
    .get(`umbrella-final-pr-${workflowId}`);
  expect(task).toEqual({
    state: "pr-open",
    authoring_mode: "quay_owned",
    branch_name: "quay/umbrella/BRIX-1511",
    base_branch: "dev",
    external_ref: "BRIX-1511",
  });
  const finalLinkedAsSubtask = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM umbrella_tasks WHERE task_id = ?`,
    )
    .get(`umbrella-final-pr-${workflowId}`);
  expect(finalLinkedAsSubtask?.n).toBe(0);
  expect(built.github.mergePullRequestCalls).toEqual([]);
});

test("tick surfaces final umbrella PR dependency install failure before task creation", async () => {
  h = createHarness();
  h.clock.set("2026-05-29T12:01:00.000Z");
  const repoId = insertRepo(h.db, "repo-umbrella-final-install-fails");
  const { workflowId } = insertIntegratedUmbrellaWorkflow(repoId);
  const built = buildTickDeps(h);
  seedUmbrellaFeatureBranch(built, repoId);
  built.commandRunner.failNext("install boom");

  const results = await tick_once(built.deps);

  expect(results).toEqual([
    {
      task_id: `umbrella-final-pr-${workflowId}`,
      action: "tick_error",
      error: expect.stringContaining("install_cmd failed"),
    },
  ]);
  expect(built.github.createPullRequestCalls).toHaveLength(1);
  expect(built.commandRunner.calls).toEqual([
    {
      command: "bun install",
      cwd: `${h.dataDir}/worktrees/umbrella-final-pr-${workflowId}`,
    },
  ]);
  expect(built.git.worktrees.has(`${h.dataDir}/worktrees/umbrella-final-pr-${workflowId}`)).toBe(false);
  const finalTask = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM tasks WHERE task_id = ?`,
    )
    .get(`umbrella-final-pr-${workflowId}`);
  expect(finalTask?.n).toBe(0);
});

test("tick renders stored Linear umbrella metadata in final PR title and body", async () => {
  h = createHarness();
  h.clock.set("2026-05-29T12:03:00.000Z");
  const repoId = insertRepo(h.db, "repo-umbrella-final-linear-metadata");
  const { workflowId } = insertIntegratedUmbrellaWorkflow(repoId);
  h.db
    .query(
      `UPDATE umbrella_workflows
          SET linear_issue_title = ?,
              linear_issue_url = ?
        WHERE umbrella_workflow_id = ?`,
    )
    .run(
      "Ship the onboarding dashboard",
      "https://linear.app/inverter/issue/BRIX-1511/ship-the-onboarding-dashboard",
      workflowId,
    );
  const built = buildTickDeps(h);
  seedUmbrellaFeatureBranch(built, repoId);

  const results = await tick_once(built.deps);

  expect(results).toEqual([
    {
      task_id: `umbrella-final-pr-${workflowId}`,
      action: "umbrella_final_pr_reconciled",
    },
  ]);
  expect(built.github.createPullRequestCalls[0]).toMatchObject({
    title: "feat: Ship the onboarding dashboard (BRIX-1511)",
  });
  const body = built.github.createPullRequestCalls[0]!.body;
  expect(body).toContain("Umbrella title: Ship the onboarding dashboard");
  expect(body).toContain(
    "Linear ticket: [BRIX-1511](https://linear.app/inverter/issue/BRIX-1511/ship-the-onboarding-dashboard)",
  );
  expect(body).toContain("Source branch: quay/umbrella/BRIX-1511");
  expect(body).toContain("Target branch: dev");
});

test("tick fails final umbrella PR reconciliation when feature branch is missing", async () => {
  h = createHarness();
  h.clock.set("2026-05-29T12:05:00.000Z");
  const repoId = insertRepo(h.db, "repo-umbrella-final-missing-branch");
  const { workflowId } = insertIntegratedUmbrellaWorkflow(repoId);
  const built = buildTickDeps(h);

  const results = await tick_once(built.deps);

  expect(results).toEqual([
    {
      task_id: `umbrella-final-pr-${workflowId}`,
      action: "tick_error",
      error: expect.stringContaining("umbrella workflow BRIX-1511 feature branch quay/umbrella/BRIX-1511 is missing"),
    },
  ]);
  expect(built.github.createPullRequestCalls).toEqual([]);
  expect(built.git.countCalls("worktreeAddExistingBranch")).toBe(0);
  const finalTask = h.db
    .query<{ count: number }, [string]>(
      `SELECT COUNT(*) AS count FROM tasks WHERE task_id = ?`,
    )
    .get(`umbrella-final-pr-${workflowId}`);
  expect(finalTask?.count).toBe(0);
});

test("tick does not create final umbrella PR while an expected subtask is unaccounted for", async () => {
  h = createHarness();
  h.clock.set("2026-05-29T12:10:00.000Z");
  const repoId = insertRepo(h.db, "repo-umbrella-final-not-ready");
  const { workflowId } = insertIntegratedUmbrellaWorkflow(repoId);
  insertExpectedUmbrellaTask(workflowId, {
    externalRef: "BRIX-1513",
    title: "Still not enqueued",
  });
  const built = buildTickDeps(h);

  const results = await tick_once(built.deps);

  expect(results).toEqual([]);
  expect(built.github.createPullRequestCalls).toEqual([]);
  const workflow = h.db
    .query<
      { final_pr_task_id: string | null; final_pr_number: number | null; final_pr_url: string | null },
      []
    >(`SELECT final_pr_task_id, final_pr_number, final_pr_url FROM umbrella_workflows`)
    .get();
  expect(workflow).toEqual({
    final_pr_task_id: null,
    final_pr_number: null,
    final_pr_url: null,
  });
});

test("tick creates final umbrella PR when all expected subtasks completed without Quay", async () => {
  h = createHarness();
  h.clock.set("2026-05-29T12:20:00.000Z");
  const repoId = insertRepo(h.db, "repo-umbrella-final-complete-without-quay");
  const workflowId = insertUmbrellaWorkflowOnly(repoId);
  insertExpectedUmbrellaTask(workflowId, {
    externalRef: "BRIX-1512",
    title: "Already shipped",
    state: "complete_without_quay",
    completionSource: "linear",
    completionReason: "Linear issue was complete when umbrella was enqueued",
    completedAt: "2026-05-29T09:00:00.000Z",
  });
  insertExpectedUmbrellaTask(workflowId, {
    externalRef: "BRIX-1513",
    title: "Manually handled",
    state: "complete_without_quay",
    completionSource: "manual",
    completionReason: "Operator marked the child as already integrated",
    completedAt: "2026-05-29T09:05:00.000Z",
  });
  const built = buildTickDeps(h);
  seedUmbrellaFeatureBranch(built, repoId);

  const results = await tick_once(built.deps);

  expect(results).toEqual([
    {
      task_id: `umbrella-final-pr-${workflowId}`,
      action: "umbrella_final_pr_reconciled",
    },
  ]);
  expect(built.github.createPullRequestCalls).toHaveLength(1);
  const body = built.github.createPullRequestCalls[0]!.body;
  expect(body).toContain(
    "- BRIX-1512 - Already shipped (complete without Quay; source: linear; reason: Linear issue was complete when umbrella was enqueued)",
  );
  expect(body).toContain(
    "- BRIX-1513 - Manually handled (complete without Quay; source: manual; reason: Operator marked the child as already integrated)",
  );
  expect(built.github.mergePullRequestCalls).toEqual([]);
});

test("tick reuses existing final umbrella PR and replaces managed body section", async () => {
  h = createHarness();
  h.clock.set("2026-05-29T12:30:00.000Z");
  const repoId = insertRepo(h.db, "repo-umbrella-final-reuse");
  const { workflowId } = insertIntegratedUmbrellaWorkflow(repoId);
  h.db
    .query(
      `UPDATE umbrella_workflows
          SET linear_issue_title = ?,
              linear_issue_url = ?
        WHERE umbrella_workflow_id = ?`,
    )
    .run(
      "Ship the onboarding dashboard",
      "https://linear.app/inverter/issue/BRIX-1511/ship-the-onboarding-dashboard",
      workflowId,
    );
  const built = buildTickDeps(h);
  seedUmbrellaFeatureBranch(built, repoId);
  built.github.setOpenPrsForBranchBase(
    repoId,
    "quay/umbrella/BRIX-1511",
    "dev",
    [
      {
        number: 77,
        url: "https://github.example/repo/pull/77",
        headSha: "head-77",
        baseSha: "base-77",
        baseRef: "dev",
      },
    ],
  );
  built.github.setPrView(repoId, 77, {
    number: 77,
    title: "human title",
    body: [
      "Human intro.",
      "",
      "<!-- quay:umbrella-final-pr:start -->",
      "stale managed text",
      "<!-- quay:umbrella-final-pr:end -->",
      "",
      "Human footer.",
    ].join("\n"),
    url: "https://github.example/repo/pull/77",
    headRefName: "quay/umbrella/BRIX-1511",
    headSha: "head-77",
    baseRef: "dev",
    isCrossRepository: false,
  });

  const results = await tick_once(built.deps);

  expect(results).toEqual([
    {
      task_id: `umbrella-final-pr-${workflowId}`,
      action: "umbrella_final_pr_reconciled",
    },
  ]);
  expect(built.github.createPullRequestCalls).toEqual([]);
  expect(built.github.updatePullRequestBodyCalls).toHaveLength(1);
  const body = built.github.updatePullRequestBodyCalls[0]!.body;
  expect(body.startsWith("Human intro.")).toBe(true);
  expect(body).toContain("Umbrella external ref: BRIX-1511");
  expect(body).toContain("Umbrella title: Ship the onboarding dashboard");
  expect(body).toContain(
    "Linear ticket: [BRIX-1511](https://linear.app/inverter/issue/BRIX-1511/ship-the-onboarding-dashboard)",
  );
  expect(body).toContain("Human footer.");
  expect(body).not.toContain("stale managed text");
  expect(built.git.calls).toContainEqual({
    op: "worktreeAddExistingBranch",
    args: {
      repoId,
      worktreePath: `${h.dataDir}/worktrees/umbrella-final-pr-${workflowId}`,
      branch: "quay/umbrella/BRIX-1511",
      baseRef: "origin/quay/umbrella/BRIX-1511",
    },
  });
});

test("tick materializes missing worktree when recovering existing final umbrella task", async () => {
  h = createHarness();
  h.clock.set("2026-05-29T13:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-umbrella-final-partial");
  const { workflowId } = insertIntegratedUmbrellaWorkflow(repoId);
  const taskId = `umbrella-final-pr-${workflowId}`;
  insertTask(h.db, {
    taskId,
    repoId,
    state: "pr-open",
  });
  h.db
    .query(
      `UPDATE tasks
          SET external_ref = 'BRIX-1511',
              branch_name = 'quay/umbrella/BRIX-1511',
              base_branch = 'dev',
              worktree_path = ?
        WHERE task_id = ?`,
    )
    .run(`${h.dataDir}/worktrees/${taskId}`, taskId);
  h.db
    .query(
      `UPDATE umbrella_workflows
          SET final_pr_task_id = ?
        WHERE umbrella_workflow_id = ?`,
    )
    .run(taskId, workflowId);
  const built = buildTickDeps(h);
  seedUmbrellaFeatureBranch(built, repoId);
  built.github.setOpenPrsForBranchBase(
    repoId,
    "quay/umbrella/BRIX-1511",
    "dev",
    [
      {
        number: 88,
        url: "https://github.example/repo/pull/88",
        headSha: "head-88",
        baseSha: "base-88",
        baseRef: "dev",
      },
    ],
  );
  built.github.setPrCheckStatus(repoId, "quay/umbrella/BRIX-1511", {
    state: "pending",
  });

  const results = await tick_once(built.deps);

  expect(results).toEqual([
    {
      task_id: taskId,
      action: "umbrella_final_pr_reconciled",
    },
    {
      task_id: taskId,
      action: "ci_pending",
    },
  ]);
  expect(built.git.calls).toContainEqual({
    op: "worktreeAddExistingBranch",
    args: {
      repoId,
      worktreePath: `${h.dataDir}/worktrees/${taskId}`,
      branch: "quay/umbrella/BRIX-1511",
      baseRef: "origin/quay/umbrella/BRIX-1511",
    },
  });
  const task = h.db
    .query<{ pr_number: number | null; pr_url: string | null }, [string]>(
      `SELECT pr_number, pr_url FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toEqual({
    pr_number: 88,
    pr_url: "https://github.example/repo/pull/88",
  });
});

test("tick materializes existing umbrella external-ref task before recording it as final PR task", async () => {
  h = createHarness();
  h.clock.set("2026-05-29T13:30:00.000Z");
  const repoId = insertRepo(h.db, "repo-umbrella-final-unrelated-task");
  const unrelatedTaskId = insertTask(h.db, {
    taskId: "existing-umbrella-ticket-task",
    repoId,
    state: "queued",
  });
  h.db
    .query(
      `UPDATE tasks
          SET external_ref = 'BRIX-1511',
              branch_name = 'quay/existing-umbrella-ticket-task',
              worktree_path = ?
        WHERE task_id = ?`,
    )
    .run(`${h.dataDir}/worktrees/${unrelatedTaskId}`, unrelatedTaskId);
  const { workflowId } = insertIntegratedUmbrellaWorkflow(repoId);
  const built = buildTickDeps(h);
  seedUmbrellaFeatureBranch(built, repoId);
  built.git.setWorktreeBranch(
    repoId,
    `${h.dataDir}/worktrees/${unrelatedTaskId}`,
    "quay/existing-umbrella-ticket-task",
  );

  const results = await tick_once(built.deps);

  expect(results).toEqual([
    {
      task_id: unrelatedTaskId,
      action: "umbrella_final_pr_reconciled",
    },
    {
      task_id: unrelatedTaskId,
      action: "skipped_no_pending_attempt",
    },
  ]);
  const workflow = h.db
    .query<{ final_pr_task_id: string | null }, []>(
      `SELECT final_pr_task_id FROM umbrella_workflows`,
    )
    .get();
  expect(workflow).toEqual({ final_pr_task_id: unrelatedTaskId });
  const task = h.db
    .query<
      {
        state: string;
        authoring_mode: string;
        branch_name: string;
        base_branch: string | null;
        pr_number: number | null;
        pr_url: string | null;
      },
      [string]
    >(
      `SELECT state, authoring_mode, branch_name, base_branch, pr_number, pr_url
         FROM tasks
        WHERE task_id = ?`,
    )
    .get(unrelatedTaskId);
  expect(task).toEqual({
    state: "pr-open",
    authoring_mode: "quay_owned",
    branch_name: "quay/umbrella/BRIX-1511",
    base_branch: "dev",
    pr_number: 1001,
    pr_url: "https://github.example/repo-umbrella-final-unrelated-task/pull/1001",
  });
  expect(built.git.calls).toContainEqual({
    op: "worktreeCurrentBranch",
    args: { worktreePath: `${h.dataDir}/worktrees/${unrelatedTaskId}` },
  });
  expect(built.git.calls).toContainEqual({
    op: "worktreeRemove",
    args: { worktreePath: `${h.dataDir}/worktrees/${unrelatedTaskId}` },
  });
  expect(built.git.calls).toContainEqual({
    op: "worktreeAddExistingBranch",
    args: {
      repoId,
      worktreePath: `${h.dataDir}/worktrees/${unrelatedTaskId}`,
      branch: "quay/umbrella/BRIX-1511",
      baseRef: "origin/quay/umbrella/BRIX-1511",
    },
  });
  expect(built.git.worktreeBranches.get(`${h.dataDir}/worktrees/${unrelatedTaskId}`)).toEqual({
    repoId,
    branch: "quay/umbrella/BRIX-1511",
  });
  const attempt = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n
         FROM attempts
        WHERE task_id = ?
          AND reason = 'umbrella_final_pr'`,
    )
    .get(unrelatedTaskId);
  expect(attempt?.n).toBe(1);
  const artifacts = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n
         FROM artifacts
        WHERE task_id = ?
          AND kind IN ('task_objective', 'brief', 'final_prompt')`,
    )
    .get(unrelatedTaskId);
  expect(artifacts?.n).toBe(3);
});
