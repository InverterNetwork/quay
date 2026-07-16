import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";
import { adjust_task_budget } from "../../src/core/task_budget.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { buildCliDeps, type BuiltCliDeps } from "../support/cli_deps.ts";
import {
  insertAttempt,
  insertRepo,
  insertTask,
  seedTaskObjective,
} from "../support/fixtures.ts";

let h: Harness | null = null;
let scratchDirs: string[] = [];
afterEach(() => {
  h?.cleanup();
  h = null;
  for (const d of scratchDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

function writeTemp(contents: string, name = "brief.md"): string {
  const dir = mkdtempSync(join(tmpdir(), "quay-budget-test-"));
  scratchDirs.push(dir);
  const p = join(dir, name);
  writeFileSync(p, contents);
  return p;
}

function setupTask(state = "claimed-by-orchestrator"): {
  h: Harness;
  built: BuiltCliDeps;
  taskId: string;
} {
  const harness = createHarness();
  const built = buildCliDeps(harness);
  const repoId = insertRepo(harness.db, "repo-budget");
  const taskId = insertTask(harness.db, {
    taskId: "task-budget",
    repoId,
    state,
  });
  seedTaskObjective(harness, taskId);
  insertAttempt(harness.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
    spawnedAt: "2026-01-01T00:00:00.000Z",
  });
  harness.db
    .query(
      `UPDATE tasks
          SET attempts_consumed = 5,
              retry_budget = 5,
              budget_exhausted = 1,
              non_budget_respawns_consumed = 21,
              claim_id = CASE WHEN state = 'claimed-by-orchestrator' THEN 'claim-budget' ELSE claim_id END,
              claimed_at = CASE WHEN state = 'claimed-by-orchestrator' THEN ? ELSE claimed_at END
        WHERE task_id = ?`,
    )
    .run(harness.clock.nowISO(), taskId);
  h = harness;
  return { h: harness, built, taskId };
}

test("adjust_task_budget raises budget, clears exhaustion, and records audit reason", async () => {
  const { h, built, taskId } = setupTask();

  const result = await adjust_task_budget(
    {
      db: h.db,
      clock: h.clock,
      supervisorLock: built.deps.supervisorLock,
    },
    {
      taskId,
      by: 2,
      reason: "missing worktree burned retries without worker progress",
    },
  );

  expect(result).toMatchObject({
    ok: true,
    value: {
      task_id: taskId,
      attempts_consumed: 5,
      previous_retry_budget: 5,
      retry_budget: 7,
      previous_budget_exhausted: true,
      budget_exhausted: false,
      previous_non_budget_respawns_consumed: 21,
      non_budget_respawns_consumed: 21,
      reason: "missing worktree burned retries without worker progress",
      forced: false,
    },
  });
  const task = h.db
    .query<
      { retry_budget: number; budget_exhausted: number },
      [string]
    >(`SELECT retry_budget, budget_exhausted FROM tasks WHERE task_id = ?`)
    .get(taskId);
  expect(task).toEqual({ retry_budget: 7, budget_exhausted: 0 });

  const event = h.db
    .query<
      { event_type: string; from_state: string; to_state: string; event_data: string },
      [string]
    >(
      `SELECT event_type, from_state, to_state, event_data
         FROM events
        WHERE task_id = ? AND event_type = 'task_budget_adjusted'`,
    )
    .get(taskId);
  expect(event).toMatchObject({
    event_type: "task_budget_adjusted",
    from_state: "claimed-by-orchestrator",
    to_state: "claimed-by-orchestrator",
  });
  expect(JSON.parse(event!.event_data)).toMatchObject({
    counter: "retry_budget",
    reason: "missing worktree burned retries without worker progress",
    previous_retry_budget: 5,
    retry_budget: 7,
    previous_budget_exhausted: true,
    budget_exhausted: false,
  });
});

test("adjust_task_budget resets non-budget respawn counter and records audit reason", async () => {
  const { h, built, taskId } = setupTask("non_budget_loop");

  const result = await adjust_task_budget(
    {
      db: h.db,
      clock: h.clock,
      supervisorLock: built.deps.supervisorLock,
    },
    {
      taskId,
      counter: "non_budget_respawns",
      reset: true,
      reason: "operator confirmed review loop is still converging",
    },
  );

  expect(result).toMatchObject({
    ok: true,
    value: {
      task_id: taskId,
      counter: "non_budget_respawns",
      state: "non_budget_loop",
      previous_retry_budget: 5,
      retry_budget: 5,
      previous_budget_exhausted: true,
      budget_exhausted: true,
      previous_non_budget_respawns_consumed: 21,
      non_budget_respawns_consumed: 0,
      reason: "operator confirmed review loop is still converging",
      forced: false,
    },
  });
  const task = h.db
    .query<
      {
        retry_budget: number;
        budget_exhausted: number;
        non_budget_respawns_consumed: number;
      },
      [string]
    >(
      `SELECT retry_budget, budget_exhausted, non_budget_respawns_consumed
         FROM tasks
        WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toEqual({
    retry_budget: 5,
    budget_exhausted: 1,
    non_budget_respawns_consumed: 0,
  });

  const event = h.db
    .query<{ event_type: string; event_data: string }, [string]>(
      `SELECT event_type, event_data
         FROM events
        WHERE task_id = ? AND event_type = 'task_non_budget_respawns_adjusted'`,
    )
    .get(taskId);
  expect(event?.event_type).toBe("task_non_budget_respawns_adjusted");
  expect(JSON.parse(event!.event_data)).toMatchObject({
    counter: "non_budget_respawns",
    reason: "operator confirmed review loop is still converging",
    reset: true,
    previous_non_budget_respawns_consumed: 21,
    non_budget_respawns_consumed: 0,
  });
});

test("adjust_task_budget refuses when state changes before fenced update", async () => {
  const { h, built, taskId } = setupTask("awaiting-next-brief");
  let mutated = false;
  const racingClock = {
    now: () => h.clock.now(),
    nowISO: () => {
      if (!mutated) {
        mutated = true;
        h.db
          .query(`UPDATE tasks SET state = 'queued' WHERE task_id = ?`)
          .run(taskId);
      }
      return h.clock.nowISO();
    },
  };

  const result = await adjust_task_budget(
    {
      db: h.db,
      clock: racingClock,
      supervisorLock: built.deps.supervisorLock,
    },
    {
      taskId,
      by: 1,
      reason: "operator recovery after substrate failure",
    },
  );

  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "unsafe_state",
      details: {
        task_id: taskId,
        observed_state: "awaiting-next-brief",
        current_state: "queued",
      },
    },
  });
  const task = h.db
    .query<{ state: string; retry_budget: number; budget_exhausted: number }, [string]>(
      `SELECT state, retry_budget, budget_exhausted FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toEqual({
    state: "queued",
    retry_budget: 5,
    budget_exhausted: 1,
  });
  const eventCount = h.db
    .query<{ count: number }, [string]>(
      `SELECT count(*) AS count
         FROM events
        WHERE task_id = ? AND event_type = 'task_budget_adjusted'`,
    )
    .get(taskId);
  expect(eventCount).toEqual({ count: 0 });
});

test("task increase-budget CLI lets blocker_resolved resume after budget is raised", async () => {
  const { h, built, taskId } = setupTask();

  const increaseIo = bufferIO();
  const increase = await dispatch(
    [
      "task",
      "increase-budget",
      taskId,
      "--set",
      "8",
      "--reason",
      "operator repaired deleted worktree and is allowing real retries",
    ],
    built.deps,
    increaseIo,
  );
  expect(increase.exitCode).toBe(0);
  expect(increaseIo.err()).toBe("");
  expect(JSON.parse(increaseIo.out())).toMatchObject({
    task_id: taskId,
    retry_budget: 8,
    budget_exhausted: false,
  });

  const submitIo = bufferIO();
  const submit = await dispatch(
    [
      "submit-brief",
      taskId,
      "--claim-id",
      "claim-budget",
      "--brief-file",
      writeTemp("Retry after budget repair."),
      "--reason",
      "blocker_resolved",
    ],
    built.deps,
    submitIo,
  );

  expect(submit.exitCode).toBe(0);
  expect(submitIo.err()).toBe("");
  expect(JSON.parse(submitIo.out())).toMatchObject({
    state: "queued",
  });
  const task = h.db
    .query<{ state: string; budget_exhausted: number }, [string]>(
      `SELECT state, budget_exhausted FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toEqual({ state: "queued", budget_exhausted: 0 });
});

test("task increase-budget CLI sets non-budget respawn counter to zero", async () => {
  const { h, built, taskId } = setupTask("non_budget_loop");

  const io = bufferIO();
  const result = await dispatch(
    [
      "task",
      "increase-budget",
      taskId,
      "--counter",
      "non_budget_respawns",
      "--set",
      "0",
      "--reason",
      "recovering a legitimate PR review loop",
    ],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");
  expect(JSON.parse(io.out())).toMatchObject({
    task_id: taskId,
    counter: "non_budget_respawns",
    previous_non_budget_respawns_consumed: 21,
    non_budget_respawns_consumed: 0,
    retry_budget: 5,
    budget_exhausted: true,
  });
  const task = h.db
    .query<{ non_budget_respawns_consumed: number }, [string]>(
      `SELECT non_budget_respawns_consumed FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toEqual({ non_budget_respawns_consumed: 0 });
});

test("task get exposes non-budget respawn counter for inspection", async () => {
  const { built, taskId } = setupTask("non_budget_loop");

  const io = bufferIO();
  const result = await dispatch(["task", "get", taskId], built.deps, io);

  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");
  expect(JSON.parse(io.out())).toMatchObject({
    task_id: taskId,
    state: "non_budget_loop",
    retry_budget: 5,
    budget_exhausted: true,
    non_budget_respawns_consumed: 21,
  });
});

test("task increase-budget guards live states unless forced", async () => {
  const { built, taskId } = setupTask("queued");

  const refusedIo = bufferIO();
  const refused = await dispatch(
    [
      "task",
      "increase-budget",
      taskId,
      "--by",
      "1",
      "--reason",
      "testing guardrail",
    ],
    built.deps,
    refusedIo,
  );
  expect(refused.exitCode).toBe(1);
  expect(JSON.parse(refusedIo.err())).toMatchObject({
    error: "unsafe_state",
  });

  const forcedIo = bufferIO();
  const forced = await dispatch(
    [
      "task",
      "increase-budget",
      taskId,
      "--by",
      "1",
      "--reason",
      "operator confirmed the queued task should receive another retry",
      "--force",
    ],
    built.deps,
    forcedIo,
  );
  expect(forced.exitCode).toBe(0);
  expect(JSON.parse(forcedIo.out())).toMatchObject({
    retry_budget: 6,
    forced: true,
  });
});

test("task increase-budget guards live states for non-budget counter unless forced", async () => {
  const { h, built, taskId } = setupTask("done");

  const refusedIo = bufferIO();
  const refused = await dispatch(
    [
      "task",
      "increase-budget",
      taskId,
      "--counter",
      "non_budget_respawns",
      "--reset",
      "--reason",
      "testing guardrail",
    ],
    built.deps,
    refusedIo,
  );
  expect(refused.exitCode).toBe(1);
  expect(JSON.parse(refusedIo.err())).toMatchObject({
    error: "unsafe_state",
  });

  const forcedIo = bufferIO();
  const forced = await dispatch(
    [
      "task",
      "increase-budget",
      taskId,
      "--counter",
      "non_budget_respawns",
      "--reset",
      "--reason",
      "operator confirmed done task should be rechecked for PR feedback",
      "--force",
    ],
    built.deps,
    forcedIo,
  );
  expect(forced.exitCode).toBe(0);
  expect(JSON.parse(forcedIo.out())).toMatchObject({
    counter: "non_budget_respawns",
    previous_non_budget_respawns_consumed: 21,
    non_budget_respawns_consumed: 0,
    forced: true,
  });
  const task = h.db
    .query<{ state: string; non_budget_respawns_consumed: number }, [string]>(
      `SELECT state, non_budget_respawns_consumed FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toEqual({
    state: "done",
    non_budget_respawns_consumed: 0,
  });
});

test("task increase-budget refuses terminal tasks", async () => {
  const { built, taskId } = setupTask("cancelled");

  const terminalIo = bufferIO();
  const terminal = await dispatch(
    [
      "task",
      "increase-budget",
      taskId,
      "--by",
      "1",
      "--reason",
      "should not reopen terminal task",
    ],
    built.deps,
    terminalIo,
  );
  expect(terminal.exitCode).toBe(1);
  expect(JSON.parse(terminalIo.err())).toMatchObject({
    error: "unsafe_state",
  });
});

test("task increase-budget refuses non-increasing set values", async () => {
  const { built, taskId } = setupTask("awaiting-next-brief");

  const nonIncreasingIo = bufferIO();
  const nonIncreasing = await dispatch(
    [
      "task",
      "increase-budget",
      taskId,
      "--set",
      "5",
      "--reason",
      "same value is not an increase",
    ],
    built.deps,
    nonIncreasingIo,
  );
  expect(nonIncreasing.exitCode).toBe(1);
  expect(JSON.parse(nonIncreasingIo.err())).toMatchObject({
    error: "validation_error",
  });
});
