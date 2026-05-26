// Conflict-respawn dedup must key on the base ref *tip*, not the merge-base.
// The merge-base is stable across base advances (when head is unchanged), so
// using it for the dedup key would mean a base advance that worsens the
// conflict never re-triggers a respawn until head also moves. This test pins
// the tip-keyed behavior: same head, advanced base tip, fresh respawn.
import { afterEach, expect, test } from "bun:test";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo, insertTask, seedTaskObjective } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("same head + advanced base tip schedules a fresh conflict respawn (merge-base stable)", async () => {
  h = createHarness();
  h.clock.set("2026-05-11T11:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-tip-advance");
  const taskId = insertTask(h.db, {
    taskId: "task-tip-advance",
    repoId,
    state: "pr-open",
  });
  seedTaskObjective(h, taskId);
  const attemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-05-11T10:00:00.000Z",
  });
  h.db
    .query(`UPDATE tasks SET attempts_consumed = 1 WHERE task_id = ?`)
    .run(taskId);
  // Pre-seed the prior observation so a *matching* tip would dedup. The
  // observation format is `${headSha}:${baseTipSha}` — same head, same tip,
  // no respawn.
  h.db
    .query(
      `UPDATE tasks SET last_conflict_observation = 'head-stable:tip-old'
        WHERE task_id = ?`,
    )
    .run(taskId);

  const built = buildTickDeps(h);
  built.artifactStore.writeArtifact({
    taskId,
    attemptId,
    kind: "brief",
    content: "initial brief",
    extension: "md",
  });

  // Tick 1: head unchanged AND base tip unchanged. The merge-base is also
  // unchanged. Dedup hits → no respawn scheduled.
  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    state: "open",
    headSha: "head-stable",
    baseSha: "merge-base-stable",
    baseTipSha: "tip-old",
    mergeable: "conflicting",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "head-stable",
      items: [
        { name: "build", workflow: null, bucket: "pending", required: true },
      ],
    },
  });
  const dedupResult = await tick_once(built.deps);
  // No conflict-respawn action: dedup hit. (The state is unchanged; tick
  // falls through to ci classification and reports ci_pending.)
  expect(
    dedupResult.find((r) => r.action === "conflict_respawn_scheduled"),
  ).toBeUndefined();

  // Tick 2: same head, same merge-base — but the base tip advanced. With
  // tip-keyed dedup, the observation changes and a fresh respawn schedules.
  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    state: "open",
    headSha: "head-stable",
    baseSha: "merge-base-stable", // merge-base unchanged
    baseTipSha: "tip-new", // base branch advanced
    mergeable: "conflicting",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "head-stable",
      items: [
        { name: "build", workflow: null, bucket: "pending", required: true },
      ],
    },
  });
  const advanceResult = await tick_once(built.deps);
  expect(advanceResult).toEqual([
    { task_id: taskId, action: "conflict_respawn_scheduled" },
  ]);

  const task = h.db
    .query<
      { last_conflict_observation: string | null },
      [string]
    >(
      `SELECT last_conflict_observation FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task?.last_conflict_observation).toBe("head-stable:tip-new");
});
