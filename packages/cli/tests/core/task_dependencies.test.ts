import { expect, test } from "bun:test";
import {
  createTaskDependency,
  markTaskDependencySatisfied,
  reconcileWaitingDependencyTask,
  releaseTaskIfDependenciesSatisfied,
  taskDependencyStatus,
} from "../../src/core/task_dependencies.ts";
import { transitionTaskState } from "../../src/core/task_state.ts";
import { createHarness } from "../support/harness.ts";
import { insertRepo, insertTask } from "../support/fixtures.ts";

function insertUmbrellaWorkflow(db: ReturnType<typeof createHarness>["db"], repoId: string): number {
  const row = db
    .query<{ umbrella_workflow_id: number }, [string, string, string, string, string, string]>(
      `INSERT INTO umbrella_workflows (
         external_ref, repo_id, base_branch, feature_branch, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       RETURNING umbrella_workflow_id`,
    )
    .get(
      "BRIX-1509",
      repoId,
      "dev",
      "quay/umbrella/BRIX-1509",
      "2026-05-29T09:00:00.000Z",
      "2026-05-29T09:00:00.000Z",
    );
  if (!row) throw new Error("workflow insert failed");
  return row.umbrella_workflow_id;
}

function insertExpectedUmbrellaTask(
  db: ReturnType<typeof createHarness>["db"],
  umbrellaWorkflowId: number,
  externalRef: string,
): void {
  db.query(
    `INSERT INTO umbrella_expected_tasks (
       umbrella_workflow_id, external_ref, title, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    umbrellaWorkflowId,
    externalRef,
    `Task ${externalRef}`,
    "2026-05-29T09:00:00.000Z",
    "2026-05-29T09:00:00.000Z",
  );
}

function linkUmbrellaTask(
  db: ReturnType<typeof createHarness>["db"],
  umbrellaWorkflowId: number,
  taskId: string,
  externalRef: string,
): void {
  db.query(
    `INSERT INTO umbrella_tasks (
       umbrella_workflow_id, task_id, external_ref, created_at
     ) VALUES (?, ?, ?, ?)`,
  ).run(
    umbrellaWorkflowId,
    taskId,
    externalRef,
    "2026-05-29T09:00:00.000Z",
  );
}

test("task dependencies persist status and release waiting task when satisfied", () => {
  const h = createHarness();
  try {
    const repoId = insertRepo(h.db, "repo-deps");
    const dependencyTaskId = insertTask(h.db, {
      taskId: "task-dependency",
      repoId,
      state: "merged",
    });
    const dependentTaskId = insertTask(h.db, {
      taskId: "task-dependent",
      repoId,
      state: "queued",
    });

    const dep = createTaskDependency(h.db, {
      dependentTaskId,
      dependencyTaskId,
      dependencySource: "manual",
      dependencyExternalRef: "BRIX-1505",
      dependencyRepoId: repoId,
      scope: "normal",
      requiredState: "merged",
      now: "2026-05-29T10:00:00.000Z",
    });

    const waiting = transitionTaskState(
      { db: h.db },
      {
        taskId: dependentTaskId,
        from: "queued",
        to: "waiting_dependencies",
        eventType: "dependency_waiting",
        now: "2026-05-29T10:00:01.000Z",
      },
    );
    expect(waiting.applied).toBe(true);
    expect(taskDependencyStatus(h.db, dependentTaskId)).toMatchObject({
      total: 1,
      satisfied: 0,
      unsatisfied: 1,
    });

    expect(
      releaseTaskIfDependenciesSatisfied(
        h.db,
        dependentTaskId,
        "2026-05-29T10:00:02.000Z",
      ),
    ).toMatchObject({ applied: false });

    markTaskDependencySatisfied(h.db, dep.dependency_id, "2026-05-29T10:00:03.000Z");
    const released = releaseTaskIfDependenciesSatisfied(
      h.db,
      dependentTaskId,
      "2026-05-29T10:00:04.000Z",
    );
    expect(released).toMatchObject({
      applied: true,
      from: "waiting_dependencies",
      to: "queued",
    });

    const row = h.db
      .query<{ state: string }, [string]>(
        `SELECT state FROM tasks WHERE task_id = ?`,
      )
      .get(dependentTaskId);
    expect(row?.state).toBe("queued");

    const events = h.db
      .query<{ event_type: string; from_state: string | null; to_state: string | null }, [string]>(
        `SELECT event_type, from_state, to_state
           FROM events
          WHERE task_id = ?
          ORDER BY event_id`,
      )
      .all(dependentTaskId);
    expect(events).toEqual([
      {
        event_type: "dependency_waiting",
        from_state: "queued",
        to_state: "waiting_dependencies",
      },
      {
        event_type: "dependencies_satisfied",
        from_state: "waiting_dependencies",
        to_state: "queued",
      },
    ]);
  } finally {
    h.cleanup();
  }
});

test("umbrella dependencies wait for merged_to_feature_branch", () => {
  const h = createHarness();
  try {
    const repoId = insertRepo(h.db, "repo-umbrella-deps");
    const dependencyTaskId = insertTask(h.db, {
      taskId: "task-umbrella-dependency",
      repoId,
      state: "merged",
    });
    const dependentTaskId = insertTask(h.db, {
      taskId: "task-umbrella-dependent",
      repoId,
      state: "waiting_dependencies",
    });
    const workflowId = insertUmbrellaWorkflow(h.db, repoId);
    insertExpectedUmbrellaTask(h.db, workflowId, "BRIX-1508");
    insertExpectedUmbrellaTask(h.db, workflowId, "BRIX-1509");
    linkUmbrellaTask(h.db, workflowId, dependencyTaskId, "BRIX-1508");
    linkUmbrellaTask(h.db, workflowId, dependentTaskId, "BRIX-1509");

    createTaskDependency(h.db, {
      dependentTaskId,
      dependencyTaskId,
      dependencySource: "quay",
      dependencyExternalRef: "BRIX-1508",
      dependencyRepoId: repoId,
      umbrellaWorkflowId: workflowId,
      scope: "umbrella",
      requiredState: "merged_to_feature_branch",
      now: "2026-05-29T10:00:00.000Z",
    });

    reconcileWaitingDependencyTask(
      { db: h.db, clock: h.clock },
      dependentTaskId,
      "2026-05-29T10:00:01.000Z",
    );
    expect(taskDependencyStatus(h.db, dependentTaskId)).toMatchObject({
      satisfied: 0,
      unsatisfied: 1,
    });

    h.db
      .query(`UPDATE tasks SET state = 'merged_to_feature_branch' WHERE task_id = ?`)
      .run(dependencyTaskId);
    reconcileWaitingDependencyTask(
      { db: h.db, clock: h.clock },
      dependentTaskId,
      "2026-05-29T10:00:02.000Z",
    );

    expect(taskDependencyStatus(h.db, dependentTaskId)).toMatchObject({
      satisfied: 1,
      unsatisfied: 0,
    });
    const row = h.db
      .query<{ state: string }, [string]>(
        `SELECT state FROM tasks WHERE task_id = ?`,
      )
      .get(dependentTaskId);
    expect(row?.state).toBe("queued");
  } finally {
    h.cleanup();
  }
});

test("duplicate dependency edges are rejected by the unique edge index", () => {
  const h = createHarness();
  try {
    const repoId = insertRepo(h.db, "repo-deps-duplicates");
    const dependencyTaskId = insertTask(h.db, {
      taskId: "task-dependency-duplicate",
      repoId,
      state: "queued",
    });
    const dependentTaskId = insertTask(h.db, {
      taskId: "task-dependent-duplicate",
      repoId,
      state: "waiting_dependencies",
    });

    createTaskDependency(h.db, {
      dependentTaskId,
      dependencyTaskId,
      dependencySource: "linear",
      dependencyExternalRef: "BRIX-1600",
      dependencyRepoId: repoId,
      now: "2026-05-29T10:00:00.000Z",
    });

    expect(() =>
      createTaskDependency(h.db, {
        dependentTaskId,
        dependencyTaskId,
        dependencySource: "linear",
        dependencyExternalRef: "BRIX-1600",
        dependencyRepoId: repoId,
        now: "2026-05-29T10:00:01.000Z",
      }),
    ).toThrow();
  } finally {
    h.cleanup();
  }
});

test("umbrella dependencies must reference the same umbrella workflow", () => {
  const h = createHarness();
  try {
    const repoId = insertRepo(h.db, "repo-deps-umbrella-validation");
    const dependencyTaskId = insertTask(h.db, {
      taskId: "task-umbrella-valid-blocker",
      repoId,
      state: "queued",
    });
    const dependentTaskId = insertTask(h.db, {
      taskId: "task-umbrella-valid-dependent",
      repoId,
      state: "waiting_dependencies",
    });
    const outsideTaskId = insertTask(h.db, {
      taskId: "task-umbrella-outside",
      repoId,
      state: "queued",
    });
    h.db
      .query(`UPDATE tasks SET external_ref = ? WHERE task_id = ?`)
      .run("BRIX-1702", outsideTaskId);
    const workflowId = insertUmbrellaWorkflow(h.db, repoId);
    insertExpectedUmbrellaTask(h.db, workflowId, "BRIX-1700");
    insertExpectedUmbrellaTask(h.db, workflowId, "BRIX-1701");
    insertExpectedUmbrellaTask(h.db, workflowId, "BRIX-1702");
    linkUmbrellaTask(h.db, workflowId, dependencyTaskId, "BRIX-1700");
    linkUmbrellaTask(h.db, workflowId, dependentTaskId, "BRIX-1701");

    const dep = createTaskDependency(h.db, {
      dependentTaskId,
      dependencyTaskId,
      dependencySource: "linear",
      dependencyExternalRef: "BRIX-1700",
      dependencyRepoId: repoId,
      umbrellaWorkflowId: workflowId,
      scope: "umbrella",
      requiredState: "merged_to_feature_branch",
      now: "2026-05-29T10:00:00.000Z",
    });
    expect(dep.umbrella_workflow_id).toBe(workflowId);

    expect(() =>
      createTaskDependency(h.db, {
        dependentTaskId,
        dependencyTaskId: outsideTaskId,
        dependencySource: "linear",
        dependencyExternalRef: "BRIX-1700",
        dependencyRepoId: repoId,
        umbrellaWorkflowId: workflowId,
        scope: "umbrella",
        requiredState: "merged_to_feature_branch",
        now: "2026-05-29T10:00:01.000Z",
      }),
    ).toThrow("umbrella dependency blocker task is not linked");
    expect(() =>
      createTaskDependency(h.db, {
        dependentTaskId,
        dependencySource: "linear",
        dependencyExternalRef: "BRIX-1702",
        dependencyRepoId: repoId,
        umbrellaWorkflowId: workflowId,
        scope: "umbrella",
        requiredState: "merged_to_feature_branch",
        now: "2026-05-29T10:00:02.000Z",
      }),
    ).toThrow("umbrella dependency blocker task is not linked");
  } finally {
    h.cleanup();
  }
});

test("dependency cycles are rejected before insertion", () => {
  const h = createHarness();
  try {
    const repoId = insertRepo(h.db, "repo-deps-cycle");
    const taskA = insertTask(h.db, {
      taskId: "task-cycle-a",
      repoId,
      state: "waiting_dependencies",
    });
    const taskB = insertTask(h.db, {
      taskId: "task-cycle-b",
      repoId,
      state: "waiting_dependencies",
    });

    createTaskDependency(h.db, {
      dependentTaskId: taskA,
      dependencyTaskId: taskB,
      dependencySource: "manual",
      dependencyExternalRef: "BRIX-1801",
      dependencyRepoId: repoId,
      now: "2026-05-29T10:00:00.000Z",
    });

    expect(() =>
      createTaskDependency(h.db, {
        dependentTaskId: taskB,
        dependencyTaskId: taskA,
        dependencySource: "manual",
        dependencyExternalRef: "BRIX-1800",
        dependencyRepoId: repoId,
        now: "2026-05-29T10:00:01.000Z",
      }),
    ).toThrow("task dependency would create a cycle");
  } finally {
    h.cleanup();
  }
});
