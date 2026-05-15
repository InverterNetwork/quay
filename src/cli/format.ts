// JSON output shapes for read commands. Read-only SQL; no behavior.
import type { DB } from "../db/connection.ts";
import type { TicketAuthor } from "../ports/ticket_context.ts";

export interface TaskListRow {
  task_id: string;
  repo_id: string;
  state: string;
  external_ref: string | null;
  branch_name: string;
  attempts_consumed: number;
  retry_budget: number;
  budget_exhausted: boolean;
  worker_agent: string | null;
  worker_model: string | null;
  reviewer_agent: string | null;
  reviewer_model: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskGetCurrentAttempt {
  attempt_id: number;
  attempt_number: number;
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
}

const TASK_LIST_COLUMNS = `
  task_id, repo_id, state, external_ref, branch_name,
  attempts_consumed, retry_budget, budget_exhausted,
  worker_agent, worker_model, reviewer_agent, reviewer_model,
  created_at, updated_at
`;

interface TaskListRawRow {
  task_id: string;
  repo_id: string;
  state: string;
  external_ref: string | null;
  branch_name: string;
  attempts_consumed: number;
  retry_budget: number;
  budget_exhausted: number;
  worker_agent: string | null;
  worker_model: string | null;
  reviewer_agent: string | null;
  reviewer_model: string | null;
  created_at: string;
  updated_at: string;
}

function rowToList(r: TaskListRawRow): TaskListRow {
  return {
    task_id: r.task_id,
    repo_id: r.repo_id,
    state: r.state,
    external_ref: r.external_ref,
    branch_name: r.branch_name,
    attempts_consumed: r.attempts_consumed,
    retry_budget: r.retry_budget,
    budget_exhausted: r.budget_exhausted === 1,
    worker_agent: r.worker_agent,
    worker_model: r.worker_model,
    reviewer_agent: r.reviewer_agent,
    reviewer_model: r.reviewer_model,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function listTasks(db: DB): TaskListRow[] {
  const rows = db
    .query<TaskListRawRow, []>(
      `SELECT ${TASK_LIST_COLUMNS} FROM tasks ORDER BY created_at, task_id`,
    )
    .all();
  return rows.map(rowToList);
}

interface TaskGetRawRow extends TaskListRawRow {
  authors_json: string | null;
  slack_thread_ref: string | null;
  pr_number: number | null;
  pr_url: string | null;
  head_sha: string | null;
  base_sha: string | null;
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
      `SELECT ${TASK_LIST_COLUMNS}, authors_json, slack_thread_ref,
              pr_number, pr_url, head_sha, base_sha
         FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  if (!row) return null;

  const attempt = db
    .query<TaskGetCurrentAttempt, [string]>(
      `SELECT attempt_id, attempt_number, reason, consumed_budget,
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

  return {
    ...rowToList(row),
    authors: parseTaskAuthors(row.authors_json),
    slack_thread_ref: row.slack_thread_ref,
    pr_number: row.pr_number,
    pr_url: row.pr_url,
    head_sha: row.head_sha,
    base_sha: row.base_sha,
    current_attempt: attempt,
    recent_events: events,
  };
}
