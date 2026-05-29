import { expect, test } from "bun:test";
import {
  createTaskDependency,
  markTaskDependencySatisfied,
  releaseTaskIfDependenciesSatisfied,
  taskDependencyStatus,
} from "../../src/core/task_dependencies.ts";
import { transitionTaskState } from "../../src/core/task_state.ts";
import { createHarness } from "../support/harness.ts";
import { insertRepo, insertTask } from "../support/fixtures.ts";

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
        event_type: "dependency_satisfied",
        from_state: "waiting_dependencies",
        to_state: "queued",
      },
    ]);
  } finally {
    h.cleanup();
  }
});
