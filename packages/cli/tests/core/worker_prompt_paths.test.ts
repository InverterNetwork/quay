// Integration tests asserting the shared composer's output shape on each
// code-worker prompt path: deterministic retry, orchestrator submit-brief,
// and non-budget respawn. (The initial-enqueue path is covered by
// tests/enqueue/enqueue_065_brief_and_final_prompt.test.ts.)

import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createArtifactStore } from "../../src/artifacts/store.ts";
import {
  claim_task,
  submit_brief,
  type SubmitBriefDeps,
} from "../../src/core/claims.ts";
import { scheduleDeterministicRetry } from "../../src/core/retries.ts";
import { scheduleNonBudgetRespawn } from "../../src/core/non_budget_respawn.ts";
import { ensurePreambleIdForAttemptReason } from "../../src/core/preamble.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import {
  insertAttempt,
  insertRepo,
  insertTask,
  seedTaskObjective,
} from "../support/fixtures.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

function readBrief(taskId: string, attemptId: number): string {
  if (!h) throw new Error("missing harness");
  const row = h.db
    .query<{ file_path: string }, [string, number]>(
      `SELECT file_path FROM artifacts
        WHERE task_id = ? AND attempt_id = ? AND kind = 'brief'`,
    )
    .get(taskId, attemptId);
  if (!row) throw new Error(`no brief artifact for attempt ${attemptId}`);
  return readFileSync(row.file_path, "utf8");
}

function readFinalPrompt(taskId: string, attemptId: number): string {
  if (!h) throw new Error("missing harness");
  const row = h.db
    .query<{ file_path: string }, [string, number]>(
      `SELECT file_path FROM artifacts
        WHERE task_id = ? AND attempt_id = ? AND kind = 'final_prompt'`,
    )
    .get(taskId, attemptId);
  if (!row) throw new Error(`no final_prompt artifact for attempt ${attemptId}`);
  return readFileSync(row.file_path, "utf8");
}

test("deterministic retry brief uses composer with diagnostics + stable objective", () => {
  h = createHarness();
  const repoId = insertRepo(h.db, "repo-retry-composer");
  const taskId = insertTask(h.db, {
    taskId: "task-retry-composer",
    repoId,
    state: "running",
  });
  const objective = seedTaskObjective(
    h,
    taskId,
    "Implement /healthz returning {status: \"ok\"}.",
  );
  const prevAttemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    spawnedAt: "2026-04-28T09:00:00.000Z",
  });
  // Earlier (now-stale) attempt brief: must NOT appear in the new retry brief.
  const artifactStore = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });
  artifactStore.writeArtifact({
    taskId,
    attemptId: prevAttemptId,
    kind: "brief",
    content: "stale prior brief that should not propagate",
    extension: "md",
  });
  h.db
    .query(`UPDATE tasks SET attempts_consumed = 1 WHERE task_id = ?`)
    .run(taskId);

  const result = scheduleDeterministicRetry(
    { db: h.db, clock: h.clock, artifactStore },
    {
      taskId,
      prevAttempt: { attempt_id: prevAttemptId, attempt_number: 1, preamble_id: 0 },
      reason: "ci_fail",
      diagnostics: "CI: jest exit code 1\n  failing: Healthz returns ok",
      fromState: "pr-open",
    },
  );
  expect(result.scheduled).toBe(true);

  const newAttemptId = result.nextAttemptId!;
  const brief = readBrief(taskId, newAttemptId);

  // Stable task objective is first-class with audit pointer back to the
  // task-level task_objective artifact.
  expect(brief).toContain(
    `<quay-task-objective artifact-id="${objective.artifactId}"`,
  );
  expect(brief).toContain(`source-path="${objective.filePath}"`);
  expect(brief).toContain('truncated="false"');
  expect(brief).toContain("Implement /healthz returning");

  // Retry template body lands as current attempt guidance with the right reason.
  expect(brief).toContain('<quay-current-attempt-guidance reason="ci_fail">');

  // Diagnostics carry the CI excerpt under the expected kind.
  expect(brief).toContain('<quay-diagnostics kind="ci_failure_excerpt">');
  expect(brief).toContain("CI: jest exit code 1");

  // The prior attempt's brief no longer leaks into the retry prompt.
  expect(brief).not.toContain("stale prior brief that should not propagate");

  // final_prompt is preamble + brief.
  const finalPrompt = readFinalPrompt(taskId, newAttemptId);
  expect(finalPrompt.endsWith(brief)).toBe(true);
});

test("orchestrator submit-brief carries stable objective + submitted brief as guidance", async () => {
  h = createHarness();
  h.clock.set("2026-04-28T10:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-submit-composer");
  const taskId = insertTask(h.db, {
    taskId: "task-submit-composer",
    repoId,
    state: "awaiting-next-brief",
  });
  const objective = seedTaskObjective(h, taskId, "Original spec text.");
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    spawnedAt: "2026-04-28T08:00:00.000Z",
  });

  const claim = claim_task({ db: h.db, clock: h.clock }, { taskId });
  if (!claim.ok) throw new Error("expected claim");
  const store = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });
  const deps: SubmitBriefDeps = { db: h.db, clock: h.clock, artifactStore: store };

  const orchestratorBrief =
    "Resolved the blocker: rate-limit env var is RATE_LIMIT_RPS, default 20.";
  const result = await submit_brief(deps, {
    taskId,
    claimId: claim.value.claim_id,
    brief: orchestratorBrief,
    reason: "blocker_resolved",
  });
  if (!result.ok) throw new Error("expected submit to succeed");

  const brief = readBrief(taskId, result.value.attempt_id);
  expect(brief).toContain(
    `<quay-task-objective artifact-id="${objective.artifactId}"`,
  );
  expect(brief).toContain("Original spec text.");
  expect(brief).toContain('<quay-current-attempt-guidance reason="blocker_resolved">');
  expect(brief).toContain(orchestratorBrief);
  // submit-brief has no diagnostics section.
  expect(brief).not.toContain("<quay-diagnostics");
});

test("non-budget review respawn brief embeds review diagnostics with stable objective", () => {
  h = createHarness();
  h.clock.set("2026-05-15T08:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-respawn-composer");
  const taskId = insertTask(h.db, {
    taskId: "task-respawn-composer",
    repoId,
    state: "pr-open",
  });
  const objective = seedTaskObjective(
    h,
    taskId,
    "Add CSRF tokens to all POST endpoints.",
  );
  const preambleId = ensurePreambleIdForAttemptReason(h.db, h.clock, "initial");
  const prevAttemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    preambleId,
    reason: "initial",
    consumedBudget: 1,
    spawnedAt: "2026-05-15T07:00:00.000Z",
  });
  const artifactStore = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });
  artifactStore.writeArtifact({
    taskId,
    attemptId: prevAttemptId,
    kind: "brief",
    content: "prior implementation brief — should not be embedded again",
    extension: "md",
  });

  const reviewDiagnostics = JSON.stringify({
    findings: [{ id: 1, body: "POST /login still has no CSRF token" }],
  });
  const result = scheduleNonBudgetRespawn(
    { db: h.db, clock: h.clock, artifactStore },
    {
      taskId,
      prevAttempt: { attempt_id: prevAttemptId, attempt_number: 1 },
      reason: "review",
      diagnostics: reviewDiagnostics,
      fromState: "pr-open",
      snapshotKind: "review_comments",
      snapshotContent: reviewDiagnostics,
      snapshotExtension: "json",
      dedupeColumn: "last_review_id_acted_on",
      dedupeValue: "rev-1",
      maxNonBudgetRespawns: 3,
    },
  );
  expect(result.outcome).toBe("scheduled");
  const newAttemptId = result.nextAttemptId!;

  const brief = readBrief(taskId, newAttemptId);
  expect(brief).toContain(
    `<quay-task-objective artifact-id="${objective.artifactId}"`,
  );
  expect(brief).toContain("Add CSRF tokens to all POST endpoints.");
  expect(brief).toContain('<quay-current-attempt-guidance reason="review">');
  expect(brief).toContain('<quay-diagnostics kind="review_comments">');
  expect(brief).toContain("POST /login still has no CSRF token");
  expect(brief).not.toContain("prior implementation brief");
});

test("non-budget conflict respawn brief tags diagnostics as conflict_slice", () => {
  h = createHarness();
  h.clock.set("2026-05-15T08:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-conflict-composer");
  const taskId = insertTask(h.db, {
    taskId: "task-conflict-composer",
    repoId,
    state: "pr-open",
  });
  seedTaskObjective(h, taskId);
  const preambleId = ensurePreambleIdForAttemptReason(h.db, h.clock, "initial");
  const prevAttemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    preambleId,
    reason: "initial",
    consumedBudget: 1,
    spawnedAt: "2026-05-15T07:00:00.000Z",
  });
  const artifactStore = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });

  const conflictDetails = "src/cli.ts: <<<<<<< HEAD\\n... conflict markers ...";
  const result = scheduleNonBudgetRespawn(
    { db: h.db, clock: h.clock, artifactStore },
    {
      taskId,
      prevAttempt: { attempt_id: prevAttemptId, attempt_number: 1 },
      reason: "conflict",
      diagnostics: conflictDetails,
      fromState: "pr-open",
      snapshotKind: "conflict_slice",
      snapshotContent: conflictDetails,
      snapshotExtension: "txt",
      dedupeColumn: "last_conflict_observation",
      dedupeValue: "head-1",
      maxNonBudgetRespawns: 3,
    },
  );
  expect(result.outcome).toBe("scheduled");
  const newAttemptId = result.nextAttemptId!;
  const brief = readBrief(taskId, newAttemptId);
  expect(brief).toContain('<quay-current-attempt-guidance reason="conflict">');
  expect(brief).toContain('<quay-diagnostics kind="conflict_slice">');
  // Conflict marker `<<<<<<<` must be escaped so it can't masquerade as a tag.
  expect(brief).toContain("&lt;&lt;&lt;&lt;&lt;&lt;&lt; HEAD");
});
