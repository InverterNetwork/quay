import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo, insertTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("conflict plus changes-requested review schedules one combined non-budget respawn", async () => {
  h = createHarness();
  h.clock.set("2026-05-15T10:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-conflict-review-combined");
  const taskId = insertTask(h.db, {
    taskId: "task-conflict-review-combined",
    repoId,
    state: "done",
  });
  const attemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-05-15T09:00:00.000Z",
  });
  h.db
    .query(`UPDATE tasks SET attempts_consumed = 1 WHERE task_id = ?`)
    .run(taskId);

  const built = buildTickDeps(h);
  built.artifactStore.writeArtifact({
    taskId,
    attemptId,
    kind: "brief",
    content: "initial implementation brief",
    extension: "md",
  });

  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    state: "open",
    headSha: "head-combo",
    baseSha: "base-combo",
    mergeable: "conflicting",
    latestReview: {
      decision: "CHANGES_REQUESTED",
      latestReviewId: "review-combo",
      comments: "Please fix the parser branch and add the missing coverage.",
    },
    checks: { checkSha: "head-combo", items: [] },
  });

  const results = await tick_once(built.deps);
  expect(results).toEqual([
    { task_id: taskId, action: "conflict_respawn_scheduled" },
  ]);

  const task = h.db
    .query<
      {
        state: string;
        attempts_consumed: number;
        last_conflict_observation: string | null;
        last_review_id_acted_on: string | null;
        non_budget_respawns_consumed: number;
      },
      [string]
    >(
      `SELECT state, attempts_consumed, last_conflict_observation,
              last_review_id_acted_on, non_budget_respawns_consumed
         FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toEqual({
    state: "queued",
    attempts_consumed: 1,
    last_conflict_observation: "head-combo:base-combo",
    last_review_id_acted_on: "review-combo",
    non_budget_respawns_consumed: 1,
  });

  const pending = h.db
    .query<
      {
        attempt_id: number;
        attempt_number: number;
        reason: string;
        consumed_budget: number;
        spawned_at: string | null;
      },
      [string]
    >(
      `SELECT attempt_id, attempt_number, reason, consumed_budget, spawned_at
         FROM attempts WHERE task_id = ? AND spawned_at IS NULL`,
    )
    .get(taskId);
  expect(pending).toMatchObject({
    attempt_number: 2,
    reason: "conflict",
    consumed_budget: 0,
    spawned_at: null,
  });

  const triggerArtifacts = h.db
    .query<{ kind: string; n: number; attempt_id: number | null }, [string]>(
      `SELECT kind, COUNT(*) AS n, MIN(attempt_id) AS attempt_id
         FROM artifacts
        WHERE task_id = ? AND kind IN ('conflict_slice', 'review_comments')
        GROUP BY kind
        ORDER BY kind`,
    )
    .all(taskId);
  expect(triggerArtifacts).toEqual([
    { kind: "conflict_slice", n: 1, attempt_id: attemptId },
    { kind: "review_comments", n: 1, attempt_id: attemptId },
  ]);

  const briefRow = h.db
    .query<{ file_path: string }, [string, number]>(
      `SELECT file_path FROM artifacts
        WHERE task_id = ? AND attempt_id = ? AND kind = 'brief'`,
    )
    .get(taskId, pending!.attempt_id);
  const brief = readFileSync(briefRow!.file_path, "utf8");
  expect(brief).toContain("mergeable=conflicting");
  expect(brief).toContain("head=head-combo base=base-combo");
  expect(brief).toContain("Reviewer marked CHANGES_REQUESTED in review review-combo.");
  expect(brief).toContain("Resolve the merge conflict against the base branch.");
  expect(brief).toContain("Address the CHANGES_REQUESTED review comments.");
  expect(brief).toContain("Push the existing branch and update the existing PR.");
  expect(brief).toContain(
    "Please fix the parser branch and add the missing coverage.",
  );

  h.db
    .query(`DELETE FROM events WHERE attempt_id = ?`)
    .run(pending!.attempt_id);
  h.db
    .query(`DELETE FROM artifacts WHERE attempt_id = ?`)
    .run(pending!.attempt_id);
  h.db
    .query(`DELETE FROM attempts WHERE attempt_id = ?`)
    .run(pending!.attempt_id);
  h.db.query(`UPDATE tasks SET state = 'done' WHERE task_id = ?`).run(taskId);

  const secondResults = await tick_once(built.deps);
  expect(secondResults).toEqual([]);

  const afterDedupe = h.db
    .query<
      {
        state: string;
        non_budget_respawns_consumed: number;
        pending_attempts: number;
      },
      [string]
    >(
      `SELECT state, non_budget_respawns_consumed,
              (SELECT COUNT(*) FROM attempts
                WHERE task_id = tasks.task_id AND spawned_at IS NULL)
                AS pending_attempts
         FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(afterDedupe).toEqual({
    state: "done",
    non_budget_respawns_consumed: 1,
    pending_attempts: 0,
  });
});
