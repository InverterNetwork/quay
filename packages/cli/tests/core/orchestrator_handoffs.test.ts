import { afterEach, expect, test } from "bun:test";
import { createArtifactStore } from "../../src/artifacts/store.ts";
import {
  claim_task,
  escalate_human,
  HUMAN_REPLY_TIMEOUT_HANDOFF_COOLDOWN_SECONDS,
  release_claim,
  submit_brief,
} from "../../src/core/claims.ts";
import {
  enqueueOrchestratorHandoff,
  listOrchestratorHandoffs,
} from "../../src/core/orchestrator_handoffs.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo, insertTask, seedTaskObjective } from "../support/fixtures.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("orchestrator handoff enqueue is idempotent by task event and reason", () => {
  h = createHarness();
  const repoId = insertRepo(h.db, "repo-handoff-idempotent");
  const taskId = insertTask(h.db, {
    taskId: "task-handoff-idempotent",
    repoId,
    state: "awaiting-next-brief",
  });
  seedTaskObjective(h, taskId);
  const eventId = insertAwaitingEvent(taskId, "blocker_ingested");

  const first = enqueueOrchestratorHandoff(
    { db: h.db, clock: h.clock },
    {
      taskId,
      reason: "worker_blocker",
      stateEventId: eventId,
      payload: { artifact_id: 12 },
    },
  );
  const second = enqueueOrchestratorHandoff(
    { db: h.db, clock: h.clock },
    {
      taskId,
      reason: "worker_blocker",
      stateEventId: eventId,
      payload: { artifact_id: 12 },
    },
  );

  expect(second).toBe(first);
  const rows = listOrchestratorHandoffs(h.db, {
    status: "pending",
    eligibleAtOrBefore: h.clock.nowISO(),
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    handoff_id: first,
    task_id: taskId,
    reason: "worker_blocker",
    state_event_id: eventId,
    idempotency_key: `${taskId}:${eventId}:worker_blocker`,
    status: "pending",
  });
});

test("task claim, release, and submit advance handoff status", async () => {
  h = createHarness();
  const repoId = insertRepo(h.db, "repo-handoff-lifecycle");
  const taskId = insertTask(h.db, {
    taskId: "task-handoff-lifecycle",
    repoId,
    state: "awaiting-next-brief",
  });
  seedTaskObjective(h, taskId);
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-04-28T08:00:00.000Z",
  });
  const eventId = insertAwaitingEvent(taskId, "blocker_ingested");
  enqueueOrchestratorHandoff(
    { db: h.db, clock: h.clock },
    { taskId, reason: "worker_blocker", stateEventId: eventId },
  );

  const claim1 = claim_task({ db: h.db, clock: h.clock }, { taskId });
  if (!claim1.ok) throw new Error("expected first claim");
  expect(singleHandoff(taskId)).toMatchObject({
    status: "claimed",
    claim_id: claim1.value.claim_id,
  });

  const released = release_claim(
    { db: h.db, clock: h.clock },
    { taskId, claimId: claim1.value.claim_id },
  );
  if (!released.ok) throw new Error("expected release");
  expect(singleHandoff(taskId)).toMatchObject({
    status: "pending",
    claim_id: null,
  });

  const claim2 = claim_task({ db: h.db, clock: h.clock }, { taskId });
  if (!claim2.ok) throw new Error("expected second claim");
  const artifactStore = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });
  const submitted = await submit_brief(
    { db: h.db, clock: h.clock, artifactStore },
    {
      taskId,
      claimId: claim2.value.claim_id,
      brief: "continue with a narrower plan",
      reason: "blocker_resolved",
    },
  );
  if (!submitted.ok) throw new Error("expected submit");
  expect(singleHandoff(taskId)).toMatchObject({
    status: "completed",
    claim_id: claim2.value.claim_id,
  });
});

test("human timeout release makes older handoff ineligible so newer handoff drains", async () => {
  h = createHarness();
  h.clock.set("2026-05-21T20:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-handoff-human-timeout");
  const olderTaskId = insertTask(h.db, {
    taskId: "task-handoff-human-timeout-old",
    repoId,
    state: "awaiting-next-brief",
  });
  insertAttempt(h.db, {
    taskId: olderTaskId,
    attemptNumber: 1,
    spawnedAt: "2026-05-21T19:00:00.000Z",
  });
  const olderEventId = insertAwaitingEvent(olderTaskId, "blocker_ingested");
  const olderHandoffId = enqueueOrchestratorHandoff(
    { db: h.db, clock: h.clock },
    { taskId: olderTaskId, reason: "worker_blocker", stateEventId: olderEventId },
  );

  h.clock.advanceMs(1000);
  const newerTaskId = insertTask(h.db, {
    taskId: "task-handoff-human-timeout-new",
    repoId,
    state: "awaiting-next-brief",
  });
  const newerEventId = insertAwaitingEvent(newerTaskId, "blocker_ingested");
  const newerHandoffId = enqueueOrchestratorHandoff(
    { db: h.db, clock: h.clock },
    { taskId: newerTaskId, reason: "worker_blocker", stateEventId: newerEventId },
  );

  const claim = claim_task({ db: h.db, clock: h.clock }, { taskId: olderTaskId });
  if (!claim.ok) throw new Error("expected older handoff claim");
  const store = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });
  h.ids.push("ast149a");
  const escalation = await escalate_human(
    { db: h.db, clock: h.clock, artifactStore: store, ids: h.ids },
    {
      taskId: olderTaskId,
      claimId: claim.value.claim_id,
      questionBody: "Need human input before this task can continue.",
    },
  );
  if (!escalation.ok) throw new Error("expected human escalation");

  const released = release_claim(
    { db: h.db, clock: h.clock },
    { taskId: olderTaskId, claimId: claim.value.claim_id },
  );
  if (!released.ok) throw new Error("expected release");

  const drainable = listOrchestratorHandoffs(h.db, {
    status: "pending",
    eligibleAtOrBefore: h.clock.nowISO(),
  });
  expect(drainable.map((row) => row.handoff_id)).toEqual([newerHandoffId]);

  const allPending = listOrchestratorHandoffs(h.db, {
    status: "pending",
    eligibleAtOrBefore: h.clock.nowISO(),
    includeIneligible: true,
  });
  expect(allPending.map((row) => row.handoff_id)).toEqual([
    olderHandoffId,
    newerHandoffId,
  ]);
  expect(allPending[0]!.next_eligible_at).toBe(
    "2026-05-21T20:30:01.000Z",
  );

  h.clock.advanceMs(HUMAN_REPLY_TIMEOUT_HANDOFF_COOLDOWN_SECONDS * 1000);
  const afterCooldown = listOrchestratorHandoffs(h.db, {
    status: "pending",
    eligibleAtOrBefore: h.clock.nowISO(),
  });
  expect(afterCooldown.map((row) => row.handoff_id)).toEqual([
    olderHandoffId,
    newerHandoffId,
  ]);
});

function insertAwaitingEvent(taskId: string, eventType: string): number {
  if (!h) throw new Error("missing harness");
  const row = h.db
    .query<{ event_id: number }, [string, string, string]>(
      `INSERT INTO events (
         task_id, event_type, from_state, to_state, occurred_at
       ) VALUES (?, ?, 'running', 'awaiting-next-brief', ?)
       RETURNING event_id`,
    )
    .get(taskId, eventType, h.clock.nowISO());
  if (!row) throw new Error("event insert returned no row");
  return row.event_id;
}

function singleHandoff(taskId: string) {
  if (!h) throw new Error("missing harness");
  const rows = h.db
    .query<{ status: string; claim_id: string | null }, [string]>(
      `SELECT status, claim_id
         FROM orchestrator_handoffs
        WHERE task_id = ?
        ORDER BY handoff_id`,
    )
    .all(taskId);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}
