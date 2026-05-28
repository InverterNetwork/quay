import type { SQLQueryBindings } from "bun:sqlite";
import type { DB } from "../db/connection.ts";

export const TASK_STATES = [
  "queued",
  "running",
  "goal-completion-pending",
  "pr-open",
  "pr-review",
  "done",
  "awaiting-next-brief",
  "claimed-by-orchestrator",
  "waiting_human",
  "waiting_external_changes",
  "non_budget_loop",
  "worktree_error",
  "orchestrator_loop",
  "cancelled",
  "merged",
  "closed_unmerged",
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export interface TaskTransition {
  from: TaskState;
  to: TaskState;
  eventTypes: readonly string[];
  description: string;
}

const TERMINAL_FROM_STATES = [
  "queued",
  "running",
  "goal-completion-pending",
  "pr-open",
  "pr-review",
  "done",
  "awaiting-next-brief",
  "claimed-by-orchestrator",
  "waiting_human",
  "waiting_external_changes",
  "non_budget_loop",
  "worktree_error",
  "orchestrator_loop",
] as const satisfies readonly TaskState[];

const CANCEL_FROM_STATES = [
  ...TERMINAL_FROM_STATES,
  "merged",
  "closed_unmerged",
] as const satisfies readonly TaskState[];

export const TASK_TRANSITIONS = [
  transition("queued", "running", ["spawned"], "worker attempt spawned"),
  transition(
    "queued",
    "queued",
    ["pr_adopted"],
    "existing external PR adopted for code-worker ownership",
  ),
  transition(
    "running",
    "queued",
    [
      "blocker_resolved",
      "ci_failed",
      "complete_without_delivery",
      "goal_continuation_scheduled",
      "goal_completion_rejected",
      "malformed_goal_report_ingested",
      "malformed_signal_ingested",
      "no_progress",
      "retry_scheduled",
      "spawn_failed",
    ],
    "worker retry scheduled",
  ),
  transition(
    "running",
    "awaiting-next-brief",
    [
      "blocker_ingested",
      "budget_exhausted",
      "goal_budget_limited",
      "goal_no_progress",
      "malformed_goal_report_repair_exhausted",
    ],
    "worker needs orchestrator input",
  ),
  transition(
    "running",
    "goal-completion-pending",
    ["goal_completion_pending"],
    "goal worker reported completion for audit",
  ),
  transition(
    "running",
    "pr-open",
    ["existing_pr_attached", "pr_opened"],
    "worker produced or attached a PR",
  ),
  transition(
    "running",
    "worktree_error",
    ["worktree_error"],
    "worker worktree became unusable",
  ),
  transition(
    "pr-open",
    "done",
    ["ci_passed"],
    "PR checks passed and task is ready for review",
  ),
  transition(
    "pr-open",
    "pr-review",
    ["review_requested"],
    "reviewer attempt requested for a Quay-owned PR",
  ),
  transition(
    "done",
    "pr-review",
    ["review_requested"],
    "reviewer attempt requested after CI-ready state",
  ),
  transition(
    "pr-review",
    "pr-review",
    ["review_infra_failed", "review_requested", "review_spawned"],
    "review attempt retried or observed without changing task state",
  ),
  transition(
    "waiting_external_changes",
    "pr-review",
    ["review_requested"],
    "external PR changes are ready for another synthetic review",
  ),
  transition(
    "waiting_external_changes",
    "queued",
    ["pr_adopted"],
    "external PR adopted for code-worker ownership",
  ),
  transition(
    "waiting_external_changes",
    "pr-open",
    ["pr_adopted"],
    "external PR adopted for PR polling",
  ),
  transition(
    "pr-review",
    "pr-open",
    ["pr_adopted"],
    "external PR adopted for PR polling",
  ),
  transition(
    "done",
    "pr-open",
    ["pr_adopted"],
    "adopted PR returned to open PR polling",
  ),
  transition(
    "waiting_external_changes",
    "done",
    ["pr_adopted_ready"],
    "external PR adopted with green CI and no current requested changes",
  ),
  transition(
    "pr-review",
    "done",
    ["pr_adopted_ready"],
    "external PR adopted with green CI and no current requested changes",
  ),
  transition(
    "pr-review",
    "pr-open",
    ["ci_failed", "review_approved", "review_superseded"],
    "review returned to PR polling",
  ),
  transition(
    "pr-review",
    "done",
    ["review_approved"],
    "synthetic reviewer approved PR",
  ),
  transition(
    "pr-review",
    "waiting_external_changes",
    ["changes_requested"],
    "review requested external changes",
  ),
  transition(
    "pr-review",
    "non_budget_loop",
    ["non_budget_loop_parked", "review_infra_failed"],
    "review path parked after non-budget retries",
  ),
  transition(
    "done",
    "queued",
    [
      "ci_failed",
      "conflict_respawn_scheduled",
      "pr_adopted",
      "review_respawn_scheduled",
    ],
    "post-ready evidence required another worker pass",
  ),
  transition(
    "pr-open",
    "queued",
    ["ci_failed", "conflict_respawn_scheduled", "review_respawn_scheduled"],
    "open PR evidence required another worker pass",
  ),
  transition(
    "pr-review",
    "queued",
    ["ci_failed", "pr_adopted", "review_respawn_scheduled"],
    "review evidence required another worker pass",
  ),
  transition(
    "goal-completion-pending",
    "pr-open",
    ["goal_completion_accepted"],
    "goal completion audit accepted delivery",
  ),
  transition(
    "goal-completion-pending",
    "queued",
    ["goal_completion_rejected"],
    "goal completion audit requested more work",
  ),
  transition(
    "goal-completion-pending",
    "awaiting-next-brief",
    ["goal_budget_limited"],
    "goal completion audit exhausted goal budget",
  ),
  transition(
    "awaiting-next-brief",
    "claimed-by-orchestrator",
    ["claimed"],
    "orchestrator claimed human/brief handoff",
  ),
  transition(
    "claimed-by-orchestrator",
    "awaiting-next-brief",
    ["claim_expired", "claim_released"],
    "orchestrator claim returned to pending handoff",
  ),
  transition(
    "claimed-by-orchestrator",
    "queued",
    ["brief_submitted"],
    "orchestrator submitted the next worker brief",
  ),
  transition(
    "claimed-by-orchestrator",
    "waiting_human",
    ["human_escalated"],
    "orchestrator asked a human for input",
  ),
  transition(
    "waiting_human",
    "claimed-by-orchestrator",
    ["human_reply_recorded"],
    "human reply restored an orchestrator claim",
  ),
  transition(
    "waiting_human",
    "awaiting-next-brief",
    ["slack_reply_ingested", "waiting_human_requeued"],
    "human wait became eligible for orchestrator handoff",
  ),
  transition(
    "claimed-by-orchestrator",
    "orchestrator_loop",
    ["claim_expired", "orchestrator_loop_parked"],
    "orchestrator claim repeatedly expired",
  ),
  ...TERMINAL_FROM_STATES.flatMap((from) => [
    transition(from, "merged", ["merged"], "PR reached merged terminal state"),
    transition(
      from,
      "closed_unmerged",
      ["closed"],
      "PR reached closed-unmerged terminal state",
    ),
  ]),
  ...CANCEL_FROM_STATES.map((from) =>
    transition(
      from,
      "cancelled",
      ["cancelled", "retargeted"],
      "operator cancelled or retargeted task",
    ),
  ),
] as const satisfies readonly TaskTransition[];

export type TransitionMode = "strict" | "idempotent";

export interface TransitionTaskStateDeps {
  db: DB;
}

export interface TaskTransitionPrMetadata {
  number?: number | null;
  url?: string | null;
  headSha?: string | null;
  baseSha?: string | null;
  coalesce?: "input" | "existing";
  numberCoalesce?: "input" | "existing";
  urlCoalesce?: "input" | "existing";
  headShaCoalesce?: "input" | "existing";
  baseShaCoalesce?: "input" | "existing";
}

export interface TaskTransitionUpdates {
  clearTickError?: boolean;
  tickError?: string | null;
  clearClaim?: boolean;
  setClaim?: { claimId: string; claimedAt: string };
  resetClaimExpirations?: boolean;
  claimExpirationsConsecutive?: number;
  incrementAttemptsConsumedBy?: number;
  resetSpawnFailures?: boolean;
  budgetExhausted?: 0 | 1;
  pr?: TaskTransitionPrMetadata;
}

export interface TaskTransitionGuards {
  claimId?: string;
  prNumberIsNull?: boolean;
}

export interface TransitionTaskStateInput {
  taskId: string;
  from: TaskState;
  to: TaskState;
  eventType: string;
  attemptId?: number | null;
  payloadArtifactId?: number | null;
  eventData?: unknown;
  now: string;
  mode?: TransitionMode;
  updates?: TaskTransitionUpdates;
  guards?: TaskTransitionGuards;
  respectCancelRequest?: boolean;
}

export type TransitionResult =
  | { applied: true; from: TaskState; to: TaskState; eventId: number }
  | {
      applied: false;
      reason: "wrong_state" | "cancelled" | "already_in_target";
      currentState: string | null;
    };

export class InvalidTaskTransitionError extends Error {
  constructor(from: TaskState, to: TaskState, eventType: string) {
    super(`invalid task transition: ${from} -> ${to} via ${eventType}`);
    this.name = "InvalidTaskTransitionError";
  }
}

const TASK_STATE_SET = new Set<string>(TASK_STATES);
const SAVEPOINT = "task_state_transition";

export function isTaskState(value: string): value is TaskState {
  return TASK_STATE_SET.has(value);
}

export function assertTaskState(value: string): asserts value is TaskState {
  if (!isTaskState(value)) {
    throw new Error(`unknown task state: ${value}`);
  }
}

export function transitionTaskState(
  deps: TransitionTaskStateDeps,
  input: TransitionTaskStateInput,
): TransitionResult {
  assertAllowedTransition(input.from, input.to, input.eventType);

  deps.db.exec(`SAVEPOINT ${SAVEPOINT}`);
  try {
    const result = applyTransition(deps.db, input);
    deps.db.exec(`RELEASE ${SAVEPOINT}`);
    return result;
  } catch (err) {
    try {
      deps.db.exec(`ROLLBACK TO ${SAVEPOINT}`);
    } finally {
      deps.db.exec(`RELEASE ${SAVEPOINT}`);
    }
    throw err;
  }
}

function applyTransition(db: DB, input: TransitionTaskStateInput): TransitionResult {
  const update = buildTaskUpdate(input);
  const upd = db.query(update.sql).run(...update.params);
  const changes = (upd as { changes?: number }).changes ?? 0;
  if (changes === 0) return transitionMiss(db, input);

  const eventData = serializeEventData(input.eventData);
  const event = db
    .query<{ event_id: number }, SQLQueryBindings[]>(
      `INSERT INTO events (
         task_id, attempt_id, event_type, from_state, to_state,
         payload_artifact_id, occurred_at, event_data
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING event_id`,
    )
    .get(
      input.taskId,
      input.attemptId ?? null,
      input.eventType,
      input.from,
      input.to,
      input.payloadArtifactId ?? null,
      input.now,
      eventData,
    );
  if (!event) throw new Error("task transition event insert returned no row");
  return { applied: true, from: input.from, to: input.to, eventId: event.event_id };
}

function buildTaskUpdate(input: TransitionTaskStateInput): {
  sql: string;
  params: SQLQueryBindings[];
} {
  const updates = input.updates ?? {};
  const setSql = ["state = ?", "updated_at = ?"];
  const params: SQLQueryBindings[] = [input.to, input.now];

  if (updates.clearTickError) {
    setSql.push("tick_error = NULL");
  }
  if (Object.hasOwn(updates, "tickError")) {
    setSql.push("tick_error = ?");
    params.push(updates.tickError ?? null);
  }
  if (updates.clearClaim) {
    setSql.push("claim_id = NULL", "claimed_at = NULL");
  }
  if (updates.setClaim) {
    setSql.push("claim_id = ?", "claimed_at = ?");
    params.push(updates.setClaim.claimId, updates.setClaim.claimedAt);
  }
  if (updates.resetClaimExpirations) {
    setSql.push("claim_expirations_consecutive = 0");
  }
  if (updates.claimExpirationsConsecutive !== undefined) {
    setSql.push("claim_expirations_consecutive = ?");
    params.push(updates.claimExpirationsConsecutive);
  }
  if (updates.incrementAttemptsConsumedBy !== undefined) {
    setSql.push("attempts_consumed = attempts_consumed + ?");
    params.push(updates.incrementAttemptsConsumedBy);
  }
  if (updates.resetSpawnFailures) {
    setSql.push("spawn_failures_consecutive = 0");
  }
  if (updates.budgetExhausted !== undefined) {
    setSql.push("budget_exhausted = ?");
    params.push(updates.budgetExhausted);
  }
  if (updates.pr) {
    appendPrMetadataUpdate(setSql, params, updates.pr);
  }

  const whereSql = ["task_id = ?", "state = ?"];
  params.push(input.taskId, input.from);

  if (input.respectCancelRequest !== false) {
    whereSql.push("cancel_requested_at IS NULL");
  }
  if (input.guards?.claimId !== undefined) {
    whereSql.push("claim_id = ?");
    params.push(input.guards.claimId);
  }
  if (input.guards?.prNumberIsNull) {
    whereSql.push("pr_number IS NULL");
  }

  return {
    sql: `UPDATE tasks SET ${setSql.join(", ")} WHERE ${whereSql.join(" AND ")}`,
    params,
  };
}

function appendPrMetadataUpdate(
  setSql: string[],
  params: SQLQueryBindings[],
  pr: TaskTransitionPrMetadata,
): void {
  const col = (
    name: string,
    value: SQLQueryBindings | undefined,
    coalesce: "input" | "existing" | undefined,
  ): void => {
    if (value === undefined) return;
    if (coalesce === "input") {
      setSql.push(`${name} = COALESCE(?, ${name})`);
    } else if (coalesce === "existing") {
      setSql.push(`${name} = COALESCE(${name}, ?)`);
    } else {
      setSql.push(`${name} = ?`);
    }
    params.push(value);
  };
  col("pr_number", pr.number, pr.numberCoalesce ?? pr.coalesce);
  col("pr_url", pr.url, pr.urlCoalesce ?? pr.coalesce);
  col("head_sha", pr.headSha, pr.headShaCoalesce ?? pr.coalesce);
  col("base_sha", pr.baseSha, pr.baseShaCoalesce ?? pr.coalesce);
}

function transitionMiss(db: DB, input: TransitionTaskStateInput): TransitionResult {
  const row =
    db
      .query<{ state: string; cancel_requested_at: string | null }, [string]>(
        `SELECT state, cancel_requested_at FROM tasks WHERE task_id = ?`,
      )
      .get(input.taskId) ?? null;
  if (row === null) {
    return { applied: false, reason: "wrong_state", currentState: null };
  }
  if (input.respectCancelRequest !== false && row.cancel_requested_at !== null) {
    return { applied: false, reason: "cancelled", currentState: row.state };
  }
  if (
    (input.mode ?? "strict") === "idempotent" &&
    input.from !== input.to &&
    row.state === input.to
  ) {
    return { applied: false, reason: "already_in_target", currentState: row.state };
  }
  return { applied: false, reason: "wrong_state", currentState: row.state };
}

function serializeEventData(eventData: unknown): string | null {
  if (eventData === undefined || eventData === null) return null;
  if (typeof eventData === "string") return eventData;
  return JSON.stringify(eventData);
}

function assertAllowedTransition(
  from: TaskState,
  to: TaskState,
  eventType: string,
): void {
  const allowed = TASK_TRANSITIONS.some(
    (transition) =>
      transition.from === from &&
      transition.to === to &&
      transition.eventTypes.includes(eventType),
  );
  if (!allowed) throw new InvalidTaskTransitionError(from, to, eventType);
}

function transition(
  from: TaskState,
  to: TaskState,
  eventTypes: readonly string[],
  description: string,
): TaskTransition {
  return { from, to, eventTypes, description };
}
