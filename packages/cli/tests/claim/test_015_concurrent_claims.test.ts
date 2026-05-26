import { afterEach, expect, test } from "bun:test";
import { claim_task } from "../../src/core/claims.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo, insertTask } from "../support/fixtures.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_015_concurrent_claims_only_one_wins", () => {
  h = createHarness();
  h.clock.set("2026-04-28T10:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-claim-concurrent");
  const taskId = insertTask(h.db, {
    taskId: "task-claim-concurrent",
    repoId,
    state: "awaiting-next-brief",
  });
  insertAttempt(h.db, { taskId, attemptNumber: 1, spawnedAt: "2026-04-28T08:00:00.000Z" });

  const a = claim_task({ db: h.db, clock: h.clock }, { taskId });
  const b = claim_task({ db: h.db, clock: h.clock }, { taskId });

  // Exactly one winner.
  const winner = a.ok ? a : b.ok ? b : null;
  const loser = !a.ok ? a : !b.ok ? b : null;
  expect(winner).not.toBeNull();
  expect(loser).not.toBeNull();
  if (winner === null || loser === null) throw new Error("unreachable");
  if (!winner.ok) throw new Error("expected a winner");
  if (loser.ok) throw new Error("expected a loser");

  expect(winner.value.task_id).toBe(taskId);
  expect(winner.value.state).toBe("claimed-by-orchestrator");
  expect(winner.value.claim_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  expect(loser.error.code).toBe("wrong_state");
  if (loser.error.details) {
    expect(loser.error.details.state).toBe("claimed-by-orchestrator");
  }

  // Task is claimed exactly once with the winner's claim_id.
  const task = h.db
    .query<
      { state: string; claim_id: string | null; claimed_at: string | null },
      [string]
    >(`SELECT state, claim_id, claimed_at FROM tasks WHERE task_id = ?`)
    .get(taskId);
  expect(task!.state).toBe("claimed-by-orchestrator");
  expect(task!.claim_id).toBe(winner.value.claim_id);
  expect(task!.claimed_at).not.toBeNull();

  // Exactly one `claimed` event was logged.
  const events = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND event_type = 'claimed'`,
    )
    .get(taskId);
  expect(events!.n).toBe(1);
});
