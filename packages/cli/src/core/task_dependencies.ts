import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";
import { enqueueOutboxItem } from "./outbox.ts";
import { transitionTaskState } from "./task_state.ts";

export const TASK_DEPENDENCY_SOURCES = ["linear", "manual", "quay"] as const;
export type TaskDependencySource = (typeof TASK_DEPENDENCY_SOURCES)[number];

export const TASK_DEPENDENCY_KINDS = ["blocked_by"] as const;
export type TaskDependencyKind = (typeof TASK_DEPENDENCY_KINDS)[number];

export const TASK_DEPENDENCY_SCOPES = ["normal", "umbrella"] as const;
export type TaskDependencyScope = (typeof TASK_DEPENDENCY_SCOPES)[number];

export const TASK_DEPENDENCY_REQUIRED_STATES = [
  "merged",
  "merged_to_feature_branch",
] as const;
export type TaskDependencyRequiredState =
  (typeof TASK_DEPENDENCY_REQUIRED_STATES)[number];

export interface CreateTaskDependencyInput {
  dependentTaskId: string;
  dependencyTaskId?: string | null;
  dependencySource: TaskDependencySource;
  dependencyExternalRef?: string | null;
  dependencyRepoId?: string | null;
  kind?: TaskDependencyKind;
  scope?: TaskDependencyScope;
  requiredState?: TaskDependencyRequiredState;
  satisfiedAt?: string | null;
  now: string;
}

export interface TaskDependencyRow {
  dependency_id: number;
  dependent_task_id: string;
  dependency_task_id: string | null;
  dependency_source: TaskDependencySource;
  dependency_external_ref: string | null;
  dependency_repo_id: string | null;
  kind: TaskDependencyKind;
  scope: TaskDependencyScope;
  required_state: TaskDependencyRequiredState;
  satisfied_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskDependencyStatus {
  total: number;
  satisfied: number;
  unsatisfied: number;
  dependencies: TaskDependencyRow[];
}

export interface WaitingDependencyTaskRow {
  task_id: string;
  external_ref: string | null;
}

interface WaitingDependencyEvaluationRow extends TaskDependencyRow {
  blocker_task_id: string | null;
  blocker_state: string | null;
}

export function createTaskDependency(
  db: DB,
  input: CreateTaskDependencyInput,
): TaskDependencyRow {
  if (
    (input.dependencyTaskId === undefined || input.dependencyTaskId === null) &&
    (input.dependencyExternalRef === undefined || input.dependencyExternalRef === null)
  ) {
    throw new Error("task dependency requires dependencyTaskId or dependencyExternalRef");
  }

  const row = db
    .query<
      TaskDependencyRow,
      [
        string,
        string | null,
        string,
        string | null,
        string | null,
        string,
        string,
        string,
        string | null,
        string,
        string,
      ]
    >(
      `INSERT INTO task_dependencies (
         dependent_task_id, dependency_task_id, dependency_source,
         dependency_external_ref, dependency_repo_id, kind, scope,
         required_state, satisfied_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING dependency_id, dependent_task_id, dependency_task_id,
                 dependency_source, dependency_external_ref, dependency_repo_id,
                 kind, scope, required_state, satisfied_at, created_at, updated_at`,
    )
    .get(
      input.dependentTaskId,
      input.dependencyTaskId ?? null,
      input.dependencySource,
      input.dependencyExternalRef ?? null,
      input.dependencyRepoId ?? null,
      input.kind ?? "blocked_by",
      input.scope ?? "normal",
      input.requiredState ?? "merged",
      input.satisfiedAt ?? null,
      input.now,
      input.now,
    );
  if (!row) throw new Error("task dependency insert returned no row");
  return row;
}

export function listTaskDependencies(db: DB, taskId: string): TaskDependencyRow[] {
  return db
    .query<TaskDependencyRow, [string]>(
      `SELECT dependency_id, dependent_task_id, dependency_task_id,
              dependency_source, dependency_external_ref, dependency_repo_id,
              kind, scope, required_state, satisfied_at, created_at, updated_at
         FROM task_dependencies
        WHERE dependent_task_id = ?
        ORDER BY satisfied_at IS NOT NULL, dependency_id`,
    )
    .all(taskId);
}

export function taskDependencyStatus(db: DB, taskId: string): TaskDependencyStatus {
  const dependencies = listTaskDependencies(db, taskId);
  const satisfied = dependencies.filter((dep) => dep.satisfied_at !== null).length;
  return {
    total: dependencies.length,
    satisfied,
    unsatisfied: dependencies.length - satisfied,
    dependencies,
  };
}

export function markTaskDependencySatisfied(
  db: DB,
  dependencyId: number,
  now: string,
): TaskDependencyRow | null {
  return (
    db
      .query<TaskDependencyRow, [string, string, number]>(
        `UPDATE task_dependencies
            SET satisfied_at = COALESCE(satisfied_at, ?),
                updated_at = ?
          WHERE dependency_id = ?
          RETURNING dependency_id, dependent_task_id, dependency_task_id,
                    dependency_source, dependency_external_ref, dependency_repo_id,
                    kind, scope, required_state, satisfied_at, created_at, updated_at`,
      )
      .get(now, now, dependencyId) ?? null
  );
}

export function satisfyDependenciesForMergedTask(
  db: DB,
  dependencyTaskId: string,
  now: string,
): TaskDependencyRow[] {
  return db
    .query<TaskDependencyRow, [string, string, string]>(
      `UPDATE task_dependencies
          SET satisfied_at = ?,
              updated_at = ?
        WHERE dependency_task_id = ?
          AND required_state = 'merged'
          AND satisfied_at IS NULL
        RETURNING dependency_id, dependent_task_id, dependency_task_id,
                  dependency_source, dependency_external_ref, dependency_repo_id,
                  kind, scope, required_state, satisfied_at, created_at, updated_at`,
    )
    .all(now, now, dependencyTaskId);
}

export function releaseTaskIfDependenciesSatisfied(
  db: DB,
  taskId: string,
  now: string,
): ReturnType<typeof transitionTaskState> {
  const status = taskDependencyStatus(db, taskId);
  if (status.total === 0 || status.unsatisfied > 0) {
    return { applied: false, reason: "wrong_state", currentState: "waiting_dependencies" };
  }
  return transitionTaskState(
    { db },
    {
      taskId,
      from: "waiting_dependencies",
      to: "queued",
      eventType: "dependencies_satisfied",
      now,
      eventData: { dependency_count: status.total },
    },
  );
}

export function listWaitingDependencyTasks(db: DB): WaitingDependencyTaskRow[] {
  return db
    .query<WaitingDependencyTaskRow, []>(
      `SELECT task_id, external_ref
         FROM tasks
        WHERE state = 'waiting_dependencies'
        ORDER BY created_at, task_id`,
    )
    .all();
}

export function enqueueDependencyWaitingOutboxItem(
  deps: { db: DB; clock: Clock },
  input: {
    taskId: string;
    sourceEventId?: number | null;
    dependencyCount: number;
    dependencies?: TaskDependencyRow[];
  },
): number {
  return enqueueOutboxItem(deps, {
    taskId: input.taskId,
    kind: "delivery.dependency_waiting",
    handlerClass: "delivery",
    sourceEventId: input.sourceEventId ?? null,
    idempotencyKey: `${input.taskId}:dependency-waiting`,
    payload: {
      dependency_count: input.dependencyCount,
      dependencies: input.dependencies?.map((dep) => ({
        dependency_id: dep.dependency_id,
        dependency_task_id: dep.dependency_task_id,
        dependency_external_ref: dep.dependency_external_ref,
        dependency_repo_id: dep.dependency_repo_id,
        dependency_source: dep.dependency_source,
        required_state: dep.required_state,
        scope: dep.scope,
      })),
    },
    routeHint: { attention: "normal" },
  });
}

export function reconcileWaitingDependencyTask(
  deps: { db: DB; clock: Clock },
  taskId: string,
  now: string,
): void {
  const dependencies = loadWaitingDependencyEvaluations(deps.db, taskId);
  for (const dep of dependencies) {
    if (dependencyIsSatisfied(dep)) {
      markTaskDependencySatisfied(deps.db, dep.dependency_id, now);
      continue;
    }
    if (dependencyHasFailedBlocker(dep)) {
      enqueueDependencyFailedOutboxItem(deps, dep);
    }
  }
  releaseTaskIfDependenciesSatisfied(deps.db, taskId, now);
}

function loadWaitingDependencyEvaluations(
  db: DB,
  taskId: string,
): WaitingDependencyEvaluationRow[] {
  return db
    .query<WaitingDependencyEvaluationRow, [string]>(
      `SELECT d.dependency_id, d.dependent_task_id, d.dependency_task_id,
              d.dependency_source, d.dependency_external_ref, d.dependency_repo_id,
              d.kind, d.scope, d.required_state, d.satisfied_at,
              d.created_at, d.updated_at,
              COALESCE(blocker.task_id, external_blocker.task_id) AS blocker_task_id,
              COALESCE(blocker.state, external_blocker.state) AS blocker_state
         FROM task_dependencies d
         LEFT JOIN tasks blocker
           ON blocker.task_id = d.dependency_task_id
         LEFT JOIN tasks external_blocker
           ON d.dependency_task_id IS NULL
          AND d.dependency_external_ref IS NOT NULL
          AND external_blocker.external_ref = d.dependency_external_ref
          AND (
                d.dependency_repo_id IS NULL
             OR external_blocker.repo_id = d.dependency_repo_id
          )
        WHERE d.dependent_task_id = ?
        ORDER BY d.dependency_id`,
    )
    .all(taskId);
}

function dependencyIsSatisfied(dep: WaitingDependencyEvaluationRow): boolean {
  return (
    dep.satisfied_at === null &&
    dep.scope === "normal" &&
    dep.required_state === "merged" &&
    dep.blocker_state === "merged"
  );
}

function dependencyHasFailedBlocker(dep: WaitingDependencyEvaluationRow): boolean {
  return (
    dep.satisfied_at === null &&
    (dep.blocker_state === "cancelled" || dep.blocker_state === "closed_unmerged")
  );
}

function enqueueDependencyFailedOutboxItem(
  deps: { db: DB; clock: Clock },
  dep: WaitingDependencyEvaluationRow,
): number {
  return enqueueOutboxItem(deps, {
    taskId: dep.dependent_task_id,
    kind: "delivery.dependency_failed",
    handlerClass: "delivery",
    idempotencyKey: `${dep.dependent_task_id}:dependency-failed:${dep.dependency_id}`,
    payload: {
      dependency_id: dep.dependency_id,
      dependency_task_id: dep.blocker_task_id ?? dep.dependency_task_id,
      dependency_external_ref: dep.dependency_external_ref,
      dependency_repo_id: dep.dependency_repo_id,
      dependency_source: dep.dependency_source,
      blocker_state: dep.blocker_state,
    },
    routeHint: { attention: "high" },
  });
}
