import { readFileSync, rmSync } from "node:fs";
import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";
import type { GitPort } from "../ports/git.ts";
import type { TmuxPort } from "../ports/tmux.ts";
import type { CommandRunner } from "../ports/command_runner.ts";
import type { IdGenerator } from "../ports/id_generator.ts";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { AgentResolver } from "./agents.ts";
import type { SupervisorLock } from "./supervisor_lock.ts";
import { enqueue, type EnqueueDeps, type EnqueueResult } from "./enqueue.ts";
import { cancelOpenOrchestratorHandoffs } from "./orchestrator_handoffs.ts";
import {
  isTaskState,
  transitionTaskState,
} from "./task_state.ts";

export type RetargetErrorCode =
  | "unknown_task"
  | "unknown_repo"
  | "repo_archived"
  | "wrong_state"
  | "confirmation_required"
  | "missing_task_objective";

export interface RetargetError {
  code: RetargetErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type RetargetResult =
  | { ok: true; value: RetargetTaskValue }
  | { ok: false; error: RetargetError };

export interface RetargetTaskValue {
  task_id: string;
  state: "cancelled";
  retargeted_task_id: string;
  retargeted_repo_id: string;
  retargeted_branch_name: string;
  retargeted_worktree_path: string;
}

export interface RetargetDeps {
  db: DB;
  clock: Clock;
  ids: IdGenerator;
  git: GitPort;
  tmux: TmuxPort;
  commandRunner: CommandRunner;
  artifactStore: ArtifactStore;
  supervisorLock: SupervisorLock;
  paths: {
    reposRoot: string;
    worktreesRoot: string;
    artifactsRoot: string;
  };
  agentResolver?: AgentResolver;
  referenceReposRoot?: string | undefined;
}

export interface RetargetTaskInput {
  taskId: string;
  targetRepo: string;
  baseBranch?: string;
  yes?: boolean;
}

interface SourceTaskRow {
  task_id: string;
  repo_id: string;
  external_ref: string | null;
  state: string;
  branch_name: string;
  tmux_id: string;
  worktree_path: string;
  retry_budget: number;
  slack_thread_ref: string | null;
  authors_json: string | null;
  worker_execution: "oneshot" | "goal";
  pr_screenshots_requested: number;
  pr_screenshots_required: number;
  worker_agent: string | null;
  worker_model: string | null;
  reviewer_agent: string | null;
  reviewer_model: string | null;
  cancel_requested_at: string | null;
  claim_id: string | null;
}

interface RepoRow {
  repo_id: string;
  archived_at: string | null;
}

interface ArtifactRow {
  file_path: string;
}

interface ActiveAttemptRow {
  attempt_id: number;
  tmux_session: string | null;
}

const TERMINAL_STATES = new Set(["cancelled", "merged", "closed_unmerged"]);

export async function task_retarget(
  deps: RetargetDeps,
  input: RetargetTaskInput,
): Promise<RetargetResult> {
  return deps.supervisorLock.run(() => retargetUnderLock(deps, input));
}

function retargetUnderLock(
  deps: RetargetDeps,
  input: RetargetTaskInput,
): RetargetResult {
  const source = loadSourceTask(deps.db, input.taskId);
  if (source === null) {
    return {
      ok: false,
      error: {
        code: "unknown_task",
        message: `task ${input.taskId} not found`,
        details: { task_id: input.taskId },
      },
    };
  }
  if (TERMINAL_STATES.has(source.state)) {
    return {
      ok: false,
      error: {
        code: "wrong_state",
        message: `task ${input.taskId} is already terminal (${source.state})`,
        details: { task_id: input.taskId, state: source.state },
      },
    };
  }
  if (!isTaskState(source.state)) {
    return {
      ok: false,
      error: {
        code: "wrong_state",
        message: `task ${input.taskId} has unknown state ${source.state}`,
        details: { task_id: input.taskId, state: source.state },
      },
    };
  }
  if (input.yes !== true) {
    return {
      ok: false,
      error: {
        code: "confirmation_required",
        message: "task retarget mutates the source task; rerun with --yes",
        details: { task_id: input.taskId, state: source.state },
      },
    };
  }
  const targetRepo = loadRepo(deps.db, input.targetRepo);
  if (targetRepo === null) {
    return {
      ok: false,
      error: {
        code: "unknown_repo",
        message: `repo "${input.targetRepo}" not found`,
        details: { repo_id: input.targetRepo },
      },
    };
  }
  if (targetRepo.archived_at !== null) {
    return {
      ok: false,
      error: {
        code: "repo_archived",
        message: `repo "${input.targetRepo}" is archived`,
        details: { repo_id: input.targetRepo },
      },
    };
  }

  const objective = loadArtifactContent(deps.db, input.taskId, "task_objective");
  if (objective === null) {
    return {
      ok: false,
      error: {
        code: "missing_task_objective",
        message: `task ${input.taskId} has no task_objective artifact`,
        details: { task_id: input.taskId },
      },
    };
  }
  const ticketSnapshot = loadArtifactContent(deps.db, input.taskId, "ticket_snapshot");
  const tags = loadTags(deps.db, input.taskId);

  const enqueueDeps: EnqueueDeps = {
    db: deps.db,
    clock: deps.clock,
    ids: deps.ids,
    git: deps.git,
    commandRunner: deps.commandRunner,
    artifactStore: deps.artifactStore,
    paths: deps.paths,
    retryBudget: source.retry_budget,
  };
  if (deps.agentResolver !== undefined) {
    enqueueDeps.agentResolver = deps.agentResolver;
  }
  if (deps.referenceReposRoot !== undefined) {
    enqueueDeps.referenceReposRoot = deps.referenceReposRoot;
  }
  const enqueueInput: {
    repo_id: string;
    brief: string;
    ticket_snapshot: string | null;
    external_ref: string | null;
    slack_thread_ref: string | null;
    tags: string[];
    authors_json: string | null;
    worker_execution: "oneshot" | "goal";
    worker_agent: string | null;
    worker_model: string | null;
    reviewer_agent: string | null;
    reviewer_model: string | null;
    base_branch?: string;
    request_pr_screenshots: boolean;
    require_pr_screenshots: boolean;
  } = {
    repo_id: input.targetRepo,
    brief: objective,
    ticket_snapshot: ticketSnapshot,
    external_ref: source.external_ref,
    slack_thread_ref: source.slack_thread_ref,
    tags,
    authors_json: source.authors_json,
    worker_execution: source.worker_execution,
    worker_agent: source.worker_agent,
    worker_model: source.worker_model,
    reviewer_agent: source.reviewer_agent,
    reviewer_model: source.reviewer_model,
    request_pr_screenshots: source.pr_screenshots_requested === 1,
    require_pr_screenshots: source.pr_screenshots_required === 1,
  };
  if (input.baseBranch !== undefined) {
    enqueueInput.base_branch = input.baseBranch;
  }
  const cloned = enqueue(enqueueDeps, enqueueInput);

  const now = deps.clock.nowISO();
  const activeAttempt =
    source.state === "running" ? loadActiveAttempt(deps.db, input.taskId) : null;
  deps.db.exec("BEGIN");
  try {
    deps.db
      .query(`UPDATE tasks SET retargeted_from_task_id = ? WHERE task_id = ?`)
      .run(input.taskId, cloned.task_id);

    if (activeAttempt !== null) {
      deps.db
        .query(
          `UPDATE attempts
              SET exit_kind = 'killed_cancel',
                  ended_at = ?,
                  kill_intent = NULL
            WHERE attempt_id = ? AND ended_at IS NULL`,
        )
        .run(now, activeAttempt.attempt_id);
    }

    const transition = transitionTaskState(deps, {
      taskId: input.taskId,
      from: source.state,
      to: "cancelled",
      eventType: "retargeted",
      attemptId: activeAttempt?.attempt_id ?? null,
      now,
      updates: { clearTickError: true, clearClaim: true },
      respectCancelRequest: false,
      eventData: retargetEventData(source, input, cloned),
    });
    if (!transition.applied) {
      throw new Error(`retarget transition failed: ${transition.reason}`);
    }
    cancelOpenOrchestratorHandoffs(deps, input.taskId);
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }

  cleanupSourceSubstrate(deps, source, activeAttempt?.tmux_session ?? null);
  return {
    ok: true,
    value: {
      task_id: input.taskId,
      state: "cancelled",
      retargeted_task_id: cloned.task_id,
      retargeted_repo_id: input.targetRepo,
      retargeted_branch_name: cloned.branch_name,
      retargeted_worktree_path: cloned.worktree_path,
    },
  };
}

function retargetEventData(
  source: SourceTaskRow,
  input: RetargetTaskInput,
  cloned: EnqueueResult,
): Record<string, unknown> {
  return {
    source_repo_id: source.repo_id,
    target_repo_id: input.targetRepo,
    target_task_id: cloned.task_id,
    target_branch_name: cloned.branch_name,
    target_worktree_path: cloned.worktree_path,
    base_branch_override: input.baseBranch ?? null,
  };
}

function cleanupSourceSubstrate(
  deps: RetargetDeps,
  source: SourceTaskRow,
  activeTmuxSession: string | null,
): void {
  if (source.state === "running" && activeTmuxSession !== null) {
    try {
      deps.tmux.kill(activeTmuxSession);
    } catch {}
  }
  try {
    deps.git.worktreeRemove(source.worktree_path);
  } catch {
    try {
      rmSync(source.worktree_path, { recursive: true, force: true });
    } catch {}
  }
  try {
    deps.git.branchDelete(source.repo_id, source.branch_name);
  } catch {}
}

function loadSourceTask(db: DB, taskId: string): SourceTaskRow | null {
  return (
    db
      .query<SourceTaskRow, [string]>(
        `SELECT task_id, repo_id, external_ref, state, branch_name, tmux_id,
                worktree_path, retry_budget, slack_thread_ref, authors_json,
                worker_execution, pr_screenshots_requested,
                pr_screenshots_required, worker_agent, worker_model,
                reviewer_agent, reviewer_model, cancel_requested_at, claim_id
           FROM tasks
          WHERE task_id = ?`,
      )
      .get(taskId) ?? null
  );
}

function loadRepo(db: DB, repoId: string): RepoRow | null {
  return (
    db
      .query<RepoRow, [string]>(
        `SELECT repo_id, archived_at FROM repos WHERE repo_id = ?`,
      )
      .get(repoId) ?? null
  );
}

function loadArtifactContent(
  db: DB,
  taskId: string,
  kind: string,
): string | null {
  const row =
    db
      .query<ArtifactRow, [string, string]>(
        `SELECT file_path
           FROM artifacts
          WHERE task_id = ? AND kind = ? AND attempt_id IS NULL
          ORDER BY artifact_id DESC
          LIMIT 1`,
      )
      .get(taskId, kind) ?? null;
  if (row === null) return null;
  return readFileSync(row.file_path, "utf8");
}

function loadTags(db: DB, taskId: string): string[] {
  return db
    .query<{ tag: string }, [string]>(
      `SELECT tag FROM task_tags WHERE task_id = ? ORDER BY tag ASC`,
    )
    .all(taskId)
    .map((row) => row.tag);
}

function loadActiveAttempt(db: DB, taskId: string): ActiveAttemptRow | null {
  return (
    db
      .query<ActiveAttemptRow, [string]>(
        `SELECT attempt_id, tmux_session
           FROM attempts
          WHERE task_id = ?
            AND spawned_at IS NOT NULL
            AND ended_at IS NULL
          ORDER BY attempt_id DESC
          LIMIT 1`,
      )
      .get(taskId) ?? null
  );
}
