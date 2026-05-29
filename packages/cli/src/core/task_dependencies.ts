import type { DB } from "../db/connection.ts";
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
      eventType: "dependency_satisfied",
      now,
      eventData: { dependency_count: status.total },
    },
  );
}
