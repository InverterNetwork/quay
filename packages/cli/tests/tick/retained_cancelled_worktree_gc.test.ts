import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertRepo, insertTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

function retainedCancelledTask(
  taskId: string,
  ageAnchor: string,
  opts: { state?: string; createWorktree?: boolean } = {},
): { taskId: string; repoId: string; worktreePath: string } {
  if (h === null) throw new Error("harness not initialized");
  const repoId = insertRepo(h.db, `repo-${taskId}`);
  const state = opts.state ?? "cancelled";
  insertTask(h.db, { taskId, repoId, state });
  const worktreePath = join(h.dataDir, "worktrees", taskId);
  if (opts.createWorktree !== false) {
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, "notes.txt"), "retained for inspection\n");
  }
  h.db
    .query(
      `UPDATE tasks
          SET worktree_path = ?,
              cancel_keep_worktree = 1,
              cancel_requested_at = ?,
              updated_at = ?
        WHERE task_id = ?`,
    )
    .run(worktreePath, ageAnchor, ageAnchor, taskId);
  return { taskId, repoId, worktreePath };
}

function cleanupStamp(taskId: string): string | null {
  if (h === null) throw new Error("harness not initialized");
  return h.db
    .query<{ worktree_cleaned_at: string | null }, [string]>(
      `SELECT worktree_cleaned_at FROM tasks WHERE task_id = ?`,
    )
    .get(taskId)!.worktree_cleaned_at;
}

test("retained cancelled worktree younger than 24 hours is not deleted", async () => {
  h = createHarness();
  h.clock.set("2026-05-29T12:00:00.000Z");
  const task = retainedCancelledTask("task-young-retained", "2026-05-28T12:30:00.000Z");

  const built = buildTickDeps(h);
  const results = await tick_once(built.deps);

  expect(results).toEqual([]);
  expect(existsSync(task.worktreePath)).toBe(true);
  expect(cleanupStamp(task.taskId)).toBeNull();
  expect(built.git.countCalls("worktreeRemove")).toBe(0);
});

test("retained cancelled worktree older than 24 hours is deleted and marked cleaned", async () => {
  h = createHarness();
  h.clock.set("2026-05-29T12:00:00.000Z");
  const task = retainedCancelledTask("task-old-retained", "2026-05-28T11:59:59.000Z");

  const built = buildTickDeps(h);
  const results = await tick_once(built.deps);

  expect(results).toEqual([
    { task_id: task.taskId, action: "retained_worktree_cleaned" },
  ]);
  expect(existsSync(task.worktreePath)).toBe(false);
  expect(cleanupStamp(task.taskId)).toBe("2026-05-29T12:00:00.000Z");
});

test("missing retained cancelled worktree older than 24 hours is marked cleaned", async () => {
  h = createHarness();
  h.clock.set("2026-05-29T12:00:00.000Z");
  const task = retainedCancelledTask("task-missing-retained", "2026-05-27T12:00:00.000Z", {
    createWorktree: false,
  });

  const built = buildTickDeps(h);
  const results = await tick_once(built.deps);

  expect(results).toEqual([
    { task_id: task.taskId, action: "retained_worktree_cleaned" },
  ]);
  expect(existsSync(task.worktreePath)).toBe(false);
  expect(cleanupStamp(task.taskId)).toBe("2026-05-29T12:00:00.000Z");
  expect(built.git.countCalls("worktreeRemove")).toBe(0);
});

test("non-cancelled retained worktree rows are never deleted by retained GC", async () => {
  h = createHarness();
  h.clock.set("2026-05-29T12:00:00.000Z");
  const states = [
    "running",
    "queued",
    "pr-open",
    "pr-review",
    "waiting_human",
    "awaiting-next-brief",
    "done",
  ];
  const tasks = states.map((state) =>
    retainedCancelledTask(`task-${state.replace(/[^a-z]/g, "-")}`, "2026-05-27T12:00:00.000Z", {
      state,
    }),
  );

  const built = buildTickDeps(h);
  await tick_once(built.deps, { maxConcurrent: 0, reviewerEnabled: false });

  for (const task of tasks) {
    expect(existsSync(task.worktreePath)).toBe(true);
    expect(cleanupStamp(task.taskId)).toBeNull();
  }
});

test("tick continues if one retained worktree cleanup attempt fails", async () => {
  h = createHarness();
  h.clock.set("2026-05-29T12:00:00.000Z");
  const failed = retainedCancelledTask("task-retained-fails", "2026-05-27T12:00:00.000Z");
  const cleaned = retainedCancelledTask("task-retained-succeeds", "2026-05-27T12:01:00.000Z");

  const built = buildTickDeps(h);
  built.git.fail.worktreeRemove = (path) => path === failed.worktreePath;
  const results = await tick_once(built.deps);

  expect(results).toEqual([
    {
      task_id: failed.taskId,
      action: "tick_error",
      error: `fake: worktreeRemove failed for ${failed.worktreePath}`,
    },
    { task_id: cleaned.taskId, action: "retained_worktree_cleaned" },
  ]);
  expect(existsSync(failed.worktreePath)).toBe(true);
  expect(cleanupStamp(failed.taskId)).toBeNull();
  expect(existsSync(cleaned.worktreePath)).toBe(false);
  expect(cleanupStamp(cleaned.taskId)).toBe("2026-05-29T12:00:00.000Z");
});
