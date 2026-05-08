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

test("test_016_claim_timeout_auto_releases", async () => {
  h = createHarness();
  h.clock.set("2026-04-28T10:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-claim-timeout");
  const taskId = insertTask(h.db, {
    taskId: "task-claim-timeout",
    repoId,
    state: "awaiting-next-brief",
  });
  insertAttempt(h.db, { taskId, attemptNumber: 1, spawnedAt: "2026-04-28T08:00:00.000Z" });

  const claim = claim_task({ db: h.db, clock: h.clock }, { taskId });
  if (!claim.ok) throw new Error("expected claim to succeed");

  // Advance the clock past claim_timeout_seconds (default 1800s).
  h.clock.set("2026-04-28T11:00:00.000Z");
  const built = buildTickDeps(h);
  const results = await tick_once(built.deps);
  expect(results).toEqual([{ task_id: taskId, action: "claim_expired" }]);

  const task = h.db
    .query<
      {
        state: string;
        claim_id: string | null;
        claimed_at: string | null;
        claim_expirations_consecutive: number;
      },
      [string]
    >(
      `SELECT state, claim_id, claimed_at, claim_expirations_consecutive
         FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task!.state).toBe("awaiting-next-brief");
  expect(task!.claim_id).toBeNull();
  expect(task!.claimed_at).toBeNull();
  expect(task!.claim_expirations_consecutive).toBe(1);

  const ev = h.db
    .query<{ event_type: string; from_state: string | null; to_state: string | null }, [string]>(
      `SELECT event_type, from_state, to_state
         FROM events WHERE task_id = ? AND event_type = 'claim_expired'`,
    )
    .all(taskId);
  expect(ev).toHaveLength(1);
  expect(ev[0]).toEqual({
    event_type: "claim_expired",
    from_state: "claimed-by-orchestrator",
    to_state: "awaiting-next-brief",
  });
});
