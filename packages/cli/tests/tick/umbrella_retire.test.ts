import { afterEach, expect, test } from "bun:test";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertRepo, insertTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

// BRIX-1924: tick retires an umbrella workflow whose children can no longer
// complete — all linked child tasks cancelled and nothing left that could ever
// reach `merged_to_feature_branch` / `complete_without_quay` (observed on the
// orphaned-active BRIX-1902 umbrella).

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

function insertUmbrella(
  repoId: string,
  opts: { externalRef?: string; state?: "active" | "completed" | "cancelled" } = {},
): number {
  if (h === null) throw new Error("harness not initialized");
  const externalRef = opts.externalRef ?? "BRIX-1902";
  const now = h.clock.nowISO();
  const row = h.db
    .query<{ umbrella_workflow_id: number }, [string, string, string, string, string, string]>(
      `INSERT INTO umbrella_workflows (
         external_ref, repo_id, base_branch, feature_branch, state,
         created_at, updated_at
       ) VALUES (?, ?, 'dev', ?, ?, ?, ?)
       RETURNING umbrella_workflow_id`,
    )
    .get(
      externalRef,
      repoId,
      `quay/umbrella/${externalRef}`,
      opts.state ?? "active",
      now,
      now,
    );
  if (!row) throw new Error("umbrella insert failed");
  return row.umbrella_workflow_id;
}

// Adds an expected subtask that has been linked to a Quay child task in the
// given state (the umbrella_expected_tasks row stays `linked`, mirroring the
// BRIX-1902 shape where operators cancelled the children by hand).
function insertLinkedChild(
  workflowId: number,
  repoId: string,
  opts: { externalRef: string; taskId: string; taskState: string },
): void {
  if (h === null) throw new Error("harness not initialized");
  const now = h.clock.nowISO();
  insertTask(h.db, { taskId: opts.taskId, repoId, state: opts.taskState });
  h.db
    .query(`UPDATE tasks SET external_ref = ? WHERE task_id = ?`)
    .run(opts.externalRef, opts.taskId);
  h.db
    .query(
      `INSERT INTO umbrella_expected_tasks (
         umbrella_workflow_id, external_ref, state, created_at, updated_at
       ) VALUES (?, ?, 'linked', ?, ?)`,
    )
    .run(workflowId, opts.externalRef, now, now);
  h.db
    .query(
      `INSERT INTO umbrella_tasks (
         umbrella_workflow_id, task_id, external_ref, created_at
       ) VALUES (?, ?, ?, ?)`,
    )
    .run(workflowId, opts.taskId, opts.externalRef, now);
}

// Adds an expected subtask with no linked Quay task (still `expected`, or a
// `complete_without_quay` success recorded outside Quay).
function insertUnlinkedExpected(
  workflowId: number,
  opts: {
    externalRef: string;
    state: "expected" | "complete_without_quay";
    completionSource?: "linear" | "manual";
  },
): void {
  if (h === null) throw new Error("harness not initialized");
  const now = h.clock.nowISO();
  h.db
    .query(
      `INSERT INTO umbrella_expected_tasks (
         umbrella_workflow_id, external_ref, state, completion_source,
         completed_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      workflowId,
      opts.externalRef,
      opts.state,
      opts.state === "complete_without_quay" ? opts.completionSource ?? "manual" : null,
      opts.state === "complete_without_quay" ? now : null,
      now,
      now,
    );
}

function umbrellaState(workflowId: number): string {
  if (h === null) throw new Error("harness not initialized");
  const row = h.db
    .query<{ state: string }, [number]>(
      `SELECT state FROM umbrella_workflows WHERE umbrella_workflow_id = ?`,
    )
    .get(workflowId);
  if (!row) throw new Error("umbrella not found");
  return row.state;
}

test("tick retires an umbrella whose linked children are all cancelled", async () => {
  h = createHarness();
  h.clock.set("2026-06-01T12:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-umbrella-retire");
  const workflowId = insertUmbrella(repoId, { externalRef: "BRIX-1902" });
  insertLinkedChild(workflowId, repoId, {
    externalRef: "BRIX-1903",
    taskId: "child-1903",
    taskState: "cancelled",
  });
  insertLinkedChild(workflowId, repoId, {
    externalRef: "BRIX-1904",
    taskId: "child-1904",
    taskState: "cancelled",
  });
  const built = buildTickDeps(h);

  const results = await tick_once(built.deps);

  expect(results).toEqual([
    { task_id: `umbrella-${workflowId}`, action: "umbrella_retired" },
  ]);
  expect(umbrellaState(workflowId)).toBe("cancelled");
  // Retirement must never touch a final PR.
  expect(built.github.createPullRequestCalls).toEqual([]);
  const workflow = h.db
    .query<{ final_pr_task_id: string | null; final_pr_number: number | null }, [number]>(
      `SELECT final_pr_task_id, final_pr_number FROM umbrella_workflows WHERE umbrella_workflow_id = ?`,
    )
    .get(workflowId);
  expect(workflow).toEqual({ final_pr_task_id: null, final_pr_number: null });
});

test("tick leaves an umbrella active while a child is still in progress", async () => {
  h = createHarness();
  h.clock.set("2026-06-01T12:05:00.000Z");
  const repoId = insertRepo(h.db, "repo-umbrella-inprogress");
  const workflowId = insertUmbrella(repoId, { externalRef: "BRIX-2000" });
  insertLinkedChild(workflowId, repoId, {
    externalRef: "BRIX-2001",
    taskId: "child-2001",
    taskState: "cancelled",
  });
  insertLinkedChild(workflowId, repoId, {
    externalRef: "BRIX-2002",
    taskId: "child-2002",
    taskState: "running",
  });
  const built = buildTickDeps(h);

  const results = await tick_once(built.deps);

  expect(results).toEqual([]);
  expect(umbrellaState(workflowId)).toBe("active");
});

test("tick does not retire an umbrella with an unlinked expected child", async () => {
  h = createHarness();
  h.clock.set("2026-06-01T12:07:00.000Z");
  const repoId = insertRepo(h.db, "repo-umbrella-expected");
  const workflowId = insertUmbrella(repoId, { externalRef: "BRIX-2100" });
  insertLinkedChild(workflowId, repoId, {
    externalRef: "BRIX-2101",
    taskId: "child-2101",
    taskState: "cancelled",
  });
  // Still enqueueable — it could yet become a real child.
  insertUnlinkedExpected(workflowId, {
    externalRef: "BRIX-2102",
    state: "expected",
  });
  const built = buildTickDeps(h);

  const results = await tick_once(built.deps);

  expect(results).toEqual([]);
  expect(umbrellaState(workflowId)).toBe("active");
});

test("tick does not retire an umbrella that has a success among cancelled children", async () => {
  h = createHarness();
  h.clock.set("2026-06-01T12:09:00.000Z");
  const repoId = insertRepo(h.db, "repo-umbrella-mixed");
  const workflowId = insertUmbrella(repoId, { externalRef: "BRIX-2200" });
  insertLinkedChild(workflowId, repoId, {
    externalRef: "BRIX-2201",
    taskId: "child-2201",
    taskState: "cancelled",
  });
  // A child already merged to the feature branch is real, kept work.
  insertLinkedChild(workflowId, repoId, {
    externalRef: "BRIX-2202",
    taskId: "child-2202",
    taskState: "merged_to_feature_branch",
  });
  // And an out-of-Quay completion is also a success.
  insertUnlinkedExpected(workflowId, {
    externalRef: "BRIX-2203",
    state: "complete_without_quay",
    completionSource: "manual",
  });
  const built = buildTickDeps(h);

  const results = await tick_once(built.deps);

  expect(results).toEqual([]);
  expect(umbrellaState(workflowId)).toBe("active");
});

test("tick does not touch an already-completed umbrella", async () => {
  h = createHarness();
  h.clock.set("2026-06-01T12:11:00.000Z");
  const repoId = insertRepo(h.db, "repo-umbrella-completed");
  const workflowId = insertUmbrella(repoId, {
    externalRef: "BRIX-2300",
    state: "completed",
  });
  // Even if its recorded children happen to be cancelled, a completed umbrella
  // is terminal and must be left alone.
  insertLinkedChild(workflowId, repoId, {
    externalRef: "BRIX-2301",
    taskId: "child-2301",
    taskState: "cancelled",
  });
  const built = buildTickDeps(h);

  const results = await tick_once(built.deps);

  expect(results).toEqual([]);
  expect(umbrellaState(workflowId)).toBe("completed");
});

test("umbrella retirement is idempotent across ticks", async () => {
  h = createHarness();
  h.clock.set("2026-06-01T12:13:00.000Z");
  const repoId = insertRepo(h.db, "repo-umbrella-idempotent");
  const workflowId = insertUmbrella(repoId, { externalRef: "BRIX-2400" });
  insertLinkedChild(workflowId, repoId, {
    externalRef: "BRIX-2401",
    taskId: "child-2401",
    taskState: "cancelled",
  });
  const built = buildTickDeps(h);

  const first = await tick_once(built.deps);
  expect(first).toEqual([
    { task_id: `umbrella-${workflowId}`, action: "umbrella_retired" },
  ]);
  expect(umbrellaState(workflowId)).toBe("cancelled");

  const second = await tick_once(built.deps);
  expect(second).toEqual([]);
  expect(umbrellaState(workflowId)).toBe("cancelled");
});

test("tick does not retire a childless umbrella (no expected tasks)", async () => {
  h = createHarness();
  h.clock.set("2026-06-01T12:15:00.000Z");
  const repoId = insertRepo(h.db, "repo-umbrella-childless");
  // Guards the load-bearing `EXISTS (>=1 expected task)` check: an umbrella
  // with zero expected rows must never be retired (the NOT EXISTS clause is
  // vacuously true for it).
  const workflowId = insertUmbrella(repoId, { externalRef: "BRIX-2500" });
  const built = buildTickDeps(h);

  const results = await tick_once(built.deps);

  expect(results).toEqual([]);
  expect(umbrellaState(workflowId)).toBe("active");
});

test("tick retires an umbrella whose linked children are all closed_unmerged", async () => {
  h = createHarness();
  h.clock.set("2026-06-01T12:17:00.000Z");
  const repoId = insertRepo(h.db, "repo-umbrella-closed");
  const workflowId = insertUmbrella(repoId, { externalRef: "BRIX-2600" });
  insertLinkedChild(workflowId, repoId, {
    externalRef: "BRIX-2601",
    taskId: "child-2601",
    taskState: "closed_unmerged",
  });
  insertLinkedChild(workflowId, repoId, {
    externalRef: "BRIX-2602",
    taskId: "child-2602",
    taskState: "closed_unmerged",
  });
  const built = buildTickDeps(h);

  const results = await tick_once(built.deps);

  expect(results).toEqual([
    { task_id: `umbrella-${workflowId}`, action: "umbrella_retired" },
  ]);
  expect(umbrellaState(workflowId)).toBe("cancelled");
});

test("tick retires an umbrella with a cancelled + closed_unmerged child mix", async () => {
  h = createHarness();
  h.clock.set("2026-06-01T12:19:00.000Z");
  const repoId = insertRepo(h.db, "repo-umbrella-mixed-terminal");
  const workflowId = insertUmbrella(repoId, { externalRef: "BRIX-2700" });
  insertLinkedChild(workflowId, repoId, {
    externalRef: "BRIX-2701",
    taskId: "child-2701",
    taskState: "cancelled",
  });
  insertLinkedChild(workflowId, repoId, {
    externalRef: "BRIX-2702",
    taskId: "child-2702",
    taskState: "closed_unmerged",
  });
  const built = buildTickDeps(h);

  const results = await tick_once(built.deps);

  expect(results).toEqual([
    { task_id: `umbrella-${workflowId}`, action: "umbrella_retired" },
  ]);
  expect(umbrellaState(workflowId)).toBe("cancelled");
});
