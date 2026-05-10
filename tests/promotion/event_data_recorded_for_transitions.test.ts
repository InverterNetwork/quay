import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertRepo, insertRunningTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

interface EventRow {
  event_type: string;
  event_data: string | null;
}

function eventByType(taskId: string, eventType: string): EventRow {
  const row = h!.db
    .query<EventRow, [string, string]>(
      `SELECT event_type, event_data FROM events
         WHERE task_id = ? AND event_type = ?
         ORDER BY event_id DESC LIMIT 1`,
    )
    .get(taskId, eventType);
  expect(row, `no ${eventType} event for ${taskId}`).not.toBeNull();
  expect(row!.event_data, `${eventType} should have event_data populated`).not.toBeNull();
  return row!;
}

test("crashed event_data captures exit info and progress predicate state", async () => {
  h = createHarness();
  h.clock.set("2026-05-10T15:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-event-crashed");
  const t = insertRunningTask(h.db, {
    taskId: "task-event-crashed",
    repoId,
    worktreesRoot: join(h.dataDir, "worktrees"),
    remoteShaAtSpawn: null,
    prExistedAtSpawn: 0,
  });

  const built = buildTickDeps(h);
  built.tmux.markDead(t.sessionName!);
  built.tmux.setExitInfo(t.sessionName!, {
    exitCode: null,
    exitSignal: "SIGKILL",
  });
  built.git.setRemoteHeadSha(repoId, t.branchName, null);
  built.github.setPrExists(repoId, t.branchName, false);

  await tick_once(built.deps);

  const ev = eventByType(t.taskId, "crashed");
  const data = JSON.parse(ev.event_data!);
  expect(data).toEqual({
    exit_code: null,
    exit_signal: "SIGKILL",
    remote_unchanged: true,
    pr_existed_at_spawn: false,
    pr_exists_at_exit: false,
  });
});

test("no_progress event_data flags PR-existed-at-spawn with unchanged remote", async () => {
  h = createHarness();
  h.clock.set("2026-05-10T15:01:00.000Z");

  const repoId = insertRepo(h.db, "repo-event-noprog");
  const t = insertRunningTask(h.db, {
    taskId: "task-event-noprog",
    repoId,
    worktreesRoot: join(h.dataDir, "worktrees"),
    remoteShaAtSpawn: "abc1234",
    prExistedAtSpawn: 1,
  });

  const built = buildTickDeps(h);
  built.tmux.markDead(t.sessionName!);
  // Remote unchanged from spawn-time SHA + PR still exists → no_progress.
  built.git.setRemoteHeadSha(repoId, t.branchName, "abc1234");
  built.github.setPrExists(repoId, t.branchName, true);

  await tick_once(built.deps);

  const ev = eventByType(t.taskId, "no_progress");
  const data = JSON.parse(ev.event_data!);
  expect(data.remote_unchanged).toBe(true);
  expect(data.pr_existed_at_spawn).toBe(true);
  expect(data.pr_exists_at_exit).toBe(true);
});

test("blocker_ingested event_data captures blocker hash and bytes", async () => {
  h = createHarness();
  h.clock.set("2026-05-10T15:02:00.000Z");

  const repoId = insertRepo(h.db, "repo-event-blocker");
  const t = insertRunningTask(h.db, {
    taskId: "task-event-blocker",
    repoId,
    worktreesRoot: join(h.dataDir, "worktrees"),
    remoteShaAtSpawn: null,
    prExistedAtSpawn: 0,
  });

  const blockerContent = "Need decision: A vs B before continuing.\n";
  writeFileSync(join(t.worktreePath, ".quay-blocked.md"), blockerContent);

  const built = buildTickDeps(h);
  built.tmux.markDead(t.sessionName!);
  built.tmux.setExitInfo(t.sessionName!, { exitCode: 0, exitSignal: null });
  built.git.setRemoteHeadSha(repoId, t.branchName, null);
  built.github.setPrExists(repoId, t.branchName, false);

  await tick_once(built.deps);

  const ev = eventByType(t.taskId, "blocker_ingested");
  const data = JSON.parse(ev.event_data!);
  expect(data.exit_code).toBe(0);
  expect(data.exit_signal).toBeNull();
  expect(data.blocker_bytes).toBe(
    new TextEncoder().encode(blockerContent).byteLength,
  );
  // sha256 hex string is 64 chars; the helper computes from the bytes.
  expect(typeof data.blocker_content_hash).toBe("string");
  expect(data.blocker_content_hash.length).toBe(64);
});

test("wall_clock_exceeded event_data carries intent and spawn-age", async () => {
  h = createHarness();
  h.clock.set("2026-05-10T15:03:00.000Z");

  const repoId = insertRepo(h.db, "repo-event-wallclock");
  const t = insertRunningTask(h.db, {
    taskId: "task-event-wallclock",
    repoId,
    worktreesRoot: join(h.dataDir, "worktrees"),
    spawnedAt: "2026-05-10T13:03:00.000Z", // 2h ago
  });

  const built = buildTickDeps(h);
  built.tmux.liveSessions.add(t.sessionName!);
  built.tmux.setLogFreshness(t.sessionName!, "2026-05-10T15:02:30.000Z");

  await tick_once(built.deps);

  const ev = eventByType(t.taskId, "wall_clock_exceeded");
  const data = JSON.parse(ev.event_data!);
  expect(data.intent).toBe("wall_clock");
  expect(data.spawned_seconds_ago).toBe(7200);
  // wall_clock event doesn't include last_log_at — only stale_detected does.
  expect(data.last_log_at).toBeUndefined();
});

test("spawned event_data carries planned tmux session, worktree, and agent identity", async () => {
  // AST-103: every events row must carry non-empty event_data. The
  // queued→running transition records spawn-time intent so retro analysis
  // can correlate a spawned event with later transitions without joining.
  h = createHarness();
  h.clock.set("2026-05-10T15:10:00.000Z");

  const { insertAttempt, insertFinalPromptArtifact, insertTask } = await import(
    "../support/fixtures.ts"
  );
  const repoId = insertRepo(h.db, "repo-event-spawned");
  const taskId = insertTask(h.db, { taskId: "task-event-spawned", repoId });
  const attemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
  });
  insertFinalPromptArtifact(h.db, h.artifactRoot, h.clock, taskId, attemptId);

  const built = buildTickDeps(h);
  built.git.setRemoteHeadSha(repoId, `quay/${taskId}`, "spawn-time-sha");
  built.github.setPrExists(repoId, `quay/${taskId}`, false);

  await tick_once(built.deps, { agentInvocation: "bun --version" });

  const ev = eventByType(taskId, "spawned");
  const data = JSON.parse(ev.event_data!);
  expect(data.tmux_session).toBe(`quay-task-quay-task-${taskId}-1`);
  expect(typeof data.worktree_path).toBe("string");
  expect(data.worktree_path.length).toBeGreaterThan(0);
  expect(data.branch_name).toBe(`quay/${taskId}`);
  expect(data.attempt_number).toBe(1);
  // agent_identity follows the runtime/version/model triple shape.
  expect(typeof data.agent_identity).toBe("string");
  expect(data.agent_identity.split("/")).toHaveLength(3);
  expect(data.remote_sha_at_spawn).toBe("spawn-time-sha");
  expect(data.pr_existed_at_spawn).toBe(false);
});

test("pr_opened event_data carries head SHA, exit info, and predicate state", async () => {
  // AST-103: pr_opened was previously inserted without event_data. Pin the
  // populated payload so the per-attempt observability rollup is complete.
  h = createHarness();
  h.clock.set("2026-05-10T15:11:00.000Z");

  const repoId = insertRepo(h.db, "repo-event-propened");
  const t = insertRunningTask(h.db, {
    taskId: "task-event-propened",
    repoId,
    worktreesRoot: join(h.dataDir, "worktrees"),
    remoteShaAtSpawn: "spawn-sha-1",
    prExistedAtSpawn: 0,
  });

  const built = buildTickDeps(h);
  built.tmux.markDead(t.sessionName!);
  built.tmux.setExitInfo(t.sessionName!, { exitCode: 0, exitSignal: null });
  built.git.setRemoteHeadSha(repoId, t.branchName, "exit-sha-2");
  built.github.setPrExists(repoId, t.branchName, true);

  await tick_once(built.deps);

  const ev = eventByType(t.taskId, "pr_opened");
  const data = JSON.parse(ev.event_data!);
  expect(data.exit_code).toBe(0);
  expect(data.exit_signal).toBeNull();
  expect(data.head_sha).toBe("exit-sha-2");
  expect(data.remote_sha_at_spawn).toBe("spawn-sha-1");
  expect(data.pr_existed_at_spawn).toBe(false);
});

test("stale_detected event_data includes last_log_at alongside spawn-age", async () => {
  h = createHarness();
  h.clock.set("2026-05-10T15:20:00.000Z");

  const repoId = insertRepo(h.db, "repo-event-stale");
  const t = insertRunningTask(h.db, {
    taskId: "task-event-stale",
    repoId,
    worktreesRoot: join(h.dataDir, "worktrees"),
    spawnedAt: "2026-05-10T15:00:00.000Z", // 20 min ago, under wall-clock cap
  });

  const built = buildTickDeps(h);
  built.tmux.liveSessions.add(t.sessionName!);
  // Log mtime older than staleness threshold → stale_detected, not wall_clock.
  built.tmux.setLogFreshness(t.sessionName!, "2026-05-10T15:00:00.000Z");

  await tick_once(built.deps);

  const ev = eventByType(t.taskId, "stale_detected");
  const data = JSON.parse(ev.event_data!);
  expect(data.intent).toBe("stale");
  expect(data.spawned_seconds_ago).toBe(1200);
  expect(data.last_log_at).toBe("2026-05-10T15:00:00.000Z");
});
