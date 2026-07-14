import { existsSync, rmSync } from "node:fs";
import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";
import type { CommandRunner } from "../ports/command_runner.ts";
import type { GitPort } from "../ports/git.ts";
import type { SupervisorLock } from "./supervisor_lock.ts";
import {
  installWorktreeDependencies,
  loadWorktreeDependencyRepo,
} from "./worktree_dependencies.ts";

export type RecreateWorktreeErrorCode =
  | "unknown_task"
  | "confirmation_required"
  | "worktree_exists"
  | "active_task";

export interface RecreateWorktreeError {
  code: RecreateWorktreeErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type RecreateWorktreeResult =
  | { ok: true; value: RecreateWorktreeValue }
  | { ok: false; error: RecreateWorktreeError };

export interface RecreateWorktreeValue {
  task_id: string;
  repo_id: string;
  branch_name: string;
  base_branch: string;
  worktree_path: string;
  recovery_base: "remote_task_branch" | "remote_base_branch";
  recovery_ref: string;
  forced: boolean;
}

export interface RecreateWorktreeDeps {
  db: DB;
  clock: Clock;
  git: GitPort;
  commandRunner: CommandRunner;
  supervisorLock: SupervisorLock;
}

export interface RecreateWorktreeInput {
  taskId: string;
  yes?: boolean;
  force?: boolean;
}

interface TaskRow {
  task_id: string;
  repo_id: string;
  state: string;
  branch_name: string;
  base_branch: string | null;
  worktree_path: string;
}

interface ActiveAttemptRow {
  attempt_id: number;
  tmux_session: string | null;
}

export async function recreate_task_worktree(
  deps: RecreateWorktreeDeps,
  input: RecreateWorktreeInput,
): Promise<RecreateWorktreeResult> {
  return deps.supervisorLock.run(() => recreateUnderLock(deps, input));
}

function recreateUnderLock(
  deps: RecreateWorktreeDeps,
  input: RecreateWorktreeInput,
): RecreateWorktreeResult {
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

  if (input.yes !== true) {
    return {
      ok: false,
      error: {
        code: "confirmation_required",
        message: "task recreate-worktree mutates git state; rerun with --yes",
        details: { task_id: task.task_id, worktree_path: task.worktree_path },
      },
    };
  }

  const activeAttempt = loadActiveAttempt(deps.db, task.task_id);
  if (activeAttempt !== null && input.force !== true) {
    return {
      ok: false,
      error: {
        code: "active_task",
        message:
          `task ${task.task_id} has an active attempt; rerun with --force only if the worker is not live`,
        details: {
          task_id: task.task_id,
          state: task.state,
          attempt_id: activeAttempt.attempt_id,
          tmux_session: activeAttempt.tmux_session,
        },
      },
    };
  }

  const pathExists = existsSync(task.worktree_path);
  if (pathExists && input.force !== true) {
    return {
      ok: false,
      error: {
        code: "worktree_exists",
        message:
          `task ${task.task_id} already has a worktree at ${task.worktree_path}; rerun with --force to recreate it`,
        details: {
          task_id: task.task_id,
          worktree_path: task.worktree_path,
        },
      },
    };
  }

  const repo = loadWorktreeDependencyRepo(deps.db, task.repo_id);
  const baseBranch = task.base_branch ?? loadRepoBaseBranch(deps.db, task.repo_id);
  const branchExistsRemotely = deps.git.hasRemoteBranch(
    task.repo_id,
    task.branch_name,
  );
  const recoveryBase: RecreateWorktreeValue["recovery_base"] =
    branchExistsRemotely ? "remote_task_branch" : "remote_base_branch";
  const recoveryRef = branchExistsRemotely
    ? `origin/${task.branch_name}`
    : `origin/${baseBranch}`;

  if (branchExistsRemotely) {
    deps.git.fetch(task.repo_id, task.branch_name);
  } else {
    deps.git.fetch(task.repo_id, baseBranch);
  }

  if (pathExists) {
    deps.git.worktreeRemove(task.worktree_path);
  } else {
    deps.git.worktreePrune(task.repo_id);
  }

  let worktreeCreated = false;
  try {
    deps.git.worktreeAddExistingBranch(
      task.repo_id,
      task.worktree_path,
      task.branch_name,
      recoveryRef,
    );
    worktreeCreated = true;
    installWorktreeDependencies(deps.commandRunner, repo, task.worktree_path);
  } catch (err) {
    if (worktreeCreated) {
      try {
        deps.git.worktreeRemove(task.worktree_path);
      } catch {
        try {
          rmSync(task.worktree_path, { recursive: true, force: true });
        } catch {}
      }
    }
    throw err;
  }

  const now = deps.clock.nowISO();
  const eventData = {
    worktree_path: task.worktree_path,
    branch_name: task.branch_name,
    base_branch: baseBranch,
    recovery_base: recoveryBase,
    recovery_ref: recoveryRef,
    forced: input.force === true,
    active_attempt_id: activeAttempt?.attempt_id ?? null,
  };
  deps.db
    .query(
      `INSERT INTO events (
         task_id, event_type, from_state, to_state, occurred_at, event_data
       ) VALUES (?, 'worktree_recreated', ?, ?, ?, ?)`,
    )
    .run(
      task.task_id,
      task.state,
      task.state,
      now,
      JSON.stringify(eventData),
    );
  deps.db
    .query(`UPDATE tasks SET tick_error = NULL, updated_at = ? WHERE task_id = ?`)
    .run(now, task.task_id);

  return {
    ok: true,
    value: {
      task_id: task.task_id,
      repo_id: task.repo_id,
      branch_name: task.branch_name,
      base_branch: baseBranch,
      worktree_path: task.worktree_path,
      recovery_base: recoveryBase,
      recovery_ref: recoveryRef,
      forced: input.force === true,
    },
  };
}

function loadTask(db: DB, taskId: string): TaskRow | null {
  return db
    .query<TaskRow, [string]>(
      `SELECT task_id, repo_id, state, branch_name, base_branch, worktree_path
         FROM tasks
        WHERE task_id = ?`,
    )
    .get(taskId) ?? null;
}

function loadActiveAttempt(db: DB, taskId: string): ActiveAttemptRow | null {
  return db
    .query<ActiveAttemptRow, [string]>(
      `SELECT attempt_id, tmux_session
         FROM attempts
        WHERE task_id = ?
          AND spawned_at IS NOT NULL
          AND ended_at IS NULL
        ORDER BY attempt_id DESC
        LIMIT 1`,
    )
    .get(taskId) ?? null;
}

function loadRepoBaseBranch(db: DB, repoId: string): string {
  const row = db
    .query<{ base_branch: string }, [string]>(
      `SELECT base_branch FROM repos WHERE repo_id = ?`,
    )
    .get(repoId);
  if (!row) {
    throw new Error(`repo ${repoId} not found for task worktree recreation`);
  }
  return row.base_branch;
}
