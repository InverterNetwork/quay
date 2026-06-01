import { afterEach, expect, test } from "bun:test";
import { QuayError } from "../../src/core/errors.ts";
import {
  listUmbrellaExpectedTasks,
  markUmbrellaExpectedTaskCompleteWithoutQuay,
  markUmbrellaExpectedTaskLinked,
  requireUmbrellaExpectedTask,
  upsertUmbrellaExpectedTask,
} from "../../src/core/umbrella_workflows.ts";
import { insertRepo } from "../support/fixtures.ts";
import { createHarness, type Harness } from "../support/harness.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

function insertWorkflow(): number {
  if (h === null) throw new Error("harness not initialized");
  const repoId = insertRepo(h.db, "repo-umbrella-membership");
  const row = h.db
    .query<
      { umbrella_workflow_id: number },
      [string, string, string, string, string, string]
    >(
      `INSERT INTO umbrella_workflows (
         external_ref, repo_id, base_branch, feature_branch, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       RETURNING umbrella_workflow_id`,
    )
    .get(
      "BRIX-2000",
      repoId,
      "main",
      "quay/umbrella-BRIX-2000",
      "2026-05-30T00:00:00.000Z",
      "2026-05-30T00:00:00.000Z",
    );
  if (!row) throw new Error("workflow insert returned no row");
  return row.umbrella_workflow_id;
}

test("umbrella expected task upsert is idempotent and listable", () => {
  h = createHarness();
  const workflowId = insertWorkflow();

  const inserted = upsertUmbrellaExpectedTask(h.db, {
    umbrellaWorkflowId: workflowId,
    externalRef: "BRIX-2001",
    title: "First child",
    linearIssueUrl: "https://linear.app/inverter/issue/BRIX-2001",
    now: "2026-05-30T01:00:00.000Z",
  });
  expect(inserted).toMatchObject({
    umbrella_workflow_id: workflowId,
    external_ref: "BRIX-2001",
    title: "First child",
    linear_issue_url: "https://linear.app/inverter/issue/BRIX-2001",
    state: "expected",
    completion_source: null,
    completion_reason: null,
    completed_at: null,
  });

  const updated = upsertUmbrellaExpectedTask(h.db, {
    umbrellaWorkflowId: workflowId,
    externalRef: "BRIX-2001",
    title: null,
    linearIssueId: "linear-uuid-1",
    now: "2026-05-30T02:00:00.000Z",
  });
  expect(updated.umbrella_expected_task_id).toBe(
    inserted.umbrella_expected_task_id,
  );
  expect(updated.title).toBe("First child");
  expect(updated.linear_issue_id).toBe("linear-uuid-1");
  expect(updated.linear_issue_url).toBe(
    "https://linear.app/inverter/issue/BRIX-2001",
  );
  expect(updated.updated_at).toBe("2026-05-30T02:00:00.000Z");

  expect(listUmbrellaExpectedTasks(h.db, workflowId)).toEqual([updated]);
});

test("umbrella expected task can be marked linked", () => {
  h = createHarness();
  const workflowId = insertWorkflow();
  upsertUmbrellaExpectedTask(h.db, {
    umbrellaWorkflowId: workflowId,
    externalRef: "BRIX-2002",
    title: "Second child",
    now: "2026-05-30T01:00:00.000Z",
  });

  const linked = markUmbrellaExpectedTaskLinked(h.db, {
    umbrellaWorkflowId: workflowId,
    externalRef: "BRIX-2002",
    now: "2026-05-30T03:00:00.000Z",
  });

  expect(linked.state).toBe("linked");
  expect(linked.completion_source).toBeNull();
  expect(linked.completed_at).toBeNull();
  expect(requireUmbrellaExpectedTask(h.db, {
    umbrellaWorkflowId: workflowId,
    externalRef: "BRIX-2002",
  }).state).toBe("linked");
});

test("umbrella expected task can be marked complete without quay", () => {
  h = createHarness();
  const workflowId = insertWorkflow();
  upsertUmbrellaExpectedTask(h.db, {
    umbrellaWorkflowId: workflowId,
    externalRef: "BRIX-2003",
    title: "Already complete child",
    now: "2026-05-30T01:00:00.000Z",
  });

  const completed = markUmbrellaExpectedTaskCompleteWithoutQuay(h.db, {
    umbrellaWorkflowId: workflowId,
    externalRef: "BRIX-2003",
    completionSource: "linear",
    completionReason: "Linear state type completed at umbrella enqueue",
    completedAt: "2026-05-29T23:00:00.000Z",
    now: "2026-05-30T04:00:00.000Z",
  });

  expect(completed).toMatchObject({
    state: "complete_without_quay",
    completion_source: "linear",
    completion_reason: "Linear state type completed at umbrella enqueue",
    completed_at: "2026-05-29T23:00:00.000Z",
    updated_at: "2026-05-30T04:00:00.000Z",
  });
});

test("umbrella expected task terminal helper states are not overwritten", () => {
  h = createHarness();
  const workflowId = insertWorkflow();
  upsertUmbrellaExpectedTask(h.db, {
    umbrellaWorkflowId: workflowId,
    externalRef: "BRIX-2004",
    now: "2026-05-30T01:00:00.000Z",
  });
  markUmbrellaExpectedTaskCompleteWithoutQuay(h.db, {
    umbrellaWorkflowId: workflowId,
    externalRef: "BRIX-2004",
    completionSource: "linear",
    completedAt: "2026-05-29T23:00:00.000Z",
    now: "2026-05-30T04:00:00.000Z",
  });

  expect(() =>
    markUmbrellaExpectedTaskLinked(h!.db, {
      umbrellaWorkflowId: workflowId,
      externalRef: "BRIX-2004",
      now: "2026-05-30T05:00:00.000Z",
    }),
  ).toThrow(QuayError);

  upsertUmbrellaExpectedTask(h.db, {
    umbrellaWorkflowId: workflowId,
    externalRef: "BRIX-2005",
    now: "2026-05-30T01:00:00.000Z",
  });
  markUmbrellaExpectedTaskLinked(h.db, {
    umbrellaWorkflowId: workflowId,
    externalRef: "BRIX-2005",
    now: "2026-05-30T05:00:00.000Z",
  });

  expect(() =>
    markUmbrellaExpectedTaskCompleteWithoutQuay(h!.db, {
      umbrellaWorkflowId: workflowId,
      externalRef: "BRIX-2005",
      completionSource: "linear",
      completedAt: "2026-05-29T23:00:00.000Z",
      now: "2026-05-30T06:00:00.000Z",
    }),
  ).toThrow(QuayError);
});

test("umbrella expected task validation rejects unexpected subtasks", () => {
  h = createHarness();
  const workflowId = insertWorkflow();

  expect(() =>
    requireUmbrellaExpectedTask(h!.db, {
      umbrellaWorkflowId: workflowId,
      externalRef: "BRIX-4040",
    }),
  ).toThrow(QuayError);

  try {
    markUmbrellaExpectedTaskLinked(h.db, {
      umbrellaWorkflowId: workflowId,
      externalRef: "BRIX-4040",
      now: "2026-05-30T05:00:00.000Z",
    });
  } catch (err) {
    expect(err).toBeInstanceOf(QuayError);
    expect((err as QuayError).code).toBe("umbrella_subtask_not_expected");
    return;
  }
  throw new Error("expected mark linked to reject unexpected subtask");
});
