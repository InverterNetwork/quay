import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";
import type { SupervisorLock } from "./supervisor_lock.ts";
import { TASK_TERMINAL_STATES } from "./task_state.ts";

export type AdjustTaskBudgetErrorCode =
  | "unknown_task"
  | "validation_error"
  | "unsafe_state";

export interface AdjustTaskBudgetError {
  code: AdjustTaskBudgetErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type AdjustTaskBudgetResult =
  | { ok: true; value: AdjustTaskBudgetValue }
  | { ok: false; error: AdjustTaskBudgetError };

export interface AdjustTaskBudgetValue {
  task_id: string;
  state: string;
  attempts_consumed: number;
  previous_retry_budget: number;
  retry_budget: number;
  previous_budget_exhausted: boolean;
  budget_exhausted: boolean;
  reason: string;
  forced: boolean;
  event_id: number;
}

export interface AdjustTaskBudgetDeps {
  db: DB;
  clock: Clock;
  supervisorLock: SupervisorLock;
}

export interface AdjustTaskBudgetInput {
  taskId: string;
  by?: number;
  set?: number;
  reason: string;
  force?: boolean;
}

interface TaskBudgetRow {
  task_id: string;
  state: string;
  attempts_consumed: number;
  retry_budget: number;
  budget_exhausted: number;
}

const SAFE_STATES = new Set([
  "awaiting-next-brief",
  "claimed-by-orchestrator",
  "waiting_human",
  "non_budget_loop",
  "orchestrator_loop",
  "worktree_error",
]);

const TERMINAL_STATES = new Set<string>(TASK_TERMINAL_STATES);

export async function adjust_task_budget(
  deps: AdjustTaskBudgetDeps,
  input: AdjustTaskBudgetInput,
): Promise<AdjustTaskBudgetResult> {
  return deps.supervisorLock.run(() => adjustUnderLock(deps, input));
}

function adjustUnderLock(
  deps: AdjustTaskBudgetDeps,
  input: AdjustTaskBudgetInput,
): AdjustTaskBudgetResult {
  const task = loadTask(deps.db, input.taskId);
  if (task === null) {
    return {
      ok: false,
      error: {
        code: "unknown_task",
        message: `task ${input.taskId} not found`,
        details: { task_id: input.taskId },
      },
    };
  }

  const reason = input.reason.trim();
  if (reason.length === 0) {
    return {
      ok: false,
      error: {
        code: "validation_error",
        message: "task increase-budget requires --reason <text>",
        details: { task_id: task.task_id },
      },
    };
  }

  if (
    (input.by === undefined && input.set === undefined) ||
    (input.by !== undefined && input.set !== undefined)
  ) {
    return {
      ok: false,
      error: {
        code: "validation_error",
        message: "task increase-budget requires exactly one of --by or --set",
        details: { task_id: task.task_id },
      },
    };
  }

  if (TERMINAL_STATES.has(task.state)) {
    return {
      ok: false,
      error: {
        code: "unsafe_state",
        message: `task ${task.task_id} is terminal (${task.state}); budget cannot be adjusted`,
        details: { task_id: task.task_id, state: task.state },
      },
    };
  }

  if (!SAFE_STATES.has(task.state) && input.force !== true) {
    return {
      ok: false,
      error: {
        code: "unsafe_state",
        message:
          `task ${task.task_id} is ${task.state}; rerun with --force only after confirming this live state should receive more budget`,
        details: { task_id: task.task_id, state: task.state },
      },
    };
  }

  const nextBudget =
    input.set !== undefined
      ? input.set
      : task.retry_budget + (input.by as number);
  if (!Number.isInteger(nextBudget) || nextBudget <= 0) {
    return {
      ok: false,
      error: {
        code: "validation_error",
        message: "retry budget must be a positive integer",
        details: { task_id: task.task_id, retry_budget: nextBudget },
      },
    };
  }
  if (nextBudget <= task.retry_budget) {
    return {
      ok: false,
      error: {
        code: "validation_error",
        message:
          `task increase-budget must raise retry_budget above ${task.retry_budget}`,
        details: {
          task_id: task.task_id,
          retry_budget: task.retry_budget,
          requested_retry_budget: nextBudget,
        },
      },
    };
  }

  const now = deps.clock.nowISO();
  const nextBudgetExhausted = task.attempts_consumed >= nextBudget ? 1 : 0;
  const eventData = {
    reason,
    forced: input.force === true,
    by: input.by ?? null,
    set: input.set ?? null,
    attempts_consumed: task.attempts_consumed,
    previous_retry_budget: task.retry_budget,
    retry_budget: nextBudget,
    previous_budget_exhausted: task.budget_exhausted === 1,
    budget_exhausted: nextBudgetExhausted === 1,
  };
  const txResult = deps.db.transaction(() => {
    const upd = deps.db
      .query(
        `UPDATE tasks
            SET retry_budget = ?,
                budget_exhausted = ?,
                updated_at = ?
          WHERE task_id = ?
            AND state = ?
            AND cancel_requested_at IS NULL`,
      )
      .run(nextBudget, nextBudgetExhausted, now, task.task_id, task.state);
    const changes = (upd as { changes?: number }).changes ?? 0;
    if (changes === 0) {
      return { ok: false as const };
    }

    const event = deps.db
      .query<{ event_id: number }, [string, string, string, string, string]>(
        `INSERT INTO events (
           task_id, event_type, from_state, to_state, occurred_at, event_data
         ) VALUES (?, 'task_budget_adjusted', ?, ?, ?, ?)
         RETURNING event_id`,
      )
      .get(
        task.task_id,
        task.state,
        task.state,
        now,
        JSON.stringify(eventData),
      );
    return { ok: true as const, event };
  })();
  if (!txResult.ok) {
    const current = loadTask(deps.db, task.task_id);
    return {
      ok: false,
      error: {
        code: "unsafe_state",
        message:
          `task ${task.task_id} changed before budget adjustment; retry after re-checking its current state`,
        details: {
          task_id: task.task_id,
          observed_state: task.state,
          current_state: current?.state ?? null,
        },
      },
    };
  }
  if (!txResult.event) {
    throw new Error("task_budget_adjusted event insert returned no row");
  }

  return {
    ok: true,
    value: {
      task_id: task.task_id,
      state: task.state,
      attempts_consumed: task.attempts_consumed,
      previous_retry_budget: task.retry_budget,
      retry_budget: nextBudget,
      previous_budget_exhausted: task.budget_exhausted === 1,
      budget_exhausted: nextBudgetExhausted === 1,
      reason,
      forced: input.force === true,
      event_id: txResult.event.event_id,
    },
  };
}

function loadTask(db: DB, taskId: string): TaskBudgetRow | null {
  return db
    .query<TaskBudgetRow, [string]>(
      `SELECT task_id, state, attempts_consumed, retry_budget, budget_exhausted
         FROM tasks
        WHERE task_id = ?`,
    )
    .get(taskId) ?? null;
}
