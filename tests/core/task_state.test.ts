import { expect, test } from "bun:test";
import {
  InvalidTaskTransitionError,
  TASK_TRANSITIONS,
  transitionTaskState,
} from "../../src/core/task_state.ts";
import { createHarness } from "../support/harness.ts";
import { insertRepo, insertTask } from "../support/fixtures.ts";

test("transitionTaskState applies valid transition, updates common fields, and writes event", () => {
  const h = createHarness();
  try {
    const repoId = insertRepo(h.db, "repo-task-state-valid");
    const taskId = insertTask(h.db, {
      taskId: "task-state-valid",
      repoId,
      state: "queued",
    });
    h.db
      .query(
        `UPDATE tasks
            SET tick_error = 'old error',
                spawn_failures_consecutive = 2
          WHERE task_id = ?`,
      )
      .run(taskId);

    const result = transitionTaskState(
      { db: h.db },
      {
        taskId,
        from: "queued",
        to: "running",
        eventType: "spawned",
        attemptId: null,
        now: "2026-05-22T09:00:00.000Z",
        updates: {
          clearTickError: true,
          incrementAttemptsConsumedBy: 1,
          resetSpawnFailures: true,
        },
        eventData: { planned_session: "quay-task-state-valid" },
      },
    );

    expect(result).toMatchObject({
      applied: true,
      from: "queued",
      to: "running",
    });
    const task = h.db
      .query<
        {
          state: string;
          attempts_consumed: number;
          tick_error: string | null;
          spawn_failures_consecutive: number;
          updated_at: string;
        },
        [string]
      >(
        `SELECT state, attempts_consumed, tick_error,
                spawn_failures_consecutive, updated_at
           FROM tasks WHERE task_id = ?`,
      )
      .get(taskId);
    expect(task).toEqual({
      state: "running",
      attempts_consumed: 1,
      tick_error: null,
      spawn_failures_consecutive: 0,
      updated_at: "2026-05-22T09:00:00.000Z",
    });

    const event = h.db
      .query<
        {
          event_type: string;
          from_state: string;
          to_state: string;
          event_data: string | null;
        },
        [string]
      >(
        `SELECT event_type, from_state, to_state, event_data
           FROM events WHERE task_id = ?`,
      )
      .get(taskId);
    expect(event).toEqual({
      event_type: "spawned",
      from_state: "queued",
      to_state: "running",
      event_data: JSON.stringify({ planned_session: "quay-task-state-valid" }),
    });
  } finally {
    h.cleanup();
  }
});

test("transitionTaskState rejects invalid lifecycle edges before writing", () => {
  const h = createHarness();
  try {
    const repoId = insertRepo(h.db, "repo-task-state-invalid");
    const taskId = insertTask(h.db, {
      taskId: "task-state-invalid",
      repoId,
      state: "queued",
    });

    expect(() =>
      transitionTaskState(
        { db: h.db },
        {
          taskId,
          from: "queued",
          to: "done",
          eventType: "ci_passed",
          now: h.clock.nowISO(),
        },
      ),
    ).toThrow(InvalidTaskTransitionError);
    expect(
      h.db
        .query<{ state: string }, [string]>(
          `SELECT state FROM tasks WHERE task_id = ?`,
        )
        .get(taskId)?.state,
    ).toBe("queued");
    expect(
      h.db
        .query<{ n: number }, [string]>(
          `SELECT COUNT(*) AS n FROM events WHERE task_id = ?`,
        )
        .get(taskId)?.n,
    ).toBe(0);
  } finally {
    h.cleanup();
  }
});

test("transitionTaskState reports wrong state, cancelled guard, and idempotent target", () => {
  const h = createHarness();
  try {
    const repoId = insertRepo(h.db, "repo-task-state-miss");
    const runningTask = insertTask(h.db, {
      taskId: "task-state-wrong",
      repoId,
      state: "running",
    });
    const wrong = transitionTaskState(
      { db: h.db },
      {
        taskId: runningTask,
        from: "queued",
        to: "running",
        eventType: "spawned",
        now: h.clock.nowISO(),
      },
    );
    expect(wrong).toEqual({
      applied: false,
      reason: "wrong_state",
      currentState: "running",
    });

    const idempotent = transitionTaskState(
      { db: h.db },
      {
        taskId: runningTask,
        from: "queued",
        to: "running",
        eventType: "spawned",
        now: h.clock.nowISO(),
        mode: "idempotent",
      },
    );
    expect(idempotent).toEqual({
      applied: false,
      reason: "already_in_target",
      currentState: "running",
    });

    const cancelledTask = insertTask(h.db, {
      taskId: "task-state-cancelled",
      repoId,
      state: "queued",
    });
    h.db
      .query(`UPDATE tasks SET cancel_requested_at = ? WHERE task_id = ?`)
      .run("2026-05-22T09:10:00.000Z", cancelledTask);
    const cancelled = transitionTaskState(
      { db: h.db },
      {
        taskId: cancelledTask,
        from: "queued",
        to: "running",
        eventType: "spawned",
        now: h.clock.nowISO(),
      },
    );
    expect(cancelled).toEqual({
      applied: false,
      reason: "cancelled",
      currentState: "queued",
    });
  } finally {
    h.cleanup();
  }
});

test("transition metadata documents every known task state", () => {
  const observed = new Set<string>();
  for (const transition of TASK_TRANSITIONS) {
    observed.add(transition.from);
    observed.add(transition.to);
    expect(transition.eventTypes.length).toBeGreaterThan(0);
    expect(transition.description.length).toBeGreaterThan(0);
  }
  for (const state of [
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
  ]) {
    expect(observed.has(state)).toBe(true);
  }
});
