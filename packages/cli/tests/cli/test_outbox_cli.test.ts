import { afterEach, expect, test } from "bun:test";
import { dispatch } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";
import { enqueueOrchestratorHandoff } from "../../src/core/orchestrator_handoffs.ts";
import { enqueueOutboxItem } from "../../src/core/outbox.ts";
import { buildCliDeps } from "../support/cli_deps.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertRepo, insertTask } from "../support/fixtures.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("outbox list returns eligible pending items", async () => {
  h = createHarness();
  const taskId = insertTask(h.db, {
    repoId: insertRepo(h.db, "repo-outbox-cli-list"),
    taskId: "task-outbox-cli-list",
  });
  const outboxItemId = enqueueOutboxItem(
    { db: h.db, clock: h.clock },
    {
      taskId,
      kind: "slack.pr_ready_approved",
      handlerClass: "delivery",
      payload: { pr_number: 8 },
    },
  );

  const io = bufferIO();
  const result = await dispatch(
    ["outbox", "list", "--handler-class", "delivery"],
    buildCliDeps(h).deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");
  const rows = JSON.parse(io.out());
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    outbox_item_id: outboxItemId,
    task_id: taskId,
    kind: "slack.pr_ready_approved",
    handler_class: "delivery",
    status: "pending",
  });
});

test("outbox list defaults to delivery items and requires opt-in for workflow rows", async () => {
  h = createHarness();
  const repoId = insertRepo(h.db, "repo-outbox-cli-filter");
  const deliveryTaskId = insertTask(h.db, {
    repoId,
    taskId: "task-outbox-cli-filter-delivery",
  });
  const workflowTaskId = insertTask(h.db, {
    repoId,
    taskId: "task-outbox-cli-filter-workflow",
    state: "awaiting-next-brief",
  });
  const deliveryOutboxItemId = enqueueOutboxItem(
    { db: h.db, clock: h.clock },
    {
      taskId: deliveryTaskId,
      kind: "slack.pr_ready_approved",
      handlerClass: "delivery",
    },
  );
  const workflowEventId = insertAwaitingEvent(workflowTaskId);
  enqueueOrchestratorHandoff(
    { db: h.db, clock: h.clock },
    {
      taskId: workflowTaskId,
      reason: "worker_blocker",
      stateEventId: workflowEventId,
    },
  );

  const defaultIo = bufferIO();
  const defaultResult = await dispatch(
    ["outbox", "list"],
    buildCliDeps(h).deps,
    defaultIo,
  );
  expect(defaultResult.exitCode).toBe(0);
  const defaultRows = JSON.parse(defaultIo.out()) as Array<{
    outbox_item_id: number;
  }>;
  expect(defaultRows.map((row) => row.outbox_item_id)).toEqual([
    deliveryOutboxItemId,
  ]);

  const workflowIo = bufferIO();
  const workflowResult = await dispatch(
    ["outbox", "list", "--handler-class", "workflow_intervention"],
    buildCliDeps(h).deps,
    workflowIo,
  );
  expect(workflowResult.exitCode).toBe(0);
  const workflowRows = JSON.parse(workflowIo.out());
  expect(workflowRows).toHaveLength(1);
  expect(workflowRows[0]).toMatchObject({
    task_id: workflowTaskId,
    handler_class: "workflow_intervention",
  });
});

test("outbox claim and complete mark delivery item delivered", async () => {
  h = createHarness();
  h.clock.set("2026-05-22T11:00:00.000Z");
  const taskId = insertTask(h.db, {
    repoId: insertRepo(h.db, "repo-outbox-cli-complete"),
    taskId: "task-outbox-cli-complete",
  });
  const outboxItemId = enqueueOutboxItem(
    { db: h.db, clock: h.clock },
    {
      taskId,
      kind: "slack.pr_ready_approved",
      handlerClass: "delivery",
    },
  );

  const claimIo = bufferIO();
  const claimResult = await dispatch(
    ["outbox", "claim", String(outboxItemId), "--claim-id", "claim-cli"],
    buildCliDeps(h).deps,
    claimIo,
  );
  expect(claimResult.exitCode).toBe(0);
  expect(JSON.parse(claimIo.out())).toMatchObject({
    outbox_item_id: outboxItemId,
    status: "claimed",
    claim_id: "claim-cli",
  });

  h.clock.set("2026-05-22T11:01:00.000Z");
  const completeIo = bufferIO();
  const completeResult = await dispatch(
    ["outbox", "complete", String(outboxItemId), "--claim-id", "claim-cli"],
    buildCliDeps(h).deps,
    completeIo,
  );
  expect(completeResult.exitCode).toBe(0);
  expect(JSON.parse(completeIo.out())).toMatchObject({
    outbox_item_id: outboxItemId,
    status: "completed",
    delivered_at: "2026-05-22T11:01:00.000Z",
    completed_at: "2026-05-22T11:01:00.000Z",
  });
});

test("outbox fail records last_error and hides cooled-down pending item", async () => {
  h = createHarness();
  h.clock.set("2026-05-22T13:00:00.000Z");
  const taskId = insertTask(h.db, {
    repoId: insertRepo(h.db, "repo-outbox-cli-fail"),
    taskId: "task-outbox-cli-fail",
  });
  const outboxItemId = enqueueOutboxItem(
    { db: h.db, clock: h.clock },
    {
      taskId,
      kind: "slack.pr_ready_approved",
      handlerClass: "delivery",
    },
  );
  await dispatch(
    ["outbox", "claim", String(outboxItemId), "--claim-id", "claim-fail-cli"],
    buildCliDeps(h).deps,
    bufferIO(),
  );

  const failIo = bufferIO();
  const failResult = await dispatch(
    [
      "outbox",
      "fail",
      String(outboxItemId),
      "--claim-id",
      "claim-fail-cli",
      "--error",
      "rate limited",
      "--next-eligible-at",
      "2026-05-22T13:30:00.000Z",
    ],
    buildCliDeps(h).deps,
    failIo,
  );
  expect(failResult.exitCode).toBe(0);
  expect(JSON.parse(failIo.out())).toMatchObject({
    outbox_item_id: outboxItemId,
    status: "pending",
    last_error: "rate limited",
    next_eligible_at: "2026-05-22T13:30:00.000Z",
  });

  const listIo = bufferIO();
  await dispatch(["outbox", "list"], buildCliDeps(h).deps, listIo);
  expect(JSON.parse(listIo.out())).toEqual([]);
});

test("outbox fail rejects malformed retry timestamps", async () => {
  h = createHarness();
  const taskId = insertTask(h.db, {
    repoId: insertRepo(h.db, "repo-outbox-cli-bad-timestamp"),
    taskId: "task-outbox-cli-bad-timestamp",
  });
  const outboxItemId = enqueueOutboxItem(
    { db: h.db, clock: h.clock },
    {
      taskId,
      kind: "slack.pr_ready_approved",
      handlerClass: "delivery",
    },
  );
  await dispatch(
    ["outbox", "claim", String(outboxItemId), "--claim-id", "claim-bad-time"],
    buildCliDeps(h).deps,
    bufferIO(),
  );

  const failIo = bufferIO();
  const failResult = await dispatch(
    [
      "outbox",
      "fail",
      String(outboxItemId),
      "--claim-id",
      "claim-bad-time",
      "--error",
      "rate limited",
      "--next-eligible-at",
      "tomorrow",
    ],
    buildCliDeps(h).deps,
    failIo,
  );

  expect(failResult.exitCode).toBe(1);
  expect(JSON.parse(failIo.err())).toMatchObject({
    error: "validation_error",
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
