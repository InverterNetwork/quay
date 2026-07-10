import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { tick_once } from "../../src/core/tick.ts";
import { createIdentityMappingService } from "../../src/core/identity_mappings.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import {
  insertAttempt,
  insertRepo,
  insertRunningTask,
  insertTask,
} from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("pr-open poll assigns mapped primary contributor", async () => {
  h = createHarness();
  h.clock.set("2026-07-06T12:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-assignee-map");
  const taskId = insertTask(h.db, {
    repoId,
    taskId: "task-assignee-map",
    state: "pr-open",
  });
  insertAttempt(h.db, { taskId, spawnedAt: "2026-07-06T11:00:00.000Z" });
  h.db
    .query(
      `UPDATE tasks
          SET authors_json = ?,
              branch_name = ?
        WHERE task_id = ?`,
    )
    .run(
      JSON.stringify([
        { name: "Mira Tonio", slack_id: "U02MIRA9K" },
      ]),
      "quay/task-assignee-map",
      taskId,
    );
  createIdentityMappingService({ db: h.db, clock: h.clock }).replaceAll([
    {
      slack_user_id: "U02MIRA9K",
      slack_display_name: "Mira Tonio",
      github_login: "mira-tonio",
      status: "mapped",
    },
  ]);

  const built = buildTickDeps(h);
  built.github.setPrSnapshot(repoId, "quay/task-assignee-map", {
    state: "open",
    prNumber: 71,
    prUrl: "https://github.example/repo-assignee-map/pull/71",
    prTitle: "Add feature",
    headSha: "head-71",
    baseSha: "base-71",
    baseRef: "main",
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "head-71",
      items: [
        {
          name: "build",
          workflow: "ci",
          bucket: "pending",
          required: true,
        },
      ],
    },
  });

  const results = await tick_once(built.deps);

  expect(results).toEqual([{ task_id: taskId, action: "ci_pending" }]);
  expect(built.github.addPullRequestAssigneesCalls).toEqual([
    { repoId, prNumber: 71, logins: ["mira-tonio"] },
  ]);
  expect(
    h.db
      .query<{
        pr_assignee_login: string | null;
        pr_assignee_selected_at: string | null;
      }, [string]>(
        `SELECT pr_assignee_login, pr_assignee_selected_at
           FROM tasks
          WHERE task_id = ?`,
      )
      .get(taskId),
  ).toEqual({
    pr_assignee_login: "mira-tonio",
    pr_assignee_selected_at: "2026-07-06T12:00:00.000Z",
  });
  expect(
    h.db
      .query<{
        status: string;
        last_used_task_id: string | null;
        last_used_pr_number: number | null;
      }, []>(
        `SELECT status, last_used_task_id, last_used_pr_number
           FROM identity_mappings
          WHERE slack_user_id = 'U02MIRA9K'`,
      )
      .get(),
  ).toEqual({
    status: "verified",
    last_used_task_id: taskId,
    last_used_pr_number: 71,
  });
});

test("running task assigns mapped primary contributor when PR opens", async () => {
  h = createHarness();
  h.clock.set("2026-07-06T12:30:00.000Z");
  const repoId = insertRepo(h.db, "repo-assignee-open");
  const t = insertRunningTask(h.db, {
    repoId,
    taskId: "task-assignee-open",
    branchName: "quay/task-assignee-open",
    worktreesRoot: join(h.dataDir, "worktrees"),
    remoteShaAtSpawn: "old-head",
    prExistedAtSpawn: 0,
  });
  h.db
    .query(`UPDATE tasks SET authors_json = ? WHERE task_id = ?`)
    .run(
      JSON.stringify([
        { name: "Mira Tonio", slack_id: "U02MIRA9K" },
      ]),
      t.taskId,
    );
  createIdentityMappingService({ db: h.db, clock: h.clock }).replaceAll([
    {
      slack_user_id: "U02MIRA9K",
      slack_display_name: "Mira Tonio",
      github_login: "mira-tonio",
      status: "mapped",
    },
  ]);

  const built = buildTickDeps(h);
  built.tmux.markDead(t.sessionName!);
  built.git.setRemoteHeadSha(repoId, t.branchName, "new-head");
  built.github.setPrExists(repoId, t.branchName, true);
  built.github.setPrSnapshot(repoId, t.branchName, {
    state: "open",
    prNumber: 72,
    prUrl: "https://github.example/repo-assignee-open/pull/72",
    prTitle: "Add another feature",
    headSha: "new-head",
    baseSha: "base-72",
    baseRef: "main",
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: { checkSha: null, items: [] },
  });

  const results = await tick_once(built.deps);

  expect(results).toEqual([{ task_id: t.taskId, action: "pr_opened" }]);
  expect(built.github.addPullRequestAssigneesCalls).toEqual([
    { repoId, prNumber: 72, logins: ["mira-tonio"] },
  ]);
});

test("pr assignee transient failure stays retryable", async () => {
  h = createHarness();
  h.clock.set("2026-07-06T13:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-assignee-retry");
  const taskId = insertTask(h.db, {
    repoId,
    taskId: "task-assignee-retry",
    state: "pr-open",
  });
  insertAttempt(h.db, { taskId, spawnedAt: "2026-07-06T12:45:00.000Z" });
  h.db
    .query(
      `UPDATE tasks
          SET authors_json = ?,
              branch_name = ?
        WHERE task_id = ?`,
    )
    .run(
      JSON.stringify([
        { name: "Mira Tonio", slack_id: "U02MIRA9K" },
      ]),
      "quay/task-assignee-retry",
      taskId,
    );
  createIdentityMappingService({ db: h.db, clock: h.clock }).replaceAll([
    {
      slack_user_id: "U02MIRA9K",
      slack_display_name: "Mira Tonio",
      github_login: "mira-tonio",
      status: "mapped",
    },
  ]);

  const built = buildTickDeps(h);
  built.github.setPrSnapshot(repoId, "quay/task-assignee-retry", {
    state: "open",
    prNumber: 75,
    prUrl: "https://github.example/repo-assignee-retry/pull/75",
    prTitle: "Retry assignee",
    headSha: "head-75",
    baseSha: "base-75",
    baseRef: "main",
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "head-75",
      items: [
        {
          name: "build",
          workflow: "ci",
          bucket: "pending",
          required: true,
        },
      ],
    },
  });
  built.github.setAddPullRequestAssigneesHandler(() => {
    throw new Error(
      "gh pr edit 75 --add-assignee mira-tonio failed: HTTP 502 Bad Gateway",
    );
  });

  const first = await tick_once(built.deps);

  expect(first).toEqual([{ task_id: taskId, action: "ci_pending" }]);
  expect(built.github.addPullRequestAssigneesCalls).toEqual([
    { repoId, prNumber: 75, logins: ["mira-tonio"] },
  ]);
  expect(
    h.db
      .query<{ status: string; last_error: string | null }, []>(
        `SELECT status, last_error
           FROM identity_mappings
          WHERE slack_user_id = 'U02MIRA9K'`,
      )
      .get(),
  ).toEqual({
    status: "mapped",
    last_error: "gh pr edit 75 --add-assignee mira-tonio failed: HTTP 502 Bad Gateway",
  });
  expect(
    JSON.parse(
      h.db
        .query<{ event_data: string }, []>(
          `SELECT event_data
             FROM events
            WHERE event_type = 'pr_assignee_selection_failed'
            ORDER BY occurred_at DESC
            LIMIT 1`,
        )
        .get()!.event_data,
    ),
  ).toMatchObject({
    pr_number: 75,
    slack_user_id: "U02MIRA9K",
    github_login: "mira-tonio",
    retryable: true,
  });

  built.github.setAddPullRequestAssigneesHandler(null);
  h.clock.set("2026-07-06T13:01:00.000Z");
  const second = await tick_once(built.deps);

  expect(second).toEqual([{ task_id: taskId, action: "ci_pending" }]);
  expect(built.github.addPullRequestAssigneesCalls).toEqual([
    { repoId, prNumber: 75, logins: ["mira-tonio"] },
    { repoId, prNumber: 75, logins: ["mira-tonio"] },
  ]);
  expect(
    h.db
      .query<{
        status: string;
        last_error: string | null;
        last_used_task_id: string | null;
        last_used_pr_number: number | null;
      }, []>(
        `SELECT status, last_error, last_used_task_id, last_used_pr_number
           FROM identity_mappings
          WHERE slack_user_id = 'U02MIRA9K'`,
      )
      .get(),
  ).toEqual({
    status: "verified",
    last_error: null,
    last_used_task_id: taskId,
    last_used_pr_number: 75,
  });
  expect(
    h.db
      .query<{ pr_assignee_login: string | null }, [string]>(
        `SELECT pr_assignee_login
           FROM tasks
          WHERE task_id = ?`,
      )
      .get(taskId),
  ).toEqual({ pr_assignee_login: "mira-tonio" });
});

test("pr assignee deterministic identity failure marks mapping conflict", async () => {
  h = createHarness();
  h.clock.set("2026-07-06T13:30:00.000Z");
  const repoId = insertRepo(h.db, "repo-assignee-conflict-error");
  const taskId = insertTask(h.db, {
    repoId,
    taskId: "task-assignee-conflict-error",
    state: "pr-open",
  });
  insertAttempt(h.db, { taskId, spawnedAt: "2026-07-06T13:15:00.000Z" });
  h.db
    .query(
      `UPDATE tasks
          SET authors_json = ?,
              branch_name = ?
        WHERE task_id = ?`,
    )
    .run(
      JSON.stringify([
        { name: "Missing User", slack_id: "U02MISSING" },
      ]),
      "quay/task-assignee-conflict-error",
      taskId,
    );
  createIdentityMappingService({ db: h.db, clock: h.clock }).replaceAll([
    {
      slack_user_id: "U02MISSING",
      slack_display_name: "Missing User",
      github_login: "missing-user",
      status: "mapped",
    },
  ]);

  const built = buildTickDeps(h);
  built.github.setPrSnapshot(repoId, "quay/task-assignee-conflict-error", {
    state: "open",
    prNumber: 76,
    prUrl: "https://github.example/repo-assignee-conflict-error/pull/76",
    prTitle: "Bad assignee",
    headSha: "head-76",
    baseSha: "base-76",
    baseRef: "main",
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "head-76",
      items: [
        {
          name: "build",
          workflow: "ci",
          bucket: "pending",
          required: true,
        },
      ],
    },
  });
  built.github.setAddPullRequestAssigneesHandler(() => {
    throw new Error(
      "gh pr edit 76 --add-assignee missing-user failed: could not resolve to a User",
    );
  });

  const results = await tick_once(built.deps);

  expect(results).toEqual([{ task_id: taskId, action: "ci_pending" }]);
  expect(
    h.db
      .query<{ status: string; last_error: string | null }, []>(
        `SELECT status, last_error
           FROM identity_mappings
          WHERE slack_user_id = 'U02MISSING'`,
      )
      .get(),
  ).toEqual({
    status: "conflict",
    last_error: "gh pr edit 76 --add-assignee missing-user failed: could not resolve to a User",
  });
  expect(
    JSON.parse(
      h.db
        .query<{ event_data: string }, []>(
          `SELECT event_data
             FROM events
            WHERE event_type = 'pr_assignee_selection_failed'
            ORDER BY occurred_at DESC
            LIMIT 1`,
        )
        .get()!.event_data,
    ),
  ).toMatchObject({
    pr_number: 76,
    slack_user_id: "U02MISSING",
    github_login: "missing-user",
    retryable: false,
  });
});

test("pr-open poll skips unmapped and conflicted contributors", async () => {
  h = createHarness();
  const repoId = insertRepo(h.db, "repo-assignee-skip");
  const unmappedTaskId = insertTask(h.db, {
    repoId,
    taskId: "task-assignee-unmapped",
    state: "pr-open",
  });
  const conflictTaskId = insertTask(h.db, {
    repoId,
    taskId: "task-assignee-conflict",
    state: "pr-open",
  });
  insertAttempt(h.db, { taskId: unmappedTaskId, spawnedAt: "2026-07-06T11:00:00.000Z" });
  insertAttempt(h.db, { taskId: conflictTaskId, spawnedAt: "2026-07-06T11:05:00.000Z" });
  h.db
    .query(
      `UPDATE tasks
          SET authors_json = ?,
              branch_name = ?
        WHERE task_id = ?`,
    )
    .run(
      JSON.stringify([{ name: "No Map", slack_id: "U02NOMAP" }]),
      "quay/task-assignee-unmapped",
      unmappedTaskId,
    );
  h.db
    .query(
      `UPDATE tasks
          SET authors_json = ?,
              branch_name = ?
        WHERE task_id = ?`,
    )
    .run(
      JSON.stringify([{ name: "Broken Map", slack_id: "U02BROKEN" }]),
      "quay/task-assignee-conflict",
      conflictTaskId,
    );
  createIdentityMappingService({ db: h.db, clock: h.clock }).replaceAll([
    {
      slack_user_id: "U02BROKEN",
      slack_display_name: "Broken Map",
      github_login: "broken-map",
      status: "conflict",
    },
  ]);

  const built = buildTickDeps(h);
  built.github.setPrSnapshot(repoId, "quay/task-assignee-unmapped", {
    state: "open",
    prNumber: 73,
    prUrl: "https://github.example/repo-assignee-skip/pull/73",
    prTitle: "Unmapped",
    headSha: "head-73",
    baseSha: "base-73",
    baseRef: "main",
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: { checkSha: "head-73", items: [] },
  });
  built.github.setPrSnapshot(repoId, "quay/task-assignee-conflict", {
    state: "open",
    prNumber: 74,
    prUrl: "https://github.example/repo-assignee-skip/pull/74",
    prTitle: "Conflict",
    headSha: "head-74",
    baseSha: "base-74",
    baseRef: "main",
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: { checkSha: "head-74", items: [] },
  });

  const results = await tick_once(built.deps);

  expect(results).toHaveLength(2);
  expect(results).toContainEqual({ task_id: unmappedTaskId, action: "ci_passed" });
  expect(results).toContainEqual({ task_id: conflictTaskId, action: "ci_passed" });
  expect(built.github.addPullRequestAssigneesCalls).toEqual([]);
});
