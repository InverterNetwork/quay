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

test("wall-clock finalizer stamps exit_signal captured between kill and dead-observation", async () => {
  h = createHarness();
  h.clock.set("2026-05-10T12:30:00.000Z");
  const repoId = insertRepo(h.db, "repo-exit-wallclock");
  const t = insertRunningTask(h.db, {
    taskId: "task-exit-wallclock",
    repoId,
    worktreesRoot: join(h.dataDir, "worktrees"),
    spawnedAt: "2026-05-10T10:30:00.000Z",
  });

  const built = buildTickDeps(h);
  built.tmux.liveSessions.add(t.sessionName!);
  built.tmux.setLogFreshness(t.sessionName!, "2026-05-10T12:29:00.000Z");

  // Tick 1: worker is alive past max_attempt_duration; kill_intent set,
  // tmux.kill issued. FakeTmux.kill removes the live entry, so the next
  // tick observes the worker as dead.
  await tick_once(built.deps);

  // Simulate the substrate reporting that our kill arrived as SIGTERM.
  built.tmux.setExitInfo(t.sessionName!, {
    exitCode: null,
    exitSignal: "SIGTERM",
  });

  // Tick 2: dead-worker path captures exit info before running the
  // wall-clock finalizer; the finalizer's UPDATE writes both columns.
  expect(await tick_once(built.deps)).toEqual([
    { task_id: t.taskId, action: "wall_clock_killed" },
  ]);

  const ended = h.db
    .query<
      {
        exit_kind: string | null;
        exit_code: number | null;
        exit_signal: string | null;
      },
      [number]
    >(
      `SELECT exit_kind, exit_code, exit_signal
         FROM attempts WHERE attempt_id = ?`,
    )
    .get(t.attemptId);
  expect(ended).toEqual({
    exit_kind: "killed_wall_clock",
    exit_code: null,
    exit_signal: "SIGTERM",
  });
});
