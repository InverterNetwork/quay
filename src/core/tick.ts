import { readFileSync } from "node:fs";
import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";
import type { GitPort } from "../ports/git.ts";
import type { GitHubPort } from "../ports/github.ts";
import type { TmuxPort } from "../ports/tmux.ts";
import type { SupervisorLock } from "./supervisor_lock.ts";

export const DEFAULT_MAX_CONCURRENT = 2;
export const DEFAULT_AGENT_INVOCATION =
  "claude --permission-mode bypassPermissions < {prompt_file}";

export interface TickDeps {
  db: DB;
  clock: Clock;
  git: GitPort;
  github: GitHubPort;
  tmux: TmuxPort;
  supervisorLock: SupervisorLock;
}

export interface TickOptions {
  maxConcurrent?: number;
  agentInvocation?: string;
}

export type TickAction =
  | "spawned"
  | "skipped_capacity"
  | "skipped_predicate"
  | "skipped_no_pending_attempt"
  | "spawn_substrate_failed"
  | "tick_error";

export interface TickTaskResult {
  task_id: string;
  action: TickAction;
  error?: string;
}

interface QueuedTaskRow {
  task_id: string;
  repo_id: string;
  branch_name: string;
  tmux_id: string;
  worktree_path: string;
  cancel_requested_at: string | null;
}

interface PendingAttemptRow {
  attempt_id: number;
  attempt_number: number;
  consumed_budget: number;
  preamble_id: number;
}

export function tick_once(deps: TickDeps, options: TickOptions = {}): TickTaskResult[] {
  const max = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const agentInvocation = options.agentInvocation ?? DEFAULT_AGENT_INVOCATION;
  return deps.supervisorLock.run(() => {
    const results: TickTaskResult[] = [];
    let runningCount = countRunning(deps.db);

    for (const task of readQueued(deps.db)) {
      if (runningCount >= max) {
        results.push({ task_id: task.task_id, action: "skipped_capacity" });
        continue;
      }
      try {
        results.push(promoteAndSpawn(deps, task, agentInvocation));
      } catch (err) {
        results.push(recordTickError(deps, task.task_id, err));
      }
      // Re-read running count from the DB so terminal/non-promotion outcomes
      // don't drift the cap.
      runningCount = countRunning(deps.db);
    }

    return results;
  });
}

function readQueued(db: DB): QueuedTaskRow[] {
  return db
    .query<QueuedTaskRow, []>(
      `SELECT task_id, repo_id, branch_name, tmux_id, worktree_path, cancel_requested_at
         FROM tasks
        WHERE state = 'queued'
        ORDER BY created_at, task_id`,
    )
    .all();
}

function countRunning(db: DB): number {
  const row = db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM tasks WHERE state = 'running'`,
    )
    .get();
  return row?.n ?? 0;
}

function loadPendingAttempt(db: DB, taskId: string): PendingAttemptRow | null {
  return (
    db
      .query<PendingAttemptRow, [string]>(
        `SELECT attempt_id, attempt_number, consumed_budget, preamble_id
           FROM attempts
          WHERE task_id = ? AND spawned_at IS NULL`,
      )
      .get(taskId) ?? null
  );
}

function loadFinalPrompt(db: DB, taskId: string, attemptId: number): string {
  const row = db
    .query<{ file_path: string }, [string, number]>(
      `SELECT file_path FROM artifacts
         WHERE task_id = ? AND attempt_id = ? AND kind = 'final_prompt'
         ORDER BY artifact_id DESC LIMIT 1`,
    )
    .get(taskId, attemptId);
  if (!row) {
    throw new Error(`missing final_prompt artifact for task ${taskId} attempt ${attemptId}`);
  }
  try {
    return readFileSync(row.file_path, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`unable to read final_prompt artifact for task ${taskId} attempt ${attemptId}: ${message}`);
  }
}

function promoteAndSpawn(
  deps: TickDeps,
  task: QueuedTaskRow,
  agentInvocation: string,
): TickTaskResult {
  if (task.cancel_requested_at !== null) {
    return { task_id: task.task_id, action: "skipped_predicate" };
  }

  const pending = loadPendingAttempt(deps.db, task.task_id);
  if (!pending) {
    return { task_id: task.task_id, action: "skipped_no_pending_attempt" };
  }
  const promptContent = loadFinalPrompt(deps.db, task.task_id, pending.attempt_id);

  // Refresh the remote branch ref and snapshot spawn-time inputs *before* the
  // promotion transaction. These reads are external; we don't want them inside
  // the SQL transaction that flips state.
  deps.git.fetch(task.repo_id, task.branch_name);
  const remoteSha = deps.git.remoteHeadSha(task.repo_id, task.branch_name);
  const prExisted = deps.github.prExistsForBranch(task.repo_id, task.branch_name)
    ? 1
    : 0;
  const now = deps.clock.nowISO();

  const promoted = runPromotionTransaction(deps.db, {
    taskId: task.task_id,
    attemptId: pending.attempt_id,
    consumedBudget: pending.consumed_budget,
    spawnedAt: now,
    remoteSha,
    prExisted,
  });
  if (!promoted) {
    return { task_id: task.task_id, action: "skipped_predicate" };
  }

  // Substrate work happens outside the transaction. If spawn throws, the row
  // stays in (state = running, tmux_session = NULL); recovery in Slice 4 picks
  // it up via the spawn-failure window classifier.
  const sessionName = `quay-task-${task.tmux_id}-${pending.attempt_number}`;
  try {
    deps.tmux.spawn({
      sessionName,
      worktreePath: task.worktree_path,
      promptContent,
      agentInvocation,
    });
  } catch (err) {
    return {
      task_id: task.task_id,
      action: "spawn_substrate_failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Record session AFTER successful substrate spawn so the spawn-failure
  // window (running + tmux_session NULL) is real.
  deps.db
    .query(`UPDATE attempts SET tmux_session = ? WHERE attempt_id = ?`)
    .run(sessionName, pending.attempt_id);

  return { task_id: task.task_id, action: "spawned" };
}

function recordTickError(deps: TickDeps, taskId: string, err: unknown): TickTaskResult {
  const message = err instanceof Error ? err.message : String(err);
  const now = deps.clock.nowISO();
  try {
    deps.db.exec("BEGIN");
    deps.db
      .query(`UPDATE tasks SET tick_error = ?, updated_at = ? WHERE task_id = ?`)
      .run(message, now, taskId);
    deps.db
      .query(
        `INSERT INTO events (task_id, event_type, occurred_at)
         VALUES (?, 'tick_error', ?)`,
      )
      .run(taskId, now);
    deps.db.exec("COMMIT");
  } catch {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
  }
  return { task_id: taskId, action: "tick_error", error: message };
}

interface PromotionInput {
  taskId: string;
  attemptId: number;
  consumedBudget: number;
  spawnedAt: string;
  remoteSha: string | null;
  prExisted: number;
}

function runPromotionTransaction(db: DB, p: PromotionInput): boolean {
  db.exec("BEGIN");
  try {
    const taskUpdate = db
      .query(
        `UPDATE tasks
            SET state = 'running',
                attempts_consumed = attempts_consumed + ?,
                tick_error = NULL,
                updated_at = ?
          WHERE task_id = ?
            AND state = 'queued'
            AND cancel_requested_at IS NULL`,
      )
      .run(p.consumedBudget, p.spawnedAt, p.taskId);

    const taskChanges = (taskUpdate as { changes?: number }).changes ?? 0;
    if (taskChanges === 0) {
      db.exec("ROLLBACK");
      return false;
    }

    db.query(
      `UPDATE attempts
          SET spawned_at = ?,
              remote_sha_at_spawn = ?,
              pr_existed_at_spawn = ?
        WHERE attempt_id = ? AND spawned_at IS NULL`,
    ).run(p.spawnedAt, p.remoteSha, p.prExisted, p.attemptId);

    db.query(
      `INSERT INTO events (
         task_id, attempt_id, event_type, from_state, to_state, occurred_at
       ) VALUES (?, ?, 'spawned', 'queued', 'running', ?)`,
    ).run(p.taskId, p.attemptId, p.spawnedAt);

    db.exec("COMMIT");
    return true;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}
