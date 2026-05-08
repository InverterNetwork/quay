import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertRepo, insertRunningTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_022_wall_clock_kill_schedules_retry", async () => {
  h = createHarness();
  h.clock.set("2026-04-28T02:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-wall-clock");
  const t = insertRunningTask(h.db, {
    taskId: "task-wall-clock",
    repoId,
    worktreesRoot: join(h.dataDir, "worktrees"),
    spawnedAt: "2026-04-28T00:00:00.000Z",
  });

  const built = buildTickDeps(h);
  built.tmux.liveSessions.add(t.sessionName!);
  built.tmux.setLogFreshness(t.sessionName!, "2026-04-28T01:59:00.000Z");

  expect(await tick_once(built.deps)).toEqual([
    { task_id: t.taskId, action: "kill_intent_set" },
  ]);
  const intent = h.db
    .query<{ kill_intent: string | null }, [number]>(
      `SELECT kill_intent FROM attempts WHERE attempt_id = ?`,
    )
    .get(t.attemptId);
  expect(intent!.kill_intent).toBe("wall_clock");
  expect(built.tmux.killCalls).toEqual([t.sessionName!]);

  expect(await tick_once(built.deps)).toEqual([
    { task_id: t.taskId, action: "wall_clock_killed" },
  ]);
  const pending = h.db
    .query<{ reason: string; consumed_budget: number }, [string]>(
      `SELECT reason, consumed_budget FROM attempts
       WHERE task_id = ? AND spawned_at IS NULL`,
    )
    .get(t.taskId);
  expect(pending).toEqual({ reason: "wall_clock", consumed_budget: 1 });
  const ended = h.db
    .query<{ exit_kind: string | null; kill_intent: string | null }, [number]>(
      `SELECT exit_kind, kill_intent FROM attempts WHERE attempt_id = ?`,
    )
    .get(t.attemptId);
  expect(ended).toEqual({ exit_kind: "killed_wall_clock", kill_intent: null });
});

test("test_stale_kill_schedules_retry_once", async () => {
  h = createHarness();
  h.clock.set("2026-04-28T00:20:00.000Z");
  const repoId = insertRepo(h.db, "repo-stale");
  const t = insertRunningTask(h.db, {
    taskId: "task-stale",
    repoId,
    worktreesRoot: join(h.dataDir, "worktrees"),
    spawnedAt: "2026-04-28T00:00:00.000Z",
  });

  const built = buildTickDeps(h);
  built.tmux.liveSessions.add(t.sessionName!);
  built.tmux.setLogFreshness(t.sessionName!, "2026-04-28T00:00:00.000Z");

  await tick_once(built.deps);
  await tick_once(built.deps);

  const pending = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM attempts
       WHERE task_id = ? AND spawned_at IS NULL AND reason = 'stale'`,
    )
    .get(t.taskId);
  expect(pending!.n).toBe(1);
});
