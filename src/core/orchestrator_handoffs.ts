import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";

export type OrchestratorHandoffReason =
  | "worker_blocker"
  | "budget_exhausted"
  | "human_reply_ingested"
  | "manual_resume"
  | "no_progress";

export type OrchestratorHandoffStatus =
  | "pending"
  | "claimed"
  | "completed"
  | "cancelled";

export interface OrchestratorHandoffRow {
  handoff_id: number;
  task_id: string;
  reason: OrchestratorHandoffReason;
  state_event_id: number;
  idempotency_key: string;
  payload_json: string | null;
  status: OrchestratorHandoffStatus;
  claim_id: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  next_eligible_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface HandoffDeps {
  db: DB;
  clock: Clock;
}

export function enqueueOrchestratorHandoff(
  deps: HandoffDeps,
  input: {
    taskId: string;
    reason: OrchestratorHandoffReason;
    stateEventId: number;
    payload?: unknown;
  },
): number {
  const now = deps.clock.nowISO();
  const idempotencyKey = `${input.taskId}:${input.stateEventId}:${input.reason}`;
  const payloadJson =
    input.payload === undefined ? null : JSON.stringify(input.payload);

  const inserted = deps.db
    .query<
      { handoff_id: number },
      [string, string, number, string, string | null, string, string]
    >(
      `INSERT INTO orchestrator_handoffs (
         task_id, reason, state_event_id, idempotency_key,
         payload_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(idempotency_key) DO NOTHING
       RETURNING handoff_id`,
    )
    .get(
      input.taskId,
      input.reason,
      input.stateEventId,
      idempotencyKey,
      payloadJson,
      now,
      now,
    );
  if (inserted) return inserted.handoff_id;

  const existing = deps.db
    .query<{ handoff_id: number }, [string]>(
      `SELECT handoff_id
         FROM orchestrator_handoffs
        WHERE idempotency_key = ?`,
    )
    .get(idempotencyKey);
  if (!existing) {
    throw new Error(`handoff insert failed for ${idempotencyKey}`);
  }
  return existing.handoff_id;
}

export function claimPendingOrchestratorHandoffs(
  deps: HandoffDeps,
  input: { taskId: string; claimId: string },
): number {
  const now = deps.clock.nowISO();
  const res = deps.db
    .query(
      `UPDATE orchestrator_handoffs
          SET status = 'claimed',
              claim_id = ?,
              claimed_at = ?,
              next_eligible_at = NULL,
              updated_at = ?
        WHERE task_id = ?
          AND status = 'pending'`,
    )
    .run(input.claimId, now, now, input.taskId);
  return (res as { changes?: number }).changes ?? 0;
}

export function reopenClaimedOrchestratorHandoffs(
  deps: HandoffDeps,
  input: {
    taskId: string;
    claimId?: string | null;
    nextEligibleAt?: string | null;
  },
): number {
  const now = deps.clock.nowISO();
  const res = deps.db
    .query(
      `UPDATE orchestrator_handoffs
          SET status = 'pending',
              claim_id = NULL,
              claimed_at = NULL,
              next_eligible_at = ?,
              updated_at = ?
        WHERE task_id = ?
          AND status = 'claimed'
          AND (? IS NULL OR claim_id = ?)`,
    )
    .run(
      input.nextEligibleAt ?? null,
      now,
      input.taskId,
      input.claimId ?? null,
      input.claimId ?? null,
    );
  return (res as { changes?: number }).changes ?? 0;
}

export function completeClaimedOrchestratorHandoffs(
  deps: HandoffDeps,
  input: { taskId: string; claimId: string },
): number {
  const now = deps.clock.nowISO();
  const res = deps.db
    .query(
      `UPDATE orchestrator_handoffs
          SET status = 'completed',
              completed_at = ?,
              updated_at = ?
        WHERE task_id = ?
          AND status = 'claimed'
          AND claim_id = ?`,
    )
    .run(now, now, input.taskId, input.claimId);
  return (res as { changes?: number }).changes ?? 0;
}

export function cancelOpenOrchestratorHandoffs(
  deps: HandoffDeps,
  taskId: string,
): number {
  const now = deps.clock.nowISO();
  const res = deps.db
    .query(
      `UPDATE orchestrator_handoffs
          SET status = 'cancelled',
              completed_at = ?,
              updated_at = ?
        WHERE task_id = ?
          AND status IN ('pending', 'claimed')`,
    )
    .run(now, now, taskId);
  return (res as { changes?: number }).changes ?? 0;
}

export function listOrchestratorHandoffs(
  db: DB,
  filters: {
    status?: OrchestratorHandoffStatus;
    taskId?: string;
    eligibleAtOrBefore?: string;
    includeIneligible?: boolean;
  } = {},
): OrchestratorHandoffRow[] {
  const eligibleAtOrBefore =
    filters.eligibleAtOrBefore ?? new Date().toISOString();
  const includeIneligible = filters.includeIneligible === true ? 1 : 0;
  return db
    .query<
      OrchestratorHandoffRow,
      [
        OrchestratorHandoffStatus | null,
        OrchestratorHandoffStatus | null,
        string | null,
        string | null,
        number,
        string,
      ]
    >(
      `SELECT handoff_id, task_id, reason, state_event_id, idempotency_key,
              payload_json, status, claim_id, claimed_at, completed_at,
              next_eligible_at, created_at, updated_at
         FROM orchestrator_handoffs
        WHERE (? IS NULL OR status = ?)
          AND (? IS NULL OR task_id = ?)
          AND (
            ? = 1
            OR status != 'pending'
            OR next_eligible_at IS NULL
            OR next_eligible_at <= ?
          )
        ORDER BY created_at ASC, handoff_id ASC`,
    )
    .all(
      filters.status ?? null,
      filters.status ?? null,
      filters.taskId ?? null,
      filters.taskId ?? null,
      includeIneligible,
      eligibleAtOrBefore,
    );
}
