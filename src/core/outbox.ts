import { randomUUID } from "node:crypto";
import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";

export type OutboxHandlerClass = "workflow_intervention" | "delivery";
export type OutboxStatus = "pending" | "claimed" | "completed" | "cancelled";

export interface OutboxItemRow {
  outbox_item_id: number;
  task_id: string;
  kind: string;
  handler_class: OutboxHandlerClass;
  source_event_id: number | null;
  idempotency_key: string;
  payload_json: string | null;
  route_hint_json: string | null;
  status: OutboxStatus;
  claim_id: string | null;
  claimed_at: string | null;
  delivered_at: string | null;
  completed_at: string | null;
  last_error: string | null;
  next_eligible_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OutboxDeps {
  db: DB;
  clock: Clock;
}

export type OutboxErrorCode =
  | "unknown_outbox_item"
  | "wrong_state"
  | "claim_lost"
  | "validation_error";

export interface OutboxError {
  code: OutboxErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type OutboxResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: OutboxError };

export interface ClaimOutboxItemResult {
  outbox_item_id: number;
  task_id: string;
  kind: string;
  handler_class: OutboxHandlerClass;
  status: "claimed";
  claim_id: string;
}

export interface CompleteOutboxItemResult {
  outbox_item_id: number;
  task_id: string;
  kind: string;
  handler_class: OutboxHandlerClass;
  status: "completed";
  delivered_at: string | null;
  completed_at: string;
}

export interface FailOutboxItemResult {
  outbox_item_id: number;
  task_id: string;
  kind: string;
  handler_class: OutboxHandlerClass;
  status: "pending";
  last_error: string;
  next_eligible_at: string | null;
}

function fail(
  code: OutboxErrorCode,
  message: string,
  details?: Record<string, unknown>,
): OutboxResult<never> {
  const error = details === undefined
    ? { code, message }
    : { code, message, details };
  return { ok: false, error };
}

function stringifyJson(value: unknown | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function rejectWorkflowMutation(
  row: OutboxItemRow,
  verb: string,
): OutboxResult<never> | null {
  if (row.handler_class === "delivery") return null;
  return fail(
    "validation_error",
    `outbox ${verb} only supports delivery items; use task claim/handoff commands for workflow_intervention items`,
    { outbox_item_id: row.outbox_item_id, handler_class: row.handler_class },
  );
}

function normalizeIsoInstant(
  value: string | null | undefined,
  fieldName: string,
): OutboxResult<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  const isoInstantPattern =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
  const millis = Date.parse(value);
  if (!isoInstantPattern.test(value) || !Number.isFinite(millis)) {
    return fail(
      "validation_error",
      `${fieldName} must be an ISO-8601 instant`,
      { [fieldName]: value },
    );
  }
  return { ok: true, value: new Date(millis).toISOString() };
}

export function outboxKindForHandoff(reason: string): string {
  return `workflow_intervention.${reason}`;
}

export function defaultOutboxIdempotencyKey(input: {
  taskId: string;
  kind: string;
  sourceEventId?: number | null;
}): string {
  const source = input.sourceEventId === undefined || input.sourceEventId === null
    ? "no-event"
    : String(input.sourceEventId);
  return `${input.taskId}:${source}:${input.kind}`;
}

export function enqueueOutboxItem(
  deps: OutboxDeps,
  input: {
    taskId: string;
    kind: string;
    handlerClass: OutboxHandlerClass;
    sourceEventId?: number | null;
    idempotencyKey?: string;
    payload?: unknown;
    routeHint?: unknown;
    nextEligibleAt?: string | null;
  },
): number {
  const now = deps.clock.nowISO();
  const sourceEventId = input.sourceEventId ?? null;
  const idempotencyKey =
    input.idempotencyKey ??
    defaultOutboxIdempotencyKey({
      taskId: input.taskId,
      kind: input.kind,
      sourceEventId,
    });
  const payloadJson = stringifyJson(input.payload);
  const routeHintJson = stringifyJson(input.routeHint);

  const inserted = deps.db
    .query<
      { outbox_item_id: number },
      [
        string,
        string,
        OutboxHandlerClass,
        number | null,
        string,
        string | null,
        string | null,
        string | null,
        string,
        string,
      ]
    >(
      `INSERT INTO outbox_items (
         task_id, kind, handler_class, source_event_id, idempotency_key,
         payload_json, route_hint_json, next_eligible_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(idempotency_key) DO NOTHING
       RETURNING outbox_item_id`,
    )
    .get(
      input.taskId,
      input.kind,
      input.handlerClass,
      sourceEventId,
      idempotencyKey,
      payloadJson,
      routeHintJson,
      input.nextEligibleAt ?? null,
      now,
      now,
    );
  if (inserted) return inserted.outbox_item_id;

  const existing = deps.db
    .query<{ outbox_item_id: number }, [string]>(
      `SELECT outbox_item_id
         FROM outbox_items
        WHERE idempotency_key = ?`,
    )
    .get(idempotencyKey);
  if (!existing) {
    throw new Error(`outbox insert failed for ${idempotencyKey}`);
  }
  return existing.outbox_item_id;
}

export function listOutboxItems(
  db: DB,
  filters: {
    status?: OutboxStatus;
    taskId?: string;
    kind?: string;
    handlerClass?: OutboxHandlerClass;
    eligibleAtOrBefore: string;
    includeIneligible?: boolean;
  },
): OutboxItemRow[] {
  const includeIneligible = filters.includeIneligible === true ? 1 : 0;
  return db
    .query<
      OutboxItemRow,
      [
        OutboxStatus | null,
        OutboxStatus | null,
        string | null,
        string | null,
        string | null,
        string | null,
        OutboxHandlerClass | null,
        OutboxHandlerClass | null,
        number,
        string,
      ]
    >(
      `SELECT outbox_item_id, task_id, kind, handler_class, source_event_id,
              idempotency_key, payload_json, route_hint_json, status, claim_id,
              claimed_at, delivered_at, completed_at, last_error,
              next_eligible_at, created_at, updated_at
         FROM outbox_items
        WHERE (? IS NULL OR status = ?)
          AND (? IS NULL OR task_id = ?)
          AND (? IS NULL OR kind = ?)
          AND (? IS NULL OR handler_class = ?)
          AND (
            ? = 1
            OR status != 'pending'
            OR next_eligible_at IS NULL
            OR next_eligible_at <= ?
          )
        ORDER BY created_at ASC, outbox_item_id ASC`,
    )
    .all(
      filters.status ?? null,
      filters.status ?? null,
      filters.taskId ?? null,
      filters.taskId ?? null,
      filters.kind ?? null,
      filters.kind ?? null,
      filters.handlerClass ?? null,
      filters.handlerClass ?? null,
      includeIneligible,
      filters.eligibleAtOrBefore,
    );
}

function loadOutboxItem(db: DB, outboxItemId: number): OutboxItemRow | null {
  return (
    db
      .query<OutboxItemRow, [number]>(
        `SELECT outbox_item_id, task_id, kind, handler_class, source_event_id,
                idempotency_key, payload_json, route_hint_json, status, claim_id,
                claimed_at, delivered_at, completed_at, last_error,
                next_eligible_at, created_at, updated_at
           FROM outbox_items
          WHERE outbox_item_id = ?`,
      )
      .get(outboxItemId) ?? null
  );
}

export function claimOutboxItem(
  deps: OutboxDeps,
  input: { outboxItemId: number; claimId?: string },
): OutboxResult<ClaimOutboxItemResult> {
  const claimId = input.claimId ?? randomUUID();
  const now = deps.clock.nowISO();
  deps.db.exec("BEGIN IMMEDIATE");
  try {
    const row = loadOutboxItem(deps.db, input.outboxItemId);
    if (!row) {
      deps.db.exec("ROLLBACK");
      return fail(
        "unknown_outbox_item",
        `outbox item ${input.outboxItemId} not found`,
        { outbox_item_id: input.outboxItemId },
      );
    }
    const classGuard = rejectWorkflowMutation(row, "claim");
    if (classGuard !== null) {
      deps.db.exec("ROLLBACK");
      return classGuard;
    }
    const upd = deps.db
      .query(
        `UPDATE outbox_items
            SET status = 'claimed',
                claim_id = ?,
                claimed_at = ?,
                updated_at = ?
          WHERE outbox_item_id = ?
            AND status = 'pending'
            AND (next_eligible_at IS NULL OR next_eligible_at <= ?)`,
      )
      .run(claimId, now, now, input.outboxItemId, now);
    const changes = (upd as { changes?: number }).changes ?? 0;
    if (changes === 0) {
      deps.db.exec("ROLLBACK");
      return fail(
        "wrong_state",
        `outbox item ${input.outboxItemId} is not eligible pending work`,
        {
          outbox_item_id: input.outboxItemId,
          status: row.status,
          next_eligible_at: row.next_eligible_at,
        },
      );
    }
    const claimed = loadOutboxItem(deps.db, input.outboxItemId);
    if (!claimed) throw new Error("claimed outbox item disappeared");
    deps.db.exec("COMMIT");
    return {
      ok: true,
      value: {
        outbox_item_id: claimed.outbox_item_id,
        task_id: claimed.task_id,
        kind: claimed.kind,
        handler_class: claimed.handler_class,
        status: "claimed",
        claim_id: claimId,
      },
    };
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

export function completeOutboxItem(
  deps: OutboxDeps,
  input: { outboxItemId: number; claimId: string },
): OutboxResult<CompleteOutboxItemResult> {
  const row = loadOutboxItem(deps.db, input.outboxItemId);
  if (!row) {
    return fail(
      "unknown_outbox_item",
      `outbox item ${input.outboxItemId} not found`,
      { outbox_item_id: input.outboxItemId },
    );
  }
  const classGuard = rejectWorkflowMutation(row, "complete");
  if (classGuard !== null) return classGuard;
  if (row.status !== "claimed") {
    return fail("wrong_state", `outbox item ${input.outboxItemId} is ${row.status}`, {
      outbox_item_id: input.outboxItemId,
      status: row.status,
    });
  }
  if (row.claim_id !== input.claimId) {
    return fail(
      "claim_lost",
      `claim_id mismatch on outbox item ${input.outboxItemId}`,
      { outbox_item_id: input.outboxItemId },
    );
  }

  const now = deps.clock.nowISO();
  const deliveredAt = row.handler_class === "delivery" ? now : row.delivered_at;
  const upd = deps.db
    .query(
      `UPDATE outbox_items
          SET status = 'completed',
              delivered_at = ?,
              completed_at = ?,
              last_error = NULL,
              updated_at = ?
        WHERE outbox_item_id = ?
          AND status = 'claimed'
          AND claim_id = ?`,
    )
    .run(deliveredAt, now, now, input.outboxItemId, input.claimId);
  const changes = (upd as { changes?: number }).changes ?? 0;
  if (changes === 0) {
    return fail(
      "claim_lost",
      `claim_id mismatch on outbox item ${input.outboxItemId}`,
      { outbox_item_id: input.outboxItemId },
    );
  }
  return {
    ok: true,
    value: {
      outbox_item_id: row.outbox_item_id,
      task_id: row.task_id,
      kind: row.kind,
      handler_class: row.handler_class,
      status: "completed",
      delivered_at: deliveredAt,
      completed_at: now,
    },
  };
}

export function failOutboxItem(
  deps: OutboxDeps,
  input: {
    outboxItemId: number;
    claimId: string;
    lastError: string;
    nextEligibleAt?: string | null;
  },
): OutboxResult<FailOutboxItemResult> {
  if (input.lastError.trim().length === 0) {
    return fail("validation_error", "outbox fail requires a non-empty error");
  }
  const normalizedNextEligibleAt = normalizeIsoInstant(
    input.nextEligibleAt,
    "next_eligible_at",
  );
  if (!normalizedNextEligibleAt.ok) return normalizedNextEligibleAt;
  const row = loadOutboxItem(deps.db, input.outboxItemId);
  if (!row) {
    return fail(
      "unknown_outbox_item",
      `outbox item ${input.outboxItemId} not found`,
      { outbox_item_id: input.outboxItemId },
    );
  }
  const classGuard = rejectWorkflowMutation(row, "fail");
  if (classGuard !== null) return classGuard;
  if (row.status !== "claimed") {
    return fail("wrong_state", `outbox item ${input.outboxItemId} is ${row.status}`, {
      outbox_item_id: input.outboxItemId,
      status: row.status,
    });
  }
  if (row.claim_id !== input.claimId) {
    return fail(
      "claim_lost",
      `claim_id mismatch on outbox item ${input.outboxItemId}`,
      { outbox_item_id: input.outboxItemId },
    );
  }

  const now = deps.clock.nowISO();
  const nextEligibleAt = normalizedNextEligibleAt.value;
  const upd = deps.db
    .query(
      `UPDATE outbox_items
          SET status = 'pending',
              claim_id = NULL,
              claimed_at = NULL,
              last_error = ?,
              next_eligible_at = ?,
              updated_at = ?
        WHERE outbox_item_id = ?
          AND status = 'claimed'
          AND claim_id = ?`,
    )
    .run(
      input.lastError,
      nextEligibleAt,
      now,
      input.outboxItemId,
      input.claimId,
    );
  const changes = (upd as { changes?: number }).changes ?? 0;
  if (changes === 0) {
    return fail(
      "claim_lost",
      `claim_id mismatch on outbox item ${input.outboxItemId}`,
      { outbox_item_id: input.outboxItemId },
    );
  }
  return {
    ok: true,
    value: {
      outbox_item_id: row.outbox_item_id,
      task_id: row.task_id,
      kind: row.kind,
      handler_class: row.handler_class,
      status: "pending",
      last_error: input.lastError,
      next_eligible_at: nextEligibleAt,
    },
  };
}
