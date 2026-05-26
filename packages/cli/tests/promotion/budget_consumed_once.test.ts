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

test("test_promotion_consumes_budget_once", async () => {
  h = createHarness();
  const repoId = insertRepo(h.db, "repo-budget");
  const taskId = insertTask(h.db, { taskId: "task-once", repoId });
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

  // First tick: promotion increments attempts_consumed by exactly one.
  const first = await tick_once(built.deps);
  expect(first.map((r) => r.action)).toEqual(["spawned"]);
  let consumed = h.db
    .query<{ n: number }, [string]>(
      `SELECT attempts_consumed AS n FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(consumed!.n).toBe(1);

  // Second tick: the same attempt cannot be promoted again — predicate
  // requires state = 'queued', and the task is now 'running'. Budget stays at 1.
  const second = await tick_once(built.deps);
  expect(second).toHaveLength(0); // no queued tasks left
  consumed = h.db
    .query<{ n: number }, [string]>(
      `SELECT attempts_consumed AS n FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(consumed!.n).toBe(1);

  // Exactly one tmux spawn across both ticks.
  expect(built.tmux.spawnCalls).toHaveLength(1);

  // Exactly one `spawned` event.
  const ev = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM events
        WHERE task_id = ? AND event_type = 'spawned'`,
    )
    .get(taskId);
  expect(ev!.n).toBe(1);
});
