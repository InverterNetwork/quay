import { afterEach, expect, test } from "bun:test";
import { claim_task } from "../../src/core/claims.ts";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo, insertTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_020_claim_expiration_cap_parks_orchestrator_loop", () => {
  h = createHarness();
  h.clock.set("2026-04-28T10:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-loop");
  const taskId = insertTask(h.db, {
    taskId: "task-loop",
    repoId,
    state: "awaiting-next-brief",
  });
  insertAttempt(h.db, { taskId, attemptNumber: 1, spawnedAt: "2026-04-28T08:00:00.000Z" });

  // Default max_claim_expirations = 3. Three claim/expire cycles park the task.
  const built = buildTickDeps(h);
  const cycles = 3;
  for (let i = 0; i < cycles; i++) {
    const claim = claim_task({ db: h.db, clock: h.clock }, { taskId });
    if (!claim.ok) throw new Error(`expected claim to succeed on cycle ${i + 1}`);
    h.clock.advanceMs(60 * 60 * 1000);
    const results = tick_once(built.deps);
    if (i < cycles - 1) {
      expect(results).toEqual([{ task_id: taskId, action: "claim_expired" }]);
    } else {
      expect(results).toEqual([
        { task_id: taskId, action: "orchestrator_loop_parked" },
      ]);
    }
    h.clock.advanceMs(60 * 1000);
  }

  const task = h.db
    .query<
      { state: string; claim_id: string | null; claim_expirations_consecutive: number },
      [string]
    >(
      `SELECT state, claim_id, claim_expirations_consecutive
         FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task!.state).toBe("orchestrator_loop");
  expect(task!.claim_id).toBeNull();
  expect(task!.claim_expirations_consecutive).toBe(3);

  const parked = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM events
         WHERE task_id = ? AND event_type = 'orchestrator_loop_parked'`,
    )
    .get(taskId);
  expect(parked!.n).toBe(1);

  // Subsequent ticks do not touch a parked task.
  const followup = tick_once(built.deps);
  expect(followup).toEqual([]);
});
