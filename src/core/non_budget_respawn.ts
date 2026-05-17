// Non-budget respawn helper (spec §5 "schedule non-budget respawn",
// §7 "Non-budget respawn dedup", §14 "Non-budget respawns are deduplicated").
//
// Used by the `pr-open` and `done` handlers in tick to schedule `review` or
// `conflict` respawns without consuming the retry budget. The spec demands
// **increment-then-compare-then-decide** in a single SQL transaction:
//
//   1. Increment `tasks.non_budget_respawns_consumed` by 1.
//   2. If post-increment > `max_non_budget_respawns`: do NOT schedule, park
//      the task in `non_budget_loop` and write `non_budget_loop_parked`
//      event. The increment is still committed (forensics + race safety).
//   3. Else: insert a pending attempt row with `consumed_budget = 0`, write
//      `brief` + `final_prompt` artifacts, record the dedupe key
//      (`last_review_id_acted_on` / `last_conflict_observation`), and
//      transition the task to `queued`.
//
// Snapshot artifact (`review_comments` / `conflict_slice`) is written before
// the SQL transaction and referenced by `payload_artifact_id` regardless of
// the schedule-vs-park branch.

import type { ArtifactStore } from "../artifacts/store.ts";
import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";
import { ensurePreambleIdForAttemptReason, loadPreambleBody } from "./preamble.ts";
import {
  composeWorkerPrompt,
  loadTaskPrBaseBranch,
  loadOriginalTaskObjective,
} from "./worker_prompt.ts";
import {
  activateGoalForWorkerAttempt,
  loadGoalId,
  loadGoalPromptContext,
} from "./goals.ts";

export type NonBudgetReason = "review" | "conflict";

export interface NonBudgetRetryDeps {
  db: DB;
  clock: Clock;
  artifactStore: ArtifactStore;
}

export interface NonBudgetAttemptRef {
  attempt_id: number;
  attempt_number: number;
}

export interface NonBudgetInput {
  taskId: string;
  prevAttempt: NonBudgetAttemptRef;
  reason: NonBudgetReason;
  diagnostics: string;
  fromState: string;
  // Artifact captured at trigger time and referenced by the scheduling /
  // parking event. `kind` is `review_comments` for review respawns and
  // `conflict_slice` for conflict respawns.
  snapshotKind: "review_comments" | "conflict_slice";
  snapshotContent: string;
  snapshotExtension: "json" | "txt";
  // Dedupe key column + value to record on the task in the same transaction.
  dedupeColumn: "last_review_id_acted_on" | "last_conflict_observation";
  dedupeValue: string;
  extraSnapshots?: NonBudgetSnapshot[];
  extraDedupeUpdates?: NonBudgetDedupeUpdate[];
  maxNonBudgetRespawns: number;
}

export interface NonBudgetSnapshot {
  snapshotKind: "review_comments" | "conflict_slice";
  snapshotContent: string;
  snapshotExtension: "json" | "txt";
}

export interface NonBudgetDedupeUpdate {
  dedupeColumn: "last_review_id_acted_on" | "last_conflict_observation";
  dedupeValue: string;
}

export type NonBudgetOutcome = "scheduled" | "parked" | "skipped";

export interface NonBudgetResult {
  outcome: NonBudgetOutcome;
  artifactId?: number;
  nextAttemptId?: number;
  postCount?: number;
}

const DEFAULT_NON_BUDGET_TEMPLATES: Record<NonBudgetReason, string> = {
  review:
    "The pull request has new review feedback marked CHANGES_REQUESTED. Read the snapshotted comments, address each one, push the branch, and update the existing PR.",
  conflict:
    "The pull request can no longer be merged cleanly: GitHub reports a merge conflict against the base branch. Pull the base, resolve the conflict, push the branch, and update the existing PR.",
};

export function scheduleNonBudgetRespawn(
  deps: NonBudgetRetryDeps,
  input: NonBudgetInput,
): NonBudgetResult {
  // Snapshot artifact first so the trigger context is preserved even if the
  // task is parked. The artifact is bound to the *previous* attempt because
  // it was the one that produced the GitHub-side state we're observing.
  const snapshots = [
    {
      snapshotKind: input.snapshotKind,
      snapshotContent: input.snapshotContent,
      snapshotExtension: input.snapshotExtension,
    },
    ...(input.extraSnapshots ?? []),
  ];
  const writtenSnapshots = snapshots.map((snapshot) =>
    deps.artifactStore.writeArtifact({
      taskId: input.taskId,
      attemptId: input.prevAttempt.attempt_id,
      kind: snapshot.snapshotKind,
      content: snapshot.snapshotContent,
      extension: snapshot.snapshotExtension,
    }),
  );
  const primarySnapshot = writtenSnapshots[0]!;

  const now = deps.clock.nowISO();
  deps.db.exec("BEGIN IMMEDIATE");
  try {
    const incremented = deps.db
      .query<{ post_count: number }, [string, string]>(
        `UPDATE tasks
            SET non_budget_respawns_consumed = non_budget_respawns_consumed + 1,
                tick_error = NULL,
                updated_at = ?
          WHERE task_id = ? AND cancel_requested_at IS NULL
          RETURNING non_budget_respawns_consumed AS post_count`,
      )
      .get(now, input.taskId);
    if (!incremented) {
      // cancel slipped in between read and write, or row missing.
      deps.db.exec("ROLLBACK");
      return { outcome: "skipped", artifactId: primarySnapshot.artifactId };
    }
    const postCount = incremented.post_count;

    if (postCount > input.maxNonBudgetRespawns) {
      // Cap exceeded: park the task. The increment is still committed (per
      // spec §5: "the counter records the rejected attempt for forensics and
      // prevents a tie/race from re-trying"). No `last_failure` artifact:
      // the trigger is external GitHub state, not a failure to retry.
      deps.db
        .query(
          `UPDATE tasks
              SET state = 'non_budget_loop',
                  tick_error = NULL,
                  updated_at = ?
            WHERE task_id = ? AND cancel_requested_at IS NULL`,
        )
        .run(now, input.taskId);
      deps.db
        .query(
          `INSERT INTO events (
             task_id, attempt_id, event_type, from_state, to_state,
             payload_artifact_id, occurred_at
           ) VALUES (?, ?, 'non_budget_loop_parked', ?, 'non_budget_loop', ?, ?)`,
        )
        .run(
          input.taskId,
          input.prevAttempt.attempt_id,
          input.fromState,
          primarySnapshot.artifactId,
          now,
        );
      deps.db.exec("COMMIT");
      return {
        outcome: "parked",
        artifactId: primarySnapshot.artifactId,
        postCount,
      };
    }

    // Schedule a new attempt with consumed_budget = 0.
    const template = ensureNonBudgetTemplate(deps.db, deps.clock, input.reason);
    const preambleId = ensurePreambleIdForAttemptReason(
      deps.db,
      deps.clock,
      input.reason,
    );
    const objective = loadOriginalTaskObjective(deps.db, input.taskId);
    const prBaseBranch = loadTaskPrBaseBranch(deps.db, input.taskId);
    const goalContext = loadGoalPromptContext(deps.db, input.taskId);
    const preambleBody = loadPreambleBody(deps.db, preambleId);
    const composed = composeWorkerPrompt({
      preambleBody,
      taskObjective: objective,
      prBaseBranch,
      goalContext,
      attemptGuidance: { reason: input.reason, body: template.body },
      diagnostics: {
        kind:
          input.reason === "review" ? "review_comments" : "conflict_slice",
        body: input.diagnostics,
      },
    });

    const goalId = loadGoalId(deps.db, input.taskId);
    if (goalId !== null) {
      const activated = activateGoalForWorkerAttempt(deps.db, input.taskId, now);
      if (!activated) {
        throw new Error(
          `goal ${goalId} for task ${input.taskId} cannot be activated; goal token budget is exhausted`,
        );
      }
    }

    const attempt = deps.db
      .query<
        { attempt_id: number },
        [string, number, number, number, string, string | null]
      >(
        `INSERT INTO attempts (
           task_id, attempt_number, preamble_id, template_id, reason, consumed_budget, goal_id
         ) VALUES (?, ?, ?, ?, ?, 0, ?)
         RETURNING attempt_id`,
      )
      .get(
        input.taskId,
        input.prevAttempt.attempt_number + 1,
        preambleId,
        template.template_id,
        input.reason,
        goalId,
      );
    if (!attempt) throw new Error("non-budget respawn attempt insert returned no row");

    deps.artifactStore.writeArtifact({
      taskId: input.taskId,
      attemptId: attempt.attempt_id,
      kind: "brief",
      content: composed.brief,
      extension: "md",
    });
    deps.artifactStore.writeArtifact({
      taskId: input.taskId,
      attemptId: attempt.attempt_id,
      kind: "final_prompt",
      content: composed.finalPrompt,
      extension: "md",
    });

    applyDedupeUpdates(deps.db, input.taskId, now, [
      { dedupeColumn: input.dedupeColumn, dedupeValue: input.dedupeValue },
      ...(input.extraDedupeUpdates ?? []),
    ]);

    const eventType =
      input.reason === "review" ? "changes_requested" : "conflict";
    deps.db
      .query(
        `INSERT INTO events (
           task_id, attempt_id, event_type, from_state, to_state,
           payload_artifact_id, occurred_at
         ) VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(
        input.taskId,
        attempt.attempt_id,
        eventType,
        input.fromState,
        primarySnapshot.artifactId,
        now,
      );

    deps.db.exec("COMMIT");
    return {
      outcome: "scheduled",
      artifactId: primarySnapshot.artifactId,
      nextAttemptId: attempt.attempt_id,
      postCount,
    };
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

function applyDedupeUpdates(
  db: DB,
  taskId: string,
  now: string,
  updates: NonBudgetDedupeUpdate[],
): void {
  const reviewId = latestDedupeValue(updates, "last_review_id_acted_on");
  const conflictObservation = latestDedupeValue(
    updates,
    "last_conflict_observation",
  );

  if (reviewId !== undefined && conflictObservation !== undefined) {
    db.query(
      `UPDATE tasks
          SET state = 'queued',
              last_review_id_acted_on = ?,
              last_conflict_observation = ?,
              tick_error = NULL,
              updated_at = ?
        WHERE task_id = ? AND cancel_requested_at IS NULL`,
    ).run(reviewId, conflictObservation, now, taskId);
    return;
  }

  if (reviewId !== undefined) {
    db.query(
      `UPDATE tasks
          SET state = 'queued',
              last_review_id_acted_on = ?,
              tick_error = NULL,
              updated_at = ?
        WHERE task_id = ? AND cancel_requested_at IS NULL`,
    ).run(reviewId, now, taskId);
    return;
  }

  if (conflictObservation !== undefined) {
    db.query(
      `UPDATE tasks
          SET state = 'queued',
              last_conflict_observation = ?,
              tick_error = NULL,
              updated_at = ?
        WHERE task_id = ? AND cancel_requested_at IS NULL`,
    ).run(conflictObservation, now, taskId);
    return;
  }

  throw new Error("non-budget respawn requires at least one dedupe update");
}

function latestDedupeValue(
  updates: NonBudgetDedupeUpdate[],
  column: NonBudgetDedupeUpdate["dedupeColumn"],
): string | undefined {
  for (let i = updates.length - 1; i >= 0; i--) {
    const update = updates[i]!;
    if (update.dedupeColumn === column) return update.dedupeValue;
  }
  return undefined;
}

function ensureNonBudgetTemplate(
  db: DB,
  clock: Clock,
  reason: NonBudgetReason,
): { template_id: number; body: string } {
  const existing = db
    .query<{ template_id: number; body: string }, [string]>(
      `SELECT template_id, body FROM retry_templates
        WHERE kind = ?
        ORDER BY template_id DESC
        LIMIT 1`,
    )
    .get(reason);
  if (existing) return existing;
  const inserted = db
    .query<
      { template_id: number; body: string },
      [string, string, string]
    >(
      `INSERT INTO retry_templates (kind, body, created_at)
       VALUES (?, ?, ?)
       RETURNING template_id, body`,
    )
    .get(reason, DEFAULT_NON_BUDGET_TEMPLATES[reason], clock.nowISO());
  if (!inserted) throw new Error("retry template insert returned no row");
  return inserted;
}
