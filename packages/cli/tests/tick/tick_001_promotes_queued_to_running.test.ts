import { afterEach, expect, test } from "bun:test";
import { createTaskDependency } from "../../src/core/task_dependencies.ts";
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

test("test_001_tick_promotes_queued_to_running", async () => {
  h = createHarness();
  h.clock.set("2026-04-26T10:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-tick");
  const taskId = insertTask(h.db, { taskId: "task-promote", repoId });
  const attemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
  });
  insertFinalPromptArtifact(h.db, h.artifactRoot, h.clock, taskId, attemptId);

  const built = buildTickDeps(h);
  built.git.setRemoteHeadSha(repoId, `quay/${taskId}`, "deadbeef");
  built.github.setPrExists(repoId, `quay/${taskId}`, false);

  const results = await tick_once(built.deps);

  expect(results).toHaveLength(1);
  expect(results[0]).toEqual({ task_id: taskId, action: "spawned" });

  // tmux spawn happened with the canonical session name.
  expect(built.tmux.spawnCalls).toHaveLength(1);
  const expectedSession = `quay-task-quay-task-${taskId}-1`;
  expect(built.tmux.spawnCalls[0]!.sessionName).toBe(expectedSession);

  // git side-effects: tolerant fetch then read remote head before promotion.
  // (`fetchBranchIfExists` is the right call because the first attempt's
  // `quay/<slug>` ref may not exist on origin yet.)
  expect(built.git.countCalls("fetchBranchIfExists")).toBe(1);
  expect(built.git.countCalls("remoteHeadSha")).toBe(1);

  // Task row transitioned, budget consumed exactly once.
  const task = h.db
    .query<
      { state: string; attempts_consumed: number },
      [string]
    >("SELECT state, attempts_consumed FROM tasks WHERE task_id = ?")
    .get(taskId);
  expect(task!.state).toBe("running");
  expect(task!.attempts_consumed).toBe(1);

  // Attempt row: spawned_at, remote_sha_at_spawn, pr_existed_at_spawn,
  // tmux_session all set.
  const att = h.db
    .query<
      {
        spawned_at: string | null;
        remote_sha_at_spawn: string | null;
        pr_existed_at_spawn: number;
        tmux_session: string | null;
      },
      [number]
    >(
      `SELECT spawned_at, remote_sha_at_spawn, pr_existed_at_spawn, tmux_session
         FROM attempts WHERE attempt_id = ?`,
    )
    .get(attemptId);
  expect(att!.spawned_at).toBe("2026-04-26T10:00:00.000Z");
  expect(att!.remote_sha_at_spawn).toBe("deadbeef");
  expect(att!.pr_existed_at_spawn).toBe(0);
  expect(att!.tmux_session).toBe(expectedSession);

  // A `spawned` event row exists for the promotion.
  const ev = h.db
    .query<
      {
        event_type: string;
        from_state: string | null;
        to_state: string | null;
        attempt_id: number | null;
      },
      [string]
    >(
      `SELECT event_type, from_state, to_state, attempt_id
         FROM events WHERE task_id = ? ORDER BY event_id`,
    )
    .all(taskId);
  expect(ev).toHaveLength(1);
  expect(ev[0]).toEqual({
    event_type: "spawned",
    from_state: "queued",
    to_state: "running",
    attempt_id: attemptId,
  });
});

test("tick does not spawn tasks waiting on dependencies", async () => {
  h = createHarness();
  h.clock.set("2026-04-26T10:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-tick-waiting-deps");
  const taskId = insertTask(h.db, {
    taskId: "task-waiting-deps",
    repoId,
    state: "waiting_dependencies",
  });
  const attemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
  });
  insertFinalPromptArtifact(h.db, h.artifactRoot, h.clock, taskId, attemptId);

  const built = buildTickDeps(h);
  const results = await tick_once(built.deps);

  expect(results).toEqual([]);
  expect(built.tmux.spawnCalls).toHaveLength(0);
  const task = h.db
    .query<{ state: string; attempts_consumed: number }, [string]>(
      "SELECT state, attempts_consumed FROM tasks WHERE task_id = ?",
    )
    .get(taskId);
  expect(task).toEqual({
    state: "waiting_dependencies",
    attempts_consumed: 0,
  });
});

test("tick reconciles waiting dependencies from local merged task state before promotion", async () => {
  h = createHarness();
  h.clock.set("2026-04-26T10:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-tick-deps-release");
  const blockerTaskId = insertTask(h.db, {
    taskId: "task-blocker-merged",
    repoId,
    state: "merged",
  });
  const dependentTaskId = insertTask(h.db, {
    taskId: "task-dependent-waiting",
    repoId,
    state: "waiting_dependencies",
  });
  h.db
    .query(`UPDATE tasks SET external_ref = ? WHERE task_id = ?`)
    .run("BRIX-1508", dependentTaskId);
  createTaskDependency(h.db, {
    dependentTaskId,
    dependencyTaskId: blockerTaskId,
    dependencySource: "manual",
    dependencyExternalRef: "BRIX-1507",
    dependencyRepoId: repoId,
    requiredState: "merged",
    now: "2026-04-26T09:00:00.000Z",
  });
  const attemptId = insertAttempt(h.db, {
    taskId: dependentTaskId,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
  });
  insertFinalPromptArtifact(h.db, h.artifactRoot, h.clock, dependentTaskId, attemptId);

  const built = buildTickDeps(h);
  built.git.setRemoteHeadSha(repoId, `quay/${dependentTaskId}`, "feedface");
  built.github.setPrExists(repoId, `quay/${dependentTaskId}`, false);

  const results = await tick_once(built.deps);

  expect(results).toEqual([{ task_id: dependentTaskId, action: "spawned" }]);
  expect(built.tmux.spawnCalls).toHaveLength(1);
  expect(built.linear.setIssueStateCalls).toEqual([
    { identifier: "BRIX-1508", stateName: "Waiting" },
    { identifier: "BRIX-1508", stateName: "In Progress" },
  ]);
  const dep = h.db
    .query<{ satisfied_at: string | null }, [string]>(
      `SELECT satisfied_at FROM task_dependencies WHERE dependent_task_id = ?`,
    )
    .get(dependentTaskId);
  expect(dep?.satisfied_at).toBe("2026-04-26T10:00:00.000Z");
  const task = h.db
    .query<{ state: string; attempts_consumed: number }, [string]>(
      `SELECT state, attempts_consumed FROM tasks WHERE task_id = ?`,
    )
    .get(dependentTaskId);
  expect(task).toEqual({ state: "running", attempts_consumed: 1 });
  const event = h.db
    .query<{ event_type: string; from_state: string; to_state: string }, [string]>(
      `SELECT event_type, from_state, to_state
         FROM events
        WHERE task_id = ? AND event_type = 'dependencies_satisfied'`,
    )
    .get(dependentTaskId);
  expect(event).toEqual({
    event_type: "dependencies_satisfied",
    from_state: "waiting_dependencies",
    to_state: "queued",
  });
  expect(built.git.countCalls("worktreeRemove")).toBe(0);
  expect(built.git.countCalls("worktreeAddExistingBranch")).toBe(0);
});

test("tick refreshes dependency-released first-spawn worktree from latest base", async () => {
  h = createHarness();
  h.clock.set("2026-04-26T10:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-tick-deps-refresh");
  const blockerTaskId = insertTask(h.db, {
    taskId: "task-blocker-refresh-merged",
    repoId,
    state: "merged",
  });
  const dependentTaskId = insertTask(h.db, {
    taskId: "task-dependent-refresh-waiting",
    repoId,
    state: "waiting_dependencies",
  });
  createTaskDependency(h.db, {
    dependentTaskId,
    dependencyTaskId: blockerTaskId,
    dependencySource: "manual",
    dependencyExternalRef: "BRIX-1562",
    dependencyRepoId: repoId,
    requiredState: "merged",
    now: "2026-04-26T09:00:00.000Z",
  });
  const attemptId = insertAttempt(h.db, {
    taskId: dependentTaskId,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
  });
  insertFinalPromptArtifact(h.db, h.artifactRoot, h.clock, dependentTaskId, attemptId);

  const built = buildTickDeps(h);
  built.github.setPrExists(repoId, `quay/${dependentTaskId}`, false);

  const results = await tick_once(built.deps);

  expect(results).toEqual([{ task_id: dependentTaskId, action: "spawned" }]);
  expect(built.tmux.spawnCalls).toHaveLength(1);
  expect(built.git.calls).toContainEqual({
    op: "fetch",
    args: { repoId, ref: "main" },
  });
  expect(built.git.calls).toContainEqual({
    op: "worktreeRemove",
    args: { worktreePath: `/tmp/${dependentTaskId}` },
  });
  expect(built.git.calls).toContainEqual({
    op: "worktreeAddExistingBranch",
    args: {
      repoId,
      worktreePath: `/tmp/${dependentTaskId}`,
      branch: `quay/${dependentTaskId}`,
      baseRef: "origin/main",
    },
  });
  expect(built.commandRunner.calls).toEqual([
    {
      command: "bun install",
      cwd: `/tmp/${dependentTaskId}`,
    },
  ]);
  const refreshEvent = h.db
    .query<{ event_type: string; event_data: string | null }, [string]>(
      `SELECT event_type, event_data
         FROM events
        WHERE task_id = ? AND event_type = 'worktree_refreshed'`,
    )
    .get(dependentTaskId);
  expect(refreshEvent?.event_type).toBe("worktree_refreshed");
  expect(JSON.parse(refreshEvent!.event_data!)).toEqual({
    reason: "dependencies_satisfied",
    branch_name: `quay/${dependentTaskId}`,
    base_ref: "origin/main",
    worktree_path: `/tmp/${dependentTaskId}`,
  });
});

test("tick does not spawn dependency-released task when refreshed worktree install fails", async () => {
  h = createHarness();
  h.clock.set("2026-04-26T10:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-tick-deps-refresh-install-fails");
  const blockerTaskId = insertTask(h.db, {
    taskId: "task-blocker-refresh-install-fails",
    repoId,
    state: "merged",
  });
  const dependentTaskId = insertTask(h.db, {
    taskId: "task-dependent-refresh-install-fails",
    repoId,
    state: "waiting_dependencies",
  });
  createTaskDependency(h.db, {
    dependentTaskId,
    dependencyTaskId: blockerTaskId,
    dependencySource: "manual",
    dependencyExternalRef: "BRIX-1563",
    dependencyRepoId: repoId,
    requiredState: "merged",
    now: "2026-04-26T09:00:00.000Z",
  });
  const attemptId = insertAttempt(h.db, {
    taskId: dependentTaskId,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
  });
  insertFinalPromptArtifact(h.db, h.artifactRoot, h.clock, dependentTaskId, attemptId);

  const built = buildTickDeps(h);
  built.github.setPrExists(repoId, `quay/${dependentTaskId}`, false);
  built.commandRunner.failNext("install boom");

  const results = await tick_once(built.deps);

  expect(results).toEqual([
    {
      task_id: dependentTaskId,
      action: "spawn_substrate_failed",
      error: expect.stringContaining("install_cmd failed"),
    },
  ]);
  expect(built.tmux.spawnCalls).toHaveLength(0);
  expect(built.commandRunner.calls).toEqual([
    {
      command: "bun install",
      cwd: `/tmp/${dependentTaskId}`,
    },
  ]);
  const task = h.db
    .query<{ state: string; attempts_consumed: number }, [string]>(
      `SELECT state, attempts_consumed FROM tasks WHERE task_id = ?`,
    )
    .get(dependentTaskId);
  expect(task).toEqual({ state: "queued", attempts_consumed: 0 });
});

test("tick keeps dependent waiting and surfaces failed blockers through delivery outbox", async () => {
  h = createHarness();
  h.clock.set("2026-04-26T10:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-tick-deps-failed");
  const blockerTaskId = insertTask(h.db, {
    taskId: "task-blocker-cancelled",
    repoId,
    state: "cancelled",
  });
  const dependentTaskId = insertTask(h.db, {
    taskId: "task-dependent-still-waiting",
    repoId,
    state: "waiting_dependencies",
  });
  createTaskDependency(h.db, {
    dependentTaskId,
    dependencyTaskId: blockerTaskId,
    dependencySource: "manual",
    dependencyExternalRef: "BRIX-1506",
    dependencyRepoId: repoId,
    requiredState: "merged",
    now: "2026-04-26T09:00:00.000Z",
  });

  const built = buildTickDeps(h);
  const results = await tick_once(built.deps);

  expect(results).toEqual([]);
  expect(built.tmux.spawnCalls).toHaveLength(0);
  const task = h.db
    .query<{ state: string }, [string]>(
      `SELECT state FROM tasks WHERE task_id = ?`,
    )
    .get(dependentTaskId);
  expect(task?.state).toBe("waiting_dependencies");
  const outbox = h.db
    .query<
      { kind: string; handler_class: string; payload_json: string | null; route_hint_json: string | null },
      [string]
    >(
      `SELECT kind, handler_class, payload_json, route_hint_json
         FROM outbox_items
        WHERE task_id = ?`,
    )
    .get(dependentTaskId);
  expect(outbox?.kind).toBe("delivery.dependency_failed");
  expect(outbox?.handler_class).toBe("delivery");
  expect(JSON.parse(outbox!.payload_json!)).toMatchObject({
    dependency_task_id: blockerTaskId,
    blocker_state: "cancelled",
  });
  expect(JSON.parse(outbox!.route_hint_json!)).toEqual({ attention: "high" });
});
