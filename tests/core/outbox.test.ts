import { afterEach, expect, test } from "bun:test";
import {
  claimOutboxItem,
  completeOutboxItem,
  enqueueOutboxItem,
  failOutboxItem,
  listOutboxItems,
} from "../../src/core/outbox.ts";
import {
  claimPendingOrchestratorHandoffs,
  completeClaimedOrchestratorHandoffs,
  enqueueOrchestratorHandoff,
} from "../../src/core/orchestrator_handoffs.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertRepo, insertTask } from "../support/fixtures.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("outbox enqueue is idempotent by Quay idempotency key", () => {
  h = createHarness();
  const taskId = insertTask(h.db, {
    repoId: insertRepo(h.db, "repo-outbox-idempotent"),
    taskId: "task-outbox-idempotent",
  });

  const first = enqueueOutboxItem(
    { db: h.db, clock: h.clock },
    {
      taskId,
      kind: "slack.pr_ready_approved",
      handlerClass: "delivery",
      idempotencyKey: `${taskId}:ready-approved:sha-1`,
      payload: { pr_number: 12 },
      routeHint: { thread_ref: "C123:1700000000.000000" },
    },
  );
  const second = enqueueOutboxItem(
    { db: h.db, clock: h.clock },
    {
      taskId,
      kind: "slack.pr_ready_approved",
      handlerClass: "delivery",
      idempotencyKey: `${taskId}:ready-approved:sha-1`,
      payload: { pr_number: 12 },
      routeHint: { thread_ref: "C123:1700000000.000000" },
    },
  );

  expect(second).toBe(first);
  const rows = listOutboxItems(h.db, {
    status: "pending",
    handlerClass: "delivery",
    eligibleAtOrBefore: h.clock.nowISO(),
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    outbox_item_id: first,
    task_id: taskId,
    kind: "slack.pr_ready_approved",
    handler_class: "delivery",
    idempotency_key: `${taskId}:ready-approved:sha-1`,
    status: "pending",
  });
  expect(JSON.parse(rows[0]!.payload_json!)).toEqual({ pr_number: 12 });
  expect(JSON.parse(rows[0]!.route_hint_json!)).toEqual({
    thread_ref: "C123:1700000000.000000",
  });
});

test("outbox fail records error and reopens item for retry after cooldown", () => {
  h = createHarness();
  h.clock.set("2026-05-22T10:00:00.000Z");
  const taskId = insertTask(h.db, {
    repoId: insertRepo(h.db, "repo-outbox-retry"),
    taskId: "task-outbox-retry",
  });
  const outboxItemId = enqueueOutboxItem(
    { db: h.db, clock: h.clock },
    {
      taskId,
      kind: "slack.pr_ready_approved",
      handlerClass: "delivery",
      payload: { pr_number: 44 },
    },
  );

  const claimed = claimOutboxItem(
    { db: h.db, clock: h.clock },
    { outboxItemId, claimId: "claim-retry-1" },
  );
  expect(claimed.ok).toBe(true);

  const failed = failOutboxItem(
    { db: h.db, clock: h.clock },
    {
      outboxItemId,
      claimId: "claim-retry-1",
      lastError: "slack timeout",
      nextEligibleAt: "2026-05-22T10:15:00.000Z",
    },
  );
  expect(failed).toEqual({
    ok: true,
    value: {
      outbox_item_id: outboxItemId,
      task_id: taskId,
      kind: "slack.pr_ready_approved",
      handler_class: "delivery",
      status: "pending",
      last_error: "slack timeout",
      next_eligible_at: "2026-05-22T10:15:00.000Z",
    },
  });

  expect(
    listOutboxItems(h.db, {
      status: "pending",
      eligibleAtOrBefore: h.clock.nowISO(),
    }),
  ).toEqual([]);

  h.clock.set("2026-05-22T10:15:00.000Z");
  const retried = claimOutboxItem(
    { db: h.db, clock: h.clock },
    { outboxItemId, claimId: "claim-retry-2" },
  );
  expect(retried.ok).toBe(true);
  expect(retried.ok ? retried.value.claim_id : "").toBe("claim-retry-2");
});

test("outbox fail validates retry timestamp and stores canonical UTC instant", () => {
  h = createHarness();
  h.clock.set("2026-05-22T10:00:00.000Z");
  const taskId = insertTask(h.db, {
    repoId: insertRepo(h.db, "repo-outbox-timestamp"),
    taskId: "task-outbox-timestamp",
  });
  const outboxItemId = enqueueOutboxItem(
    { db: h.db, clock: h.clock },
    {
      taskId,
      kind: "slack.pr_ready_approved",
      handlerClass: "delivery",
    },
  );
  const claimed = claimOutboxItem(
    { db: h.db, clock: h.clock },
    { outboxItemId, claimId: "claim-time" },
  );
  expect(claimed.ok).toBe(true);

  const invalid = failOutboxItem(
    { db: h.db, clock: h.clock },
    {
      outboxItemId,
      claimId: "claim-time",
      lastError: "bad timestamp",
      nextEligibleAt: "tomorrow",
    },
  );
  expect(invalid).toMatchObject({
    ok: false,
    error: { code: "validation_error" },
  });

  const failed = failOutboxItem(
    { db: h.db, clock: h.clock },
    {
      outboxItemId,
      claimId: "claim-time",
      lastError: "retry later",
      nextEligibleAt: "2026-05-22T12:15:00+02:00",
    },
  );
  expect(failed).toMatchObject({
    ok: true,
    value: {
      next_eligible_at: "2026-05-22T10:15:00.000Z",
    },
  });
});

test("delivery outbox completion marks delivered without changing task state", () => {
  h = createHarness();
  h.clock.set("2026-05-22T12:00:00.000Z");
  const taskId = insertTask(h.db, {
    repoId: insertRepo(h.db, "repo-outbox-delivery"),
    taskId: "task-outbox-delivery",
    state: "pr-open",
  });
  const outboxItemId = enqueueOutboxItem(
    { db: h.db, clock: h.clock },
    {
      taskId,
      kind: "slack.pr_ready_approved",
      handlerClass: "delivery",
    },
  );
  const claimed = claimOutboxItem(
    { db: h.db, clock: h.clock },
    { outboxItemId, claimId: "claim-delivery" },
  );
  expect(claimed.ok).toBe(true);

  h.clock.set("2026-05-22T12:01:00.000Z");
  const completed = completeOutboxItem(
    { db: h.db, clock: h.clock },
    { outboxItemId, claimId: "claim-delivery" },
  );

  expect(completed).toEqual({
    ok: true,
    value: {
      outbox_item_id: outboxItemId,
      task_id: taskId,
      kind: "slack.pr_ready_approved",
      handler_class: "delivery",
      status: "completed",
      delivered_at: "2026-05-22T12:01:00.000Z",
      completed_at: "2026-05-22T12:01:00.000Z",
    },
  });
  const task = h.db
    .query<{ state: string }, [string]>("SELECT state FROM tasks WHERE task_id = ?")
    .get(taskId);
  expect(task?.state).toBe("pr-open");
});

test("generic outbox mutations reject workflow intervention rows", () => {
  h = createHarness();
  const taskId = insertTask(h.db, {
    repoId: insertRepo(h.db, "repo-outbox-workflow-guard"),
    taskId: "task-outbox-workflow-guard",
    state: "awaiting-next-brief",
  });
  const eventId = insertAwaitingEvent(taskId);
  const handoffId = enqueueOrchestratorHandoff(
    { db: h.db, clock: h.clock },
    { taskId, reason: "worker_blocker", stateEventId: eventId },
  );
  const outboxItemId = h.db
    .query<{ outbox_item_id: number }, [number]>(
      `SELECT outbox_item_id
         FROM orchestrator_handoffs
        WHERE handoff_id = ?`,
    )
    .get(handoffId)!.outbox_item_id;

  const claim = claimOutboxItem(
    { db: h.db, clock: h.clock },
    { outboxItemId, claimId: "generic-claim" },
  );
  expect(claim).toMatchObject({
    ok: false,
    error: { code: "validation_error" },
  });
  expect(singleOutboxStatus(outboxItemId)).toMatchObject({
    status: "pending",
    claim_id: null,
  });

  claimPendingOrchestratorHandoffs(
    { db: h.db, clock: h.clock },
    { taskId, claimId: "handoff-claim" },
  );
  const complete = completeOutboxItem(
    { db: h.db, clock: h.clock },
    { outboxItemId, claimId: "handoff-claim" },
  );
  const failed = failOutboxItem(
    { db: h.db, clock: h.clock },
    {
      outboxItemId,
      claimId: "handoff-claim",
      lastError: "wrong consumer",
    },
  );
  expect(complete).toMatchObject({
    ok: false,
    error: { code: "validation_error" },
  });
  expect(failed).toMatchObject({
    ok: false,
    error: { code: "validation_error" },
  });
  expect(singleOutboxStatus(outboxItemId)).toMatchObject({
    status: "claimed",
    claim_id: "handoff-claim",
  });
});

test("orchestrator handoff compatibility creates and syncs workflow outbox item", () => {
  h = createHarness();
  const taskId = insertTask(h.db, {
    repoId: insertRepo(h.db, "repo-outbox-handoff"),
    taskId: "task-outbox-handoff",
    state: "awaiting-next-brief",
  });
  const eventId = insertAwaitingEvent(taskId);

  const handoffId = enqueueOrchestratorHandoff(
    { db: h.db, clock: h.clock },
    {
      taskId,
      reason: "worker_blocker",
      stateEventId: eventId,
      payload: { artifact_id: 99 },
    },
  );

  const handoff = h.db
    .query<
      { outbox_item_id: number | null; payload_json: string | null },
      [number]
    >(
      `SELECT outbox_item_id, payload_json
         FROM orchestrator_handoffs
        WHERE handoff_id = ?`,
    )
    .get(handoffId);
  expect(handoff?.outbox_item_id).toBeGreaterThan(0);

  const outbox = listOutboxItems(h.db, {
    status: "pending",
    eligibleAtOrBefore: h.clock.nowISO(),
  });
  expect(outbox).toHaveLength(1);
  expect(outbox[0]).toMatchObject({
    outbox_item_id: handoff!.outbox_item_id,
    task_id: taskId,
    kind: "workflow_intervention.worker_blocker",
    handler_class: "workflow_intervention",
    source_event_id: eventId,
    status: "pending",
  });

  claimPendingOrchestratorHandoffs(
    { db: h.db, clock: h.clock },
    { taskId, claimId: "claim-handoff" },
  );
  expect(singleOutboxStatus(handoff!.outbox_item_id!)).toMatchObject({
    status: "claimed",
    claim_id: "claim-handoff",
  });

  completeClaimedOrchestratorHandoffs(
    { db: h.db, clock: h.clock },
    { taskId, claimId: "claim-handoff" },
  );
  expect(singleOutboxStatus(handoff!.outbox_item_id!)).toMatchObject({
    status: "completed",
    claim_id: "claim-handoff",
  });
});

function insertAwaitingEvent(taskId: string): number {
  if (!h) throw new Error("missing harness");
  const row = h.db
    .query<{ event_id: number }, [string, string]>(
      `INSERT INTO events (
         task_id, event_type, from_state, to_state, occurred_at
       ) VALUES (?, 'blocker_ingested', 'running', 'awaiting-next-brief', ?)
       RETURNING event_id`,
    )
    .get(taskId, h.clock.nowISO());
  if (!row) throw new Error("event insert returned no row");
  return row.event_id;
}

function singleOutboxStatus(outboxItemId: number) {
  if (!h) throw new Error("missing harness");
  const row = h.db
    .query<{ status: string; claim_id: string | null }, [number]>(
      `SELECT status, claim_id
         FROM outbox_items
        WHERE outbox_item_id = ?`,
    )
    .get(outboxItemId);
  if (!row) throw new Error("missing outbox item");
  return row;
}
