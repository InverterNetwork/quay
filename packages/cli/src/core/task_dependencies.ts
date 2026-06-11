import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";
import { QuayError } from "./errors.ts";
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
  umbrellaWorkflowId?: number | null;
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
  umbrella_workflow_id: number | null;
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
  blocker_run_number: number | null;
  blocker_supersedes_task_id: string | null;
}

export function createTaskDependency(
  db: DB,
  input: CreateTaskDependencyInput,
): TaskDependencyRow {
  const scope = input.scope ?? "normal";
  if (
    (input.dependencyTaskId === undefined || input.dependencyTaskId === null) &&
    (input.dependencyExternalRef === undefined || input.dependencyExternalRef === null)
  ) {
    throw new Error("task dependency requires dependencyTaskId or dependencyExternalRef");
  }
  validateTaskDependencyInput(db, input, scope);

  const row = db
    .query<
      TaskDependencyRow,
      [
        string,
        string | null,
        string,
        string | null,
        string | null,
        number | null,
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
         dependency_external_ref, dependency_repo_id, umbrella_workflow_id,
         kind, scope, required_state, satisfied_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING dependency_id, dependent_task_id, dependency_task_id,
                 dependency_source, dependency_external_ref, dependency_repo_id,
                 umbrella_workflow_id, kind, scope, required_state,
                 satisfied_at, created_at, updated_at`,
    )
    .get(
      input.dependentTaskId,
      input.dependencyTaskId ?? null,
      input.dependencySource,
      input.dependencyExternalRef ?? null,
      input.dependencyRepoId ?? null,
      input.umbrellaWorkflowId ?? null,
      input.kind ?? "blocked_by",
      scope,
      input.requiredState ?? "merged",
      input.satisfiedAt ?? null,
      input.now,
      input.now,
    );
  if (!row) throw new Error("task dependency insert returned no row");
  return row;
}

function validateTaskDependencyInput(
  db: DB,
  input: CreateTaskDependencyInput,
  scope: TaskDependencyScope,
): void {
  if (scope === "normal") {
    if (input.umbrellaWorkflowId !== undefined && input.umbrellaWorkflowId !== null) {
      throw new QuayError(
        "validation_error",
        "normal task dependencies must not reference an umbrella workflow",
        { umbrella_workflow_id: input.umbrellaWorkflowId },
      );
    }
    validateNoDependencyCycle(db, input);
    return;
  }

  if (input.umbrellaWorkflowId === undefined || input.umbrellaWorkflowId === null) {
    throw new QuayError(
      "validation_error",
      "umbrella task dependencies require umbrella_workflow_id",
      { dependent_task_id: input.dependentTaskId },
    );
  }

  const dependentLinked = db
    .query<{ n: number }, [number, string]>(
      `SELECT 1 AS n
         FROM umbrella_tasks
        WHERE umbrella_workflow_id = ?
          AND task_id = ?
        LIMIT 1`,
    )
    .get(input.umbrellaWorkflowId, input.dependentTaskId);
  if (dependentLinked === null || dependentLinked === undefined) {
    throw new QuayError(
      "validation_error",
      "umbrella dependency dependent task is not linked to the umbrella workflow",
      {
        umbrella_workflow_id: input.umbrellaWorkflowId,
        dependent_task_id: input.dependentTaskId,
      },
    );
  }

  const resolvedDependencyTaskId =
    input.dependencyTaskId ??
    resolveDependencyTaskIdByExternalRef(
      db,
      input.dependencyExternalRef ?? null,
      input.dependencyRepoId ?? null,
    );
  if (resolvedDependencyTaskId !== null) {
    const dependencyLinked = db
      .query<{ n: number }, [number, string]>(
        `SELECT 1 AS n
           FROM umbrella_tasks
          WHERE umbrella_workflow_id = ?
            AND task_id = ?
          LIMIT 1`,
      )
      .get(input.umbrellaWorkflowId, resolvedDependencyTaskId);
    if (dependencyLinked === null || dependencyLinked === undefined) {
      throw new QuayError(
        "validation_error",
        "umbrella dependency blocker task is not linked to the same umbrella workflow",
        {
          umbrella_workflow_id: input.umbrellaWorkflowId,
          dependent_task_id: input.dependentTaskId,
          dependency_task_id: resolvedDependencyTaskId,
        },
      );
    }
  }

  if (input.dependencyExternalRef !== undefined && input.dependencyExternalRef !== null) {
    const expected = db
      .query<{ n: number }, [number, string]>(
        `SELECT 1 AS n
           FROM umbrella_expected_tasks
          WHERE umbrella_workflow_id = ?
            AND external_ref = ?
          LIMIT 1`,
      )
      .get(input.umbrellaWorkflowId, input.dependencyExternalRef);
    if (expected === null || expected === undefined) {
      throw new QuayError(
        "validation_error",
        "umbrella dependency external ref is not expected in the umbrella workflow",
        {
          umbrella_workflow_id: input.umbrellaWorkflowId,
          dependent_task_id: input.dependentTaskId,
          dependency_external_ref: input.dependencyExternalRef,
        },
      );
    }
  }

  validateNoDependencyCycle(db, input);
}

function validateNoDependencyCycle(
  db: DB,
  input: CreateTaskDependencyInput,
): void {
  const dependencyTaskId =
    input.dependencyTaskId ??
    resolveDependencyTaskIdByExternalRef(
      db,
      input.dependencyExternalRef ?? null,
      input.dependencyRepoId ?? null,
    );
  if (dependencyTaskId === null) return;
  if (dependencyTaskId === input.dependentTaskId) {
    throwDependencyCycle(input.dependentTaskId, dependencyTaskId);
  }
  const closesCycle = db
    .query<{ n: number }, [string, string]>(
      `WITH RECURSIVE dependency_graph(task_id) AS (
         SELECT ? AS task_id
         UNION
         SELECT COALESCE(td.dependency_task_id, external_task.task_id)
           FROM task_dependencies td
           JOIN dependency_graph dg
             ON td.dependent_task_id = dg.task_id
           LEFT JOIN tasks external_task
             ON td.dependency_task_id IS NULL
            AND td.dependency_external_ref IS NOT NULL
            AND external_task.external_ref = td.dependency_external_ref
            AND (
                  td.dependency_repo_id IS NULL
               OR external_task.repo_id = td.dependency_repo_id
            )
          WHERE COALESCE(td.dependency_task_id, external_task.task_id) IS NOT NULL
       )
       SELECT 1 AS n
         FROM dependency_graph
        WHERE task_id = ?
        LIMIT 1`,
    )
    .get(dependencyTaskId, input.dependentTaskId);
  if (closesCycle !== null && closesCycle !== undefined) {
    throwDependencyCycle(input.dependentTaskId, dependencyTaskId);
  }
}

function resolveDependencyTaskIdByExternalRef(
  db: DB,
  externalRef: string | null,
  repoId: string | null,
): string | null {
  if (externalRef === null) return null;
  return (
    db
      .query<{ task_id: string }, [string, string | null, string | null]>(
        `SELECT t.task_id
           FROM tasks t
          WHERE t.external_ref = ?
            AND (? IS NULL OR t.repo_id = ?)
          ORDER BY
            COALESCE(t.run_number, 0) DESC,
            t.created_at DESC,
            t.task_id DESC
          LIMIT 1`,
      )
      .get(externalRef, repoId, repoId)?.task_id ?? null
  );
}

function throwDependencyCycle(
  dependentTaskId: string,
  dependencyTaskId: string,
): never {
  throw new QuayError(
    "dependency_cycle",
    "task dependency would create a cycle",
    {
      dependent_task_id: dependentTaskId,
      dependency_task_id: dependencyTaskId,
    },
  );
}

export function listTaskDependencies(db: DB, taskId: string): TaskDependencyRow[] {
  return db
    .query<TaskDependencyRow, [string]>(
      `SELECT dependency_id, dependent_task_id, dependency_task_id,
              dependency_source, dependency_external_ref, dependency_repo_id,
              umbrella_workflow_id, kind, scope, required_state, satisfied_at,
              created_at, updated_at
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
                    umbrella_workflow_id, kind, scope, required_state,
                    satisfied_at, created_at, updated_at`,
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
    .query<TaskDependencyRow, [string, string, string, string]>(
      `UPDATE task_dependencies
          SET satisfied_at = ?,
              updated_at = ?
        WHERE satisfied_at IS NULL
          AND required_state = 'merged'
          AND (
                dependency_task_id = ?
             OR dependency_task_id IN (
                  SELECT older.task_id
                    FROM tasks merged
                    JOIN tasks older
                      ON older.work_item_id = merged.work_item_id
                   WHERE merged.task_id = ?
                     AND merged.work_item_id IS NOT NULL
                )
          )
        RETURNING dependency_id, dependent_task_id, dependency_task_id,
                  dependency_source, dependency_external_ref, dependency_repo_id,
                  umbrella_workflow_id, kind, scope, required_state,
                  satisfied_at, created_at, updated_at`,
    )
    .all(now, now, dependencyTaskId, dependencyTaskId);
}

export function satisfyDependenciesForMergedToFeatureBranchTask(
  db: DB,
  dependencyTaskId: string,
  now: string,
): TaskDependencyRow[] {
  return db
    .query<TaskDependencyRow, [string, string, string, string]>(
      `UPDATE task_dependencies
          SET satisfied_at = ?,
              updated_at = ?
        WHERE satisfied_at IS NULL
          AND required_state = 'merged_to_feature_branch'
          AND (
                dependency_task_id = ?
             OR dependency_task_id IN (
                  SELECT older.task_id
                    FROM tasks merged
                    JOIN tasks older
                      ON older.work_item_id = merged.work_item_id
                   WHERE merged.task_id = ?
                     AND merged.work_item_id IS NOT NULL
                )
          )
        RETURNING dependency_id, dependent_task_id, dependency_task_id,
                  dependency_source, dependency_external_ref, dependency_repo_id,
                  umbrella_workflow_id, kind, scope, required_state,
                  satisfied_at, created_at, updated_at`,
    )
    .all(now, now, dependencyTaskId, dependencyTaskId);
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
        umbrella_workflow_id: dep.umbrella_workflow_id,
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
              d.umbrella_workflow_id, d.kind, d.scope, d.required_state, d.satisfied_at,
              d.created_at, d.updated_at,
              COALESCE(latest_direct_blocker.task_id, latest_external_blocker.task_id, blocker.task_id, external_blocker.task_id) AS blocker_task_id,
              COALESCE(latest_direct_blocker.state, latest_external_blocker.state, blocker.state, external_blocker.state) AS blocker_state,
              COALESCE(latest_direct_blocker.run_number, latest_external_blocker.run_number, blocker.run_number, external_blocker.run_number) AS blocker_run_number,
              COALESCE(latest_direct_blocker.supersedes_task_id, latest_external_blocker.supersedes_task_id, blocker.supersedes_task_id, external_blocker.supersedes_task_id) AS blocker_supersedes_task_id
         FROM task_dependencies d
         LEFT JOIN tasks blocker
           ON blocker.task_id = d.dependency_task_id
         LEFT JOIN tasks latest_direct_blocker
           ON blocker.work_item_id IS NOT NULL
          AND latest_direct_blocker.task_id = (
                SELECT latest.task_id
                  FROM tasks latest
                 WHERE latest.work_item_id = blocker.work_item_id
                 ORDER BY latest.run_number DESC, latest.created_at DESC, latest.task_id DESC
                 LIMIT 1
              )
         LEFT JOIN tasks external_blocker
           ON d.dependency_task_id IS NULL
          AND d.dependency_external_ref IS NOT NULL
          AND external_blocker.external_ref = d.dependency_external_ref
          AND (
                d.dependency_repo_id IS NULL
             OR external_blocker.repo_id = d.dependency_repo_id
          )
          AND external_blocker.task_id = (
                SELECT candidate.task_id
                  FROM tasks candidate
                 WHERE candidate.external_ref = d.dependency_external_ref
                   AND (
                         d.dependency_repo_id IS NULL
                      OR candidate.repo_id = d.dependency_repo_id
                   )
                 ORDER BY COALESCE(candidate.run_number, 0) DESC,
                          candidate.created_at DESC,
                          candidate.task_id DESC
                 LIMIT 1
              )
         LEFT JOIN tasks latest_external_blocker
           ON external_blocker.work_item_id IS NOT NULL
          AND latest_external_blocker.task_id = (
                SELECT latest.task_id
                  FROM tasks latest
                 WHERE latest.work_item_id = external_blocker.work_item_id
                 ORDER BY latest.run_number DESC, latest.created_at DESC, latest.task_id DESC
                 LIMIT 1
              )
        WHERE d.dependent_task_id = ?
        ORDER BY d.dependency_id`,
    )
    .all(taskId);
}

function dependencyIsSatisfied(dep: WaitingDependencyEvaluationRow): boolean {
  if (dep.satisfied_at !== null) return false;
  if (
    dep.scope === "normal" &&
    dep.required_state === "merged" &&
    dep.blocker_state === "merged"
  ) {
    return true;
  }
  return (
    dep.scope === "umbrella" &&
    dep.required_state === "merged_to_feature_branch" &&
    dep.blocker_state === "merged_to_feature_branch"
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
      umbrella_workflow_id: dep.umbrella_workflow_id,
      dependency_source: dep.dependency_source,
      blocker_state: dep.blocker_state,
      blocker_run_number: dep.blocker_run_number,
      blocker_supersedes_task_id: dep.blocker_supersedes_task_id,
      rerun_available:
        dep.blocker_state === "cancelled" || dep.blocker_state === "closed_unmerged",
      rerun_command:
        dep.dependency_external_ref !== null
          ? `quay rerun --linear-issue ${dep.dependency_external_ref}`
          : null,
    },
    routeHint: { attention: "high" },
  });
}
