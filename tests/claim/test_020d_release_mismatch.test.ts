import { afterEach, expect, test } from "bun:test";
import { claim_task, release_claim } from "../../src/core/claims.ts";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo, insertTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_020d_release_claim_mismatch_is_claim_lost", async () => {
  h = createHarness();
  h.clock.set("2026-04-28T10:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-release-mismatch");
  const taskId = insertTask(h.db, {
    taskId: "task-release-mismatch",
    repoId,
    state: "awaiting-next-brief",
  });
  insertAttempt(h.db, { taskId, attemptNumber: 1, spawnedAt: "2026-04-28T08:00:00.000Z" });

  const claimA = claim_task({ db: h.db, clock: h.clock }, { taskId });
  if (!claimA.ok) throw new Error("expected A to claim");
  const claimIdA = claimA.value.claim_id;

  // Tick auto-releases A's claim after timeout.
  h.clock.set("2026-04-28T11:00:00.000Z");
  const built = buildTickDeps(h);
  await tick_once(built.deps);

  // B claims and gets a fresh claim_id.
  const claimB = claim_task({ db: h.db, clock: h.clock }, { taskId });
  if (!claimB.ok) throw new Error("expected B to claim");
  const claimIdB = claimB.value.claim_id;

  // A tries to release with the stale claim_id — this is `claim_lost`,
  // distinguishable from the canonical no-op success on
  // already-released tasks.
  const release = release_claim({ db: h.db, clock: h.clock }, {
    taskId,
    claimId: claimIdA,
  });
  expect(release.ok).toBe(false);
  if (release.ok) throw new Error("expected release to fail");
  expect(release.error.code).toBe("claim_lost");

  const task = h.db
    .query<{ state: string; claim_id: string | null }, [string]>(
      `SELECT state, claim_id FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task!.state).toBe("claimed-by-orchestrator");
  expect(task!.claim_id).toBe(claimIdB);
});
