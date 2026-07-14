import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import {
  insertRepo,
  insertRunningTask,
  writeBlockerFile,
} from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_spawn_window_null_session_uses_same_classifier", async () => {
  h = createHarness();
  h.clock.set("2026-04-26T20:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-spawn-window");
  const worktreesRoot = join(h.dataDir, "worktrees");
  // Spawn-window crash: tmux_session is NULL but spawned_at is set. The
  // worker still managed to start and write a blocker before exiting.
  const t = insertRunningTask(h.db, {
    taskId: "task-spawn-window",
    repoId,
    worktreesRoot,
    tmuxSession: null,
  });
  const canonicalSession = `quay-task-${t.tmuxId}-${t.attemptNumber}`;

  const blockerBody = "Cannot proceed: missing config.\n";
  const blockerPath = writeBlockerFile(t.worktreePath, blockerBody);

  const built = buildTickDeps(h);
  // Simulate an orphan canonical-name session that survived the spawn crash.
  built.tmux.liveSessions.add(canonicalSession);

  const results = await tick_once(built.deps);
  expect(results).toEqual([
    { task_id: t.taskId, action: "spawn_window_recovered" },
  ]);

  // Recovery killed the canonical orphan session before classifying.
  expect(built.tmux.killCalls).toContain(canonicalSession);

  // Same evidence classifier ran: blocker ingested, task to awaiting-next-brief.
  const task = h.db
    .query<{ state: string }, [string]>(
      `SELECT state FROM tasks WHERE task_id = ?`,
    )
    .get(t.taskId);
  expect(task!.state).toBe("awaiting-next-brief");

  const arts = h.db
    .query<{ artifact_id: number }, [string, number]>(
      `SELECT artifact_id FROM artifacts
         WHERE task_id = ? AND attempt_id = ? AND kind = 'blocker'`,
    )
    .all(t.taskId, t.attemptId);
  expect(arts).toHaveLength(1);

  const att = h.db
    .query<{ exit_kind: string | null }, [number]>(
      `SELECT exit_kind FROM attempts WHERE attempt_id = ?`,
    )
    .get(t.attemptId);
  expect(att!.exit_kind).toBe("blocker_written");

  // Worktree file removed.
  expect(existsSync(blockerPath)).toBe(false);

  // No spawn_failed write — the unconditional rollback path was avoided.
  const evTypes = h.db
    .query<{ event_type: string }, [string]>(
      `SELECT event_type FROM events WHERE task_id = ?`,
    )
    .all(t.taskId)
    .map((r) => r.event_type);
  expect(evTypes).toContain("blocker_ingested");
  expect(evTypes).not.toContain("spawn_failed");
});

test("spawn-window stale pre-existing PR without current evidence is spawn_failed", async () => {
  h = createHarness();
  h.clock.set("2026-07-14T10:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-spawn-window-stale-pr");
  const worktreesRoot = join(h.dataDir, "worktrees");
  const t = insertRunningTask(h.db, {
    taskId: "task-spawn-window-stale-pr",
    repoId,
    worktreesRoot,
    tmuxSession: null,
    remoteShaAtSpawn: "same-remote-head",
    prExistedAtSpawn: 1,
    attemptsConsumed: 1,
  });

  const built = buildTickDeps(h);
  built.git.setRemoteHeadSha(repoId, t.branchName, "same-remote-head");
  built.github.setPrExists(repoId, t.branchName, true);

  const results = await tick_once(built.deps);

  expect(results).toEqual([{ task_id: t.taskId, action: "spawn_failed" }]);

  const task = h.db
    .query<
      {
        state: string;
        attempts_consumed: number;
        spawn_failures_consecutive: number;
      },
      [string]
    >(
      `SELECT state, attempts_consumed, spawn_failures_consecutive
         FROM tasks WHERE task_id = ?`,
    )
    .get(t.taskId);
  expect(task).toEqual({
    state: "queued",
    attempts_consumed: 0,
    spawn_failures_consecutive: 1,
  });

  const attempts = h.db
    .query<{ attempt_number: number; spawned_at: string | null; exit_kind: string | null }, [string]>(
      `SELECT attempt_number, spawned_at, exit_kind
         FROM attempts
        WHERE task_id = ?
        ORDER BY attempt_number`,
    )
    .all(t.taskId);
  expect(attempts).toEqual([
    {
      attempt_number: 1,
      spawned_at: "2026-01-01T00:00:00.000Z",
      exit_kind: "spawn_failed",
    },
    { attempt_number: 2, spawned_at: null, exit_kind: null },
  ]);

  const evTypes = h.db
    .query<{ event_type: string }, [string]>(
      `SELECT event_type FROM events WHERE task_id = ? ORDER BY event_id`,
    )
    .all(t.taskId)
    .map((r) => r.event_type);
  expect(evTypes).toContain("spawn_failed");
  expect(evTypes).not.toContain("no_progress");
  expect(evTypes).not.toContain("existing_pr_attached");
});
