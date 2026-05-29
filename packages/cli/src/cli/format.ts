// JSON output shapes for read commands. Read-only SQL; no behavior.
import type { DB } from "../db/connection.ts";
import {
  taskDependencyStatus,
  type TaskDependencyStatus,
} from "../core/task_dependencies.ts";
import type { TicketAuthor } from "../ports/ticket_context.ts";

export interface TaskListRow {
  task_id: string;
  repo_id: string;
  base_branch: string;
  retargeted_from_task_id: string | null;
  state: string;
  external_ref: string | null;
  branch_name: string;
  attempts_consumed: number;
  retry_budget: number;
  budget_exhausted: boolean;
  pr_screenshots_requested: boolean;
  pr_screenshots_required: boolean;
  worker_execution: "oneshot" | "goal";
  worker_agent: string | null;
  worker_model: string | null;
  reviewer_agent: string | null;
  reviewer_model: string | null;
  dependency_status: TaskDependencyStatus;
  created_at: string;
  updated_at: string;
}

export interface TaskGetCurrentAttempt {
  attempt_id: number;
  attempt_number: number;
  preamble_id: number;
  reason: string;
  consumed_budget: number;
  spawned_at: string | null;
  ended_at: string | null;
  exit_kind: string | null;
  kill_intent: string | null;
  agent_name: string | null;
  agent_model: string | null;
}

export interface TaskGetEvent {
  event_id: number;
  event_type: string;
  from_state: string | null;
  to_state: string | null;
  occurred_at: string;
}

export interface TaskGetPayload extends TaskListRow {
  authors: TicketAuthor[];
  slack_thread_ref: string | null;
  pr_number: number | null;
  pr_url: string | null;
  head_sha: string | null;
  base_sha: string | null;
  current_attempt: TaskGetCurrentAttempt | null;
  recent_events: TaskGetEvent[];
  goal: TaskGetGoal | null;
}

const TASK_LIST_COLUMNS = `
  t.task_id, t.repo_id, COALESCE(t.base_branch, r.base_branch) AS base_branch,
  t.retargeted_from_task_id, t.state, t.external_ref, t.branch_name,
  t.attempts_consumed, t.retry_budget, t.budget_exhausted,
  t.pr_screenshots_requested, t.pr_screenshots_required,
  t.worker_execution,
  t.worker_agent, t.worker_model, t.reviewer_agent, t.reviewer_model,
  t.created_at, t.updated_at
`;

interface TaskListRawRow {
  task_id: string;
  repo_id: string;
  base_branch: string;
  retargeted_from_task_id: string | null;
  state: string;
  external_ref: string | null;
  branch_name: string;
  attempts_consumed: number;
  retry_budget: number;
  budget_exhausted: number;
  pr_screenshots_requested: number;
  pr_screenshots_required: number;
  worker_execution: "oneshot" | "goal";
  worker_agent: string | null;
  worker_model: string | null;
  reviewer_agent: string | null;
  reviewer_model: string | null;
  created_at: string;
  updated_at: string;
}

function rowToList(db: DB, r: TaskListRawRow): TaskListRow {
  return {
    task_id: r.task_id,
    repo_id: r.repo_id,
    base_branch: r.base_branch,
    retargeted_from_task_id: r.retargeted_from_task_id,
    state: r.state,
    external_ref: r.external_ref,
    branch_name: r.branch_name,
    attempts_consumed: r.attempts_consumed,
    retry_budget: r.retry_budget,
    budget_exhausted: r.budget_exhausted === 1,
    pr_screenshots_requested: r.pr_screenshots_requested === 1,
    pr_screenshots_required: r.pr_screenshots_required === 1,
    worker_execution: r.worker_execution,
    worker_agent: r.worker_agent,
    worker_model: r.worker_model,
    reviewer_agent: r.reviewer_agent,
    reviewer_model: r.reviewer_model,
    dependency_status: taskDependencyStatus(db, r.task_id),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function listTasks(db: DB): TaskListRow[] {
  const rows = db
    .query<TaskListRawRow, []>(
      `SELECT ${TASK_LIST_COLUMNS}
         FROM tasks t JOIN repos r ON r.repo_id = t.repo_id
        ORDER BY t.created_at, t.task_id`,
    )
    .all();
  return rows.map((row) => rowToList(db, row));
}

interface TaskGetRawRow extends TaskListRawRow {
  authors_json: string | null;
  slack_thread_ref: string | null;
  pr_number: number | null;
  pr_url: string | null;
  head_sha: string | null;
  base_sha: string | null;
}

export interface TaskGetGoal {
  goal_id: string;
  status: string;
  tokens_used: number;
  token_budget: number | null;
  time_used_seconds: number;
  no_progress_active_count: number;
  last_attempt_id: number | null;
  current_handoff_id: number | null;
  completed_at: string | null;
}

const RECENT_EVENT_LIMIT = 20;
const SLACK_USER_ID = /^U[A-Z0-9]+$/;

function parseTaskAuthors(authorsJson: string | null): TicketAuthor[] {
  if (authorsJson === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(authorsJson);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const authors: TicketAuthor[] = [];
  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object") return [];
    const author = entry as { name?: unknown; slack_id?: unknown };
    if (typeof author.name !== "string") return [];
    if (typeof author.slack_id !== "string") return [];
    if (!SLACK_USER_ID.test(author.slack_id)) return [];
    authors.push({ name: author.name, slack_id: author.slack_id });
  }
  return authors;
}

export function getTask(db: DB, taskId: string): TaskGetPayload | null {
  const row = db
    .query<TaskGetRawRow, [string]>(
      `SELECT ${TASK_LIST_COLUMNS},
              t.authors_json, t.slack_thread_ref,
              t.pr_number, t.pr_url, t.head_sha, t.base_sha
         FROM tasks t JOIN repos r ON r.repo_id = t.repo_id
        WHERE t.task_id = ?`,
    )
    .get(taskId);
  if (!row) return null;

  const attempt = db
    .query<TaskGetCurrentAttempt, [string]>(
      `SELECT attempt_id, attempt_number, preamble_id, reason, consumed_budget,
              spawned_at, ended_at, exit_kind, kill_intent,
              agent_name, agent_model
         FROM attempts
        WHERE task_id = ?
        ORDER BY attempt_number DESC, attempt_id DESC
        LIMIT 1`,
    )
    .get(taskId) ?? null;

  const events = db
    .query<TaskGetEvent, [string, number]>(
      `SELECT event_id, event_type, from_state, to_state, occurred_at
         FROM events
        WHERE task_id = ?
        ORDER BY occurred_at DESC, event_id DESC
        LIMIT ?`,
    )
    .all(taskId, RECENT_EVENT_LIMIT);

  const goal =
    db
      .query<TaskGetGoal, [string]>(
        `SELECT goal_id, status, tokens_used, token_budget,
                time_used_seconds, no_progress_active_count,
                last_attempt_id, current_handoff_id, completed_at
           FROM task_goals
          WHERE task_id = ?`,
      )
      .get(taskId) ?? null;

  return {
    ...rowToList(db, row),
    authors: parseTaskAuthors(row.authors_json),
    slack_thread_ref: row.slack_thread_ref,
    pr_number: row.pr_number,
    pr_url: row.pr_url,
    head_sha: row.head_sha,
    base_sha: row.base_sha,
    current_attempt: attempt,
    recent_events: events,
    goal,
  };
}
