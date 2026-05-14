import { afterEach, expect, test } from "bun:test";
import { dispatch } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";
import { enqueueOrchestratorHandoff } from "../../src/core/orchestrator_handoffs.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { buildCliDeps } from "../support/cli_deps.ts";
import { insertRepo, insertTask } from "../support/fixtures.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("handoff list defaults to pending durable handoffs", async () => {
  h = createHarness();
  const repoId = insertRepo(h.db, "repo-handoff-cli");
  const taskId = insertTask(h.db, {
    taskId: "task-handoff-cli",
    repoId,
    state: "awaiting-next-brief",
  });
  const event = h.db
    .query<{ event_id: number }, [string, string]>(
      `INSERT INTO events (
         task_id, event_type, from_state, to_state, occurred_at
       ) VALUES (?, 'slack_reply_ingested', 'waiting_human', 'awaiting-next-brief', ?)
       RETURNING event_id`,
    )
    .get(taskId, h.clock.nowISO());
  if (!event) throw new Error("event insert returned no row");
  enqueueOrchestratorHandoff(
    { db: h.db, clock: h.clock },
    {
      taskId,
      reason: "human_reply_ingested",
      stateEventId: event.event_id,
    },
  );

  const io = bufferIO();
  const result = await dispatch(
    ["handoff", "list"],
    buildCliDeps(h).deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");
  const rows = JSON.parse(io.out());
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    task_id: taskId,
    reason: "human_reply_ingested",
    status: "pending",
  });
});
