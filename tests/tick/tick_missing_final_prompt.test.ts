import { afterEach, expect, test } from "bun:test";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo, insertTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_tick_missing_final_prompt_logs_error_without_spawn", () => {
  h = createHarness();
  const repoId = insertRepo(h.db, "repo-missing-prompt");
  const taskId = insertTask(h.db, { taskId: "task-missing-prompt", repoId });
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
  });

  const built = buildTickDeps(h);

  const results = tick_once(built.deps);

  expect(results).toHaveLength(1);
  expect(results[0]!.task_id).toBe(taskId);
  expect(results[0]!.action).toBe("tick_error");
  expect(results[0]!.error).toContain("missing final_prompt");

  expect(built.git.calls).toHaveLength(0);
  expect(built.github.calls).toHaveLength(0);
  expect(built.tmux.spawnAttempts).toHaveLength(0);

  const task = h.db
    .query<
      { state: string; attempts_consumed: number; tick_error: string | null },
      [string]
    >(
      `SELECT state, attempts_consumed, tick_error
         FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toEqual({
    state: "queued",
    attempts_consumed: 0,
    tick_error: expect.stringContaining("missing final_prompt"),
  });
});
