import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { claim_task, submit_brief } from "../../src/core/claims.ts";
import { ensurePreambleIdForAttemptReason } from "../../src/core/preamble.ts";
import { createArtifactStore } from "../../src/artifacts/store.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo, insertTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_058_submit_brief_schedules_queued_not_running", async () => {
  h = createHarness();
  h.clock.set("2026-04-28T10:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-submit-brief");
  const taskId = insertTask(h.db, {
    taskId: "task-submit-brief",
    repoId,
    state: "awaiting-next-brief",
  });
  insertAttempt(h.db, { taskId, attemptNumber: 1, spawnedAt: "2026-04-28T08:00:00.000Z" });
  // Simulate prior state: budget already consumed once and one expiration on
  // record so we can assert the reset.
  h.db
    .query(
      `UPDATE tasks
          SET attempts_consumed = 1, claim_expirations_consecutive = 1
        WHERE task_id = ?`,
    )
    .run(taskId);

  const claim = claim_task({ db: h.db, clock: h.clock }, { taskId });
  if (!claim.ok) throw new Error("expected claim");
  const store = createArtifactStore({ db: h.db, artifactRoot: h.artifactRoot, clock: h.clock });

  const submission = await submit_brief(
    { db: h.db, clock: h.clock, artifactStore: store },
    {
      taskId,
      claimId: claim.value.claim_id,
      brief: "second brief\n",
      reason: "blocker_resolved",
    },
  );
  if (!submission.ok) throw new Error("expected submit to succeed");

  const task = h.db
    .query<
      {
        state: string;
        claim_id: string | null;
        claimed_at: string | null;
        claim_expirations_consecutive: number;
        attempts_consumed: number;
      },
      [string]
    >(
      `SELECT state, claim_id, claimed_at, claim_expirations_consecutive, attempts_consumed
         FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task!.state).toBe("queued");
  expect(task!.claim_id).toBeNull();
  expect(task!.claimed_at).toBeNull();
  expect(task!.claim_expirations_consecutive).toBe(0);
  // Budget is consumed at later promotion, not at submit-brief.
  expect(task!.attempts_consumed).toBe(1);

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
  expect(pending).toBeTruthy();
  expect(pending!.attempt_id).toBe(submission.value.attempt_id);
  expect(pending!.attempt_number).toBe(2);
  expect(pending!.reason).toBe("blocker_resolved");
  expect(pending!.consumed_budget).toBe(1);
  expect(pending!.spawned_at).toBeNull();

  const briefRow = h.db
    .query<{ file_path: string }, [string]>(
      `SELECT file_path FROM artifacts
         WHERE task_id = ? AND attempt_id = ${submission.value.attempt_id} AND kind = 'brief'`,
    )
    .get(taskId);
  expect(briefRow).toBeTruthy();
  expect(readFileSync(briefRow!.file_path, "utf8")).toContain("second brief");

  const finalRow = h.db
    .query<{ n: number }, [string, number]>(
      `SELECT COUNT(*) AS n FROM artifacts
         WHERE task_id = ? AND attempt_id = ? AND kind = 'final_prompt'`,
    )
    .get(taskId, submission.value.attempt_id);
  expect(finalRow!.n).toBe(1);

  // Submit-brief never spawns. No new tmux session has been requested.
  const built = buildTickDeps(h);
  expect(built.tmux.spawnCalls).toHaveLength(0);
});

test("test_058_submit_brief_advice_answered_does_not_consume_budget", async () => {
  h = createHarness();
  h.clock.set("2026-04-28T10:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-advice");
  const taskId = insertTask(h.db, {
    taskId: "task-advice",
    repoId,
    state: "awaiting-next-brief",
  });
  insertAttempt(h.db, { taskId, attemptNumber: 1, spawnedAt: "2026-04-28T08:00:00.000Z" });

  const claim = claim_task({ db: h.db, clock: h.clock }, { taskId });
  if (!claim.ok) throw new Error("expected claim");
  const store = createArtifactStore({ db: h.db, artifactRoot: h.artifactRoot, clock: h.clock });

  const submission = await submit_brief(
    { db: h.db, clock: h.clock, artifactStore: store },
    {
      taskId,
      claimId: claim.value.claim_id,
      brief: "advice answered\n",
      reason: "advice_answered",
    },
  );
  if (!submission.ok) throw new Error("expected submit to succeed");

  const pending = h.db
    .query<{ reason: string; consumed_budget: number }, [string]>(
      `SELECT reason, consumed_budget FROM attempts
         WHERE task_id = ? AND spawned_at IS NULL`,
    )
    .get(taskId);
  expect(pending).toEqual({ reason: "advice_answered", consumed_budget: 0 });
});

for (const reason of ["blocker_resolved", "advice_answered"] as const) {
  test(`submit_brief ${reason} after latest review_only uses worker preamble`, async () => {
    h = createHarness();
    h.clock.set("2026-05-15T09:00:00.000Z");
    const repoId = insertRepo(h.db, `repo-${reason}`);
    const taskId = insertTask(h.db, {
      taskId: `task-${reason}`,
      repoId,
      state: "awaiting-next-brief",
    });
    const codePreambleId = ensurePreambleIdForAttemptReason(
      h.db,
      h.clock,
      "initial",
    );
    const reviewPreambleId = ensurePreambleIdForAttemptReason(
      h.db,
      h.clock,
      "review_only",
    );
    insertAttempt(h.db, {
      taskId,
      attemptNumber: 1,
      preambleId: codePreambleId,
      reason: "initial",
      consumedBudget: 1,
      spawnedAt: "2026-05-15T07:00:00.000Z",
    });
    insertAttempt(h.db, {
      taskId,
      attemptNumber: 2,
      preambleId: reviewPreambleId,
      reason: "review_only",
      consumedBudget: 0,
      spawnedAt: "2026-05-15T07:30:00.000Z",
    });

    const claim = claim_task({ db: h.db, clock: h.clock }, { taskId });
    if (!claim.ok) throw new Error("expected claim");
    const store = createArtifactStore({
      db: h.db,
      artifactRoot: h.artifactRoot,
      clock: h.clock,
    });

    const submission = await submit_brief(
      { db: h.db, clock: h.clock, artifactStore: store },
      {
        taskId,
        claimId: claim.value.claim_id,
        brief: `follow-up worker brief for ${reason}`,
        reason,
      },
    );
    if (!submission.ok) throw new Error("expected submit to succeed");

    const pending = h.db
      .query<
        { reason: string; preamble_id: number; consumed_budget: number },
        [number]
      >(
        `SELECT reason, preamble_id, consumed_budget
           FROM attempts WHERE attempt_id = ?`,
      )
      .get(submission.value.attempt_id);
    expect(pending!.reason).toBe(reason);
    expect(pending!.consumed_budget).toBe(reason === "blocker_resolved" ? 1 : 0);
    const kind = h.db
      .query<{ kind: string }, [number]>(
        `SELECT kind FROM preambles WHERE preamble_id = ?`,
      )
      .get(pending!.preamble_id);
    expect(kind!.kind).toBe("code");

    const finalRow = h.db
      .query<{ file_path: string }, [string, number]>(
        `SELECT file_path FROM artifacts
           WHERE task_id = ? AND attempt_id = ? AND kind = 'final_prompt'`,
      )
      .get(taskId, submission.value.attempt_id);
    const finalPrompt = readFileSync(finalRow!.file_path, "utf8");
    expect(finalPrompt.startsWith("Quay protocol preamble")).toBe(true);
    expect(finalPrompt).not.toContain("You are running as a Quay reviewer worker");
    expect(finalPrompt).not.toContain("Do not modify code");
    expect(finalPrompt).not.toContain("Do not push");
    expect(finalPrompt).not.toContain("You do not push");
    expect(finalPrompt).toContain(`follow-up worker brief for ${reason}`);
  });
}
