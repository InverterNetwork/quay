import { afterEach, expect, test } from "bun:test";
import { claim_task, submit_brief } from "../../src/core/claims.ts";
import { tick_once } from "../../src/core/tick.ts";
import { createArtifactStore } from "../../src/artifacts/store.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo, insertTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_020a_stale_claimant_cannot_submit_brief", async () => {
  h = createHarness();
  h.clock.set("2026-04-28T10:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-stale");
  const taskId = insertTask(h.db, {
    taskId: "task-stale",
    repoId,
    state: "awaiting-next-brief",
  });
  insertAttempt(h.db, { taskId, attemptNumber: 1, spawnedAt: "2026-04-28T08:00:00.000Z" });

  // Orchestrator A claims and gets claim_id_A.
  const claimA = claim_task({ db: h.db, clock: h.clock }, { taskId });
  if (!claimA.ok) throw new Error("expected A to claim");
  const claimIdA = claimA.value.claim_id;

  // Tick auto-releases A's claim after the timeout.
  h.clock.set("2026-04-28T11:00:00.000Z");
  const built = buildTickDeps(h);
  await tick_once(built.deps);

  // Orchestrator B claims and gets claim_id_B.
  const claimB = claim_task({ db: h.db, clock: h.clock }, { taskId });
  if (!claimB.ok) throw new Error("expected B to claim");
  const claimIdB = claimB.value.claim_id;
  expect(claimIdB).not.toBe(claimIdA);

  // A wakes up and tries to submit a brief with the stale claim_id.
  const store = createArtifactStore({ db: h.db, artifactRoot: h.artifactRoot, clock: h.clock });
  const submission = await submit_brief(
    { db: h.db, clock: h.clock, artifactStore: store },
    {
      taskId,
      claimId: claimIdA,
      brief: "stale brief from A",
      reason: "blocker_resolved",
    },
  );
  expect(submission.ok).toBe(false);
  if (submission.ok) throw new Error("expected stale submit to fail");
  expect(submission.error.code).toBe("claim_lost");

  // The new claim is preserved untouched.
  const task = h.db
    .query<{ state: string; claim_id: string | null }, [string]>(
      `SELECT state, claim_id FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task!.state).toBe("claimed-by-orchestrator");
  expect(task!.claim_id).toBe(claimIdB);

  // A's call did not insert a new attempt or a brief artifact.
  const pending = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM attempts WHERE task_id = ? AND spawned_at IS NULL`,
    )
    .get(taskId);
  expect(pending!.n).toBe(0);
  const briefs = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM artifacts WHERE task_id = ? AND kind = 'brief'`,
    )
    .get(taskId);
  expect(briefs!.n).toBe(0);
});
