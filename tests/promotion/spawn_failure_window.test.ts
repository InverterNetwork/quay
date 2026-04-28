import { afterEach, expect, test } from "bun:test";
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

test("test_spawn_failure_window_leaves_running_with_null_session_for_recovery", () => {
  h = createHarness();
  h.clock.set("2026-04-26T11:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-spawn-fail");
  const taskId = insertTask(h.db, { taskId: "task-spawn-fail", repoId });
  const attemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
  });
  insertFinalPromptArtifact(h.db, h.artifactRoot, h.clock, taskId, attemptId);

  const built = buildTickDeps(h);
  built.git.setRemoteHeadSha(repoId, `quay/${taskId}`, null);
  built.github.setPrExists(repoId, `quay/${taskId}`, false);

  // The substrate spawn fails — simulating a tmux create error or process
  // death between the SQL promotion commit and the tmux session record.
  built.tmux.failSpawnNext();

  const results = tick_once(built.deps);
  expect(results).toHaveLength(1);
  expect(results[0]!.task_id).toBe(taskId);
  expect(results[0]!.action).toBe("spawn_substrate_failed");

  // SQL promotion did commit: state = running, budget consumed, spawned_at set.
  const task = h.db
    .query<
      { state: string; attempts_consumed: number },
      [string]
    >(`SELECT state, attempts_consumed FROM tasks WHERE task_id = ?`)
    .get(taskId);
  expect(task!.state).toBe("running");
  expect(task!.attempts_consumed).toBe(1);

  // The spawn-failure window: spawned_at NOT NULL, tmux_session IS NULL —
  // exactly what Slice 4 recovery needs to detect the partial spawn.
  const att = h.db
    .query<
      { spawned_at: string | null; tmux_session: string | null },
      [number]
    >(
      `SELECT spawned_at, tmux_session FROM attempts WHERE attempt_id = ?`,
    )
    .get(attemptId);
  expect(att!.spawned_at).not.toBeNull();
  expect(att!.tmux_session).toBeNull();

  // tmux.spawn was attempted exactly once (and threw); no successful spawn.
  expect(built.tmux.spawnAttempts).toHaveLength(1);
  expect(built.tmux.spawnCalls).toHaveLength(0);

  // The `spawned` event was written as part of the promotion transaction —
  // an external observer can see the SQL chokepoint fired even though
  // substrate work failed afterward.
  const ev = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM events
        WHERE task_id = ? AND event_type = 'spawned'`,
    )
    .get(taskId);
  expect(ev!.n).toBe(1);

  // A second tick runs slice-5 recovery: the no-evidence spawn-window default
  // marks spawn_failed, rolls back budget, and schedules a clean retry. It
  // still must not promote a duplicate in the same tick.
  const again = tick_once(built.deps);
  expect(again).toEqual([{ task_id: taskId, action: "spawn_failed" }]);
  expect(built.tmux.spawnCalls).toHaveLength(0);
  const recovered = h.db
    .query<{ state: string; attempts_consumed: number }, [string]>(
      `SELECT state, attempts_consumed FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(recovered).toEqual({ state: "queued", attempts_consumed: 0 });
});
