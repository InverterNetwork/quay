import { readFileSync } from "node:fs";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";
import { enqueueOrchestratorHandoff } from "./orchestrator_handoffs.ts";
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

export type BudgetRetryReason =
  | "ci_fail"
  | "crash"
  | "stale"
  | "wall_clock"
  | "malformed_signal"
  | "malformed_goal_report"
  | "complete_without_delivery";

export interface RetryDeps {
  db: DB;
  clock: Clock;
  artifactStore: ArtifactStore;
}

export interface RetryAttemptRef {
  attempt_id: number;
  attempt_number: number;
  preamble_id: number;
}

export interface ScheduleDeterministicRetryInput {
  taskId: string;
  prevAttempt: RetryAttemptRef;
  reason: BudgetRetryReason;
  diagnostics: string;
  fromState?: string;
}

const RETRY_DIAGNOSTIC_KIND: Record<BudgetRetryReason, string> = {
  ci_fail: "ci_failure_excerpt",
  crash: "crash_details",
  stale: "stale_details",
  wall_clock: "wall_clock_details",
  malformed_signal: "malformed_signal_details",
  malformed_goal_report: "malformed_goal_report_details",
  complete_without_delivery: "complete_without_delivery_details",
};

export interface ScheduleDeterministicRetryResult {
  scheduled: boolean;
  artifactId: number;
  nextAttemptId?: number;
  budgetExhausted?: boolean;
}

const DEFAULT_RETRY_TEMPLATES: Record<BudgetRetryReason, string> = {
  ci_fail:
    "The pull request CI failed. Use the CI failure excerpt, inspect the code, fix the failure, push the branch, and update the existing PR.",
  crash:
    "The previous worker exited without producing a trackable PR or blocker. Continue from the persisted worktree, recover any useful local state, push the branch, and open or update the PR.",
  stale:
    "The previous worker stopped producing fresh logs and was killed as stale. Inspect the worktree and logs, then continue the task without repeating already-completed work.",
  wall_clock:
    "The previous worker exceeded the maximum allowed attempt duration and was killed. Continue from the persisted worktree with a narrower, practical next step.",
  malformed_signal:
    "The previous worker wrote an invalid .quay-blocked.md signal. Inspect the malformed signal artifact and continue or write a valid blocker if work cannot proceed.",
  malformed_goal_report:
    "The previous goal-mode worker wrote an invalid .quay-goal-report.json. Inspect the malformed report diagnostics, continue the task, and write a valid goal report before exiting.",
  complete_without_delivery:
    "The previous goal-mode worker reported complete, but Quay could not find a non-draft PR ready for review. Push the branch, open or update the PR, mark it ready for review, and then write a complete goal report.",
};

export function scheduleDeterministicRetry(
  deps: RetryDeps,
  input: ScheduleDeterministicRetryInput,
): ScheduleDeterministicRetryResult {
  const now = deps.clock.nowISO();
  const template = ensureRetryTemplate(deps.db, deps.clock, input.reason);
  const preambleId = ensurePreambleIdForAttemptReason(
    deps.db,
    deps.clock,
    input.reason,
  );
  const objective = loadOriginalTaskObjective(deps.db, input.taskId);
  const goalContext = loadGoalPromptContext(deps.db, input.taskId);
  const prBaseBranch = loadTaskPrBaseBranch(deps.db, input.taskId);
  const preambleBody = loadPreambleBody(deps.db, preambleId);
  const composed = composeWorkerPrompt({
    preambleBody,
    taskObjective: objective,
    prBaseBranch,
    goalContext,
    attemptGuidance: { reason: input.reason, body: template.body },
    diagnostics: {
      kind: RETRY_DIAGNOSTIC_KIND[input.reason],
      body: input.diagnostics,
    },
  });

  const task = deps.db
    .query<{ attempts_consumed: number; retry_budget: number }, [string]>(
      `SELECT attempts_consumed, retry_budget FROM tasks WHERE task_id = ?`,
    )
    .get(input.taskId);
  if (!task) throw new Error(`task ${input.taskId} not found`);

  if (task.attempts_consumed >= task.retry_budget) {
    const lastFailure = deps.artifactStore.writeArtifact({
      taskId: input.taskId,
      attemptId: input.prevAttempt.attempt_id,
      kind: "last_failure",
      content: composed.brief,
      extension: "md",
    });
    deps.db
      .query(
        `UPDATE tasks
            SET state = 'awaiting-next-brief',
                budget_exhausted = 1,
                tick_error = NULL,
                updated_at = ?
          WHERE task_id = ? AND cancel_requested_at IS NULL`,
      )
      .run(now, input.taskId);
    const eventRow = deps.db
      .query<
        { event_id: number },
        [string, number, string, number, string]
      >(
        `INSERT INTO events (
           task_id, attempt_id, event_type, from_state, to_state,
           payload_artifact_id, occurred_at
         ) VALUES (?, ?, 'budget_exhausted', ?, 'awaiting-next-brief', ?, ?)
         RETURNING event_id`,
      )
      .get(
        input.taskId,
        input.prevAttempt.attempt_id,
        input.fromState ?? "running",
        lastFailure.artifactId,
        now,
      );
    if (!eventRow) throw new Error("budget_exhausted event insert returned no row");
    enqueueOrchestratorHandoff(deps, {
      taskId: input.taskId,
      reason: "budget_exhausted",
      stateEventId: eventRow.event_id,
      payload: {
        attempt_id: input.prevAttempt.attempt_id,
        artifact_id: lastFailure.artifactId,
        retry_reason: input.reason,
      },
    });
    return {
      scheduled: false,
      artifactId: lastFailure.artifactId,
      budgetExhausted: true,
    };
  }

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
       ) VALUES (?, ?, ?, ?, ?, 1, ?)
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
  if (!attempt) throw new Error("attempt insert returned no row");

  const brief = deps.artifactStore.writeArtifact({
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

  deps.db
    .query(
      `UPDATE tasks
          SET state = 'queued',
              tick_error = NULL,
              updated_at = ?
        WHERE task_id = ? AND cancel_requested_at IS NULL`,
    )
    .run(now, input.taskId);
  return { scheduled: true, artifactId: brief.artifactId, nextAttemptId: attempt.attempt_id };
}

export function writeBlockerBudgetExhausted(
  deps: RetryDeps,
  input: {
    taskId: string;
    attempt: RetryAttemptRef;
    blockerContent: string;
  },
): number | null {
  const task = deps.db
    .query<{ attempts_consumed: number; retry_budget: number }, [string]>(
      `SELECT attempts_consumed, retry_budget FROM tasks WHERE task_id = ?`,
    )
    .get(input.taskId);
  if (!task || task.attempts_consumed < task.retry_budget) return null;

  const priorBrief = loadMostRecentWorkerBrief(deps.db, input.taskId);
  const body = [
    "# Retry budget exhausted",
    "",
    "A worker blocker was ingested on the final allowed budget-consuming attempt. No blocker_resolved respawn was scheduled.",
    "",
    "## Blocker",
    "",
    input.blockerContent,
    "",
    "## Most recent brief",
    "",
    priorBrief,
  ].join("\n");
  const artifact = deps.artifactStore.writeArtifact({
    taskId: input.taskId,
    attemptId: input.attempt.attempt_id,
    kind: "last_failure",
    content: body,
    extension: "md",
  });
  deps.db
    .query(
      `UPDATE tasks SET budget_exhausted = 1
        WHERE task_id = ? AND cancel_requested_at IS NULL`,
    )
    .run(input.taskId);
  const eventRow = deps.db
    .query<{ event_id: number }, [string, number, number, string]>(
      `INSERT INTO events (
         task_id, attempt_id, event_type, from_state, to_state,
         payload_artifact_id, occurred_at
       ) VALUES (?, ?, 'budget_exhausted', 'running', 'awaiting-next-brief', ?, ?)
       RETURNING event_id`,
    )
    .get(input.taskId, input.attempt.attempt_id, artifact.artifactId, deps.clock.nowISO());
  if (!eventRow) throw new Error("budget_exhausted event insert returned no row");
  enqueueOrchestratorHandoff(deps, {
    taskId: input.taskId,
    reason: "budget_exhausted",
    stateEventId: eventRow.event_id,
    payload: {
      attempt_id: input.attempt.attempt_id,
      artifact_id: artifact.artifactId,
      retry_reason: "worker_blocker",
    },
  });
  return artifact.artifactId;
}

export function scheduleCleanSpawnRetry(
  deps: RetryDeps,
  input: {
    taskId: string;
    prevAttempt: RetryAttemptRef & {
      reason: string;
      consumed_budget: number;
      template_id: number | null;
    };
  },
): number {
  const priorBrief = input.prevAttempt.reason === "review_only"
    ? loadMostRecentBrief(deps.db, input.taskId)
    : loadMostRecentWorkerBrief(deps.db, input.taskId);
  const preambleId = ensurePreambleIdForAttemptReason(
    deps.db,
    deps.clock,
    input.prevAttempt.reason,
  );
  const goalId =
    input.prevAttempt.reason === "review_only"
      ? null
      : loadGoalId(deps.db, input.taskId);
  const attempt = deps.db
    .query<
      { attempt_id: number },
      [string, number, number, number | null, string, number, string | null]
    >(
      `INSERT INTO attempts (
         task_id, attempt_number, preamble_id, template_id, reason, consumed_budget, goal_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING attempt_id`,
    )
    .get(
      input.taskId,
      input.prevAttempt.attempt_number + 1,
      preambleId,
      input.prevAttempt.template_id,
      input.prevAttempt.reason,
      input.prevAttempt.consumed_budget,
      goalId,
    );
  if (!attempt) throw new Error("attempt insert returned no row");

  deps.artifactStore.writeArtifact({
    taskId: input.taskId,
    attemptId: attempt.attempt_id,
    kind: "brief",
    content: priorBrief,
    extension: "md",
  });
  const preamble = loadPreambleBody(deps.db, preambleId);
  deps.artifactStore.writeArtifact({
    taskId: input.taskId,
    attemptId: attempt.attempt_id,
    kind: "final_prompt",
    content: `${preamble}\n\n${priorBrief}`,
    extension: "md",
  });
  deps.db
    .query(
      `UPDATE tasks
          SET state = 'queued',
              tick_error = NULL,
              updated_at = ?
        WHERE task_id = ? AND cancel_requested_at IS NULL`,
    )
    .run(deps.clock.nowISO(), input.taskId);
  return attempt.attempt_id;
}

function ensureRetryTemplate(
  db: DB,
  clock: Clock,
  kind: BudgetRetryReason,
): { template_id: number; body: string } {
  const existing = db
    .query<{ template_id: number; body: string }, [string]>(
      `SELECT template_id, body FROM retry_templates
        WHERE kind = ?
        ORDER BY template_id DESC
        LIMIT 1`,
    )
    .get(kind);
  if (existing) return existing;

  const inserted = db
    .query<{ template_id: number; body: string }, [string, string, string]>(
      `INSERT INTO retry_templates (kind, body, created_at)
       VALUES (?, ?, ?)
       RETURNING template_id, body`,
    )
    .get(kind, DEFAULT_RETRY_TEMPLATES[kind], clock.nowISO());
  if (!inserted) throw new Error("retry template insert returned no row");
  return inserted;
}

function loadMostRecentBrief(db: DB, taskId: string): string {
  const row = db
    .query<{ file_path: string }, [string]>(
      `SELECT file_path FROM artifacts
        WHERE task_id = ? AND kind = 'brief'
        ORDER BY artifact_id DESC
        LIMIT 1`,
    )
    .get(taskId);
  if (!row) return "(No prior brief artifact was recorded.)";
  try {
    return readFileSync(row.file_path, "utf8");
  } catch {
    return "(Prior brief artifact file was missing or unreadable.)";
  }
}

function loadMostRecentWorkerBrief(db: DB, taskId: string): string {
  const row = db
    .query<{ file_path: string }, [string]>(
      `SELECT ar.file_path
         FROM artifacts ar
         JOIN attempts a ON a.attempt_id = ar.attempt_id
        WHERE ar.task_id = ?
          AND ar.kind = 'brief'
          AND a.reason <> 'review_only'
        ORDER BY ar.artifact_id DESC
        LIMIT 1`,
    )
    .get(taskId);
  if (!row) return "(No prior brief artifact was recorded.)";
  try {
    return readFileSync(row.file_path, "utf8");
  } catch {
    return "(Prior brief artifact file was missing or unreadable.)";
  }
}
