import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertRepo, insertRunningTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

// The dead-worker path captures the OS-level exit observation once via
// `tmux.getExitInfo` and threads it through whichever terminal write
// runs (crashed/no_progress/pr_opened/blocker_written/killed_*). These
// tests pin the wiring at the highest leverage points: a clean exit, a
// signal-terminated exit, and the absence-of-info case.

test("crashed path stamps exit_code from a clean tmux exit observation", async () => {
  h = createHarness();
  h.clock.set("2026-05-10T12:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-exit-clean");
  const worktreesRoot = join(h.dataDir, "worktrees");
  const t = insertRunningTask(h.db, {
    taskId: "task-exit-clean",
    repoId,
    worktreesRoot,
    remoteShaAtSpawn: null,
    prExistedAtSpawn: 0,
  });

  const built = buildTickDeps(h);
  built.tmux.markDead(t.sessionName!);
  built.tmux.setExitInfo(t.sessionName!, { exitCode: 0, exitSignal: null });
  built.git.setRemoteHeadSha(repoId, t.branchName, null);
  built.github.setPrExists(repoId, t.branchName, false);

  const results = await tick_once(built.deps);
  expect(results).toEqual([{ task_id: t.taskId, action: "crashed" }]);

  const dead = h.db
    .query<
      {
        exit_kind: string | null;
        exit_code: number | null;
        exit_signal: string | null;
      },
      [number]
    >(
      `SELECT exit_kind, exit_code, exit_signal
         FROM attempts WHERE attempt_id = ?`,
    )
    .get(t.attemptId);
  expect(dead!.exit_kind).toBe("crashed");
  expect(dead!.exit_code).toBe(0);
  expect(dead!.exit_signal).toBeNull();
});

test("crashed path stamps exit_signal when tmux reports a signaled exit", async () => {
  h = createHarness();
  h.clock.set("2026-05-10T12:01:00.000Z");

  const repoId = insertRepo(h.db, "repo-exit-signal");
  const worktreesRoot = join(h.dataDir, "worktrees");
  const t = insertRunningTask(h.db, {
    taskId: "task-exit-signal",
    repoId,
    worktreesRoot,
    remoteShaAtSpawn: null,
    prExistedAtSpawn: 0,
  });

  const built = buildTickDeps(h);
  built.tmux.markDead(t.sessionName!);
  // Worker SIGKILLed by the OOM killer.
  built.tmux.setExitInfo(t.sessionName!, {
    exitCode: null,
    exitSignal: "SIGKILL",
  });
  built.git.setRemoteHeadSha(repoId, t.branchName, null);
  built.github.setPrExists(repoId, t.branchName, false);

  await tick_once(built.deps);

  const dead = h.db
    .query<
      {
        exit_kind: string | null;
        exit_code: number | null;
        exit_signal: string | null;
      },
      [number]
    >(
      `SELECT exit_kind, exit_code, exit_signal
         FROM attempts WHERE attempt_id = ?`,
    )
    .get(t.attemptId);
  expect(dead!.exit_kind).toBe("crashed");
  expect(dead!.exit_code).toBeNull();
  expect(dead!.exit_signal).toBe("SIGKILL");
});

test("dead-worker path leaves exit_code and exit_signal NULL when tmux reports nothing", async () => {
  h = createHarness();
  h.clock.set("2026-05-10T12:02:00.000Z");

  const repoId = insertRepo(h.db, "repo-exit-none");
  const worktreesRoot = join(h.dataDir, "worktrees");
  const t = insertRunningTask(h.db, {
    taskId: "task-exit-none",
    repoId,
    worktreesRoot,
    remoteShaAtSpawn: null,
    prExistedAtSpawn: 0,
  });

  const built = buildTickDeps(h);
  built.tmux.markDead(t.sessionName!);
  // No setExitInfo() — fake returns EXIT_INFO_NONE, which is what the
  // real adapter does on older tmux that doesn't surface the format
  // strings or when the session disappeared before we could read them.
  built.git.setRemoteHeadSha(repoId, t.branchName, null);
  built.github.setPrExists(repoId, t.branchName, false);

  await tick_once(built.deps);

  const dead = h.db
    .query<
      { exit_code: number | null; exit_signal: string | null },
      [number]
    >(
      `SELECT exit_code, exit_signal
         FROM attempts WHERE attempt_id = ?`,
    )
    .get(t.attemptId);
  expect(dead!.exit_code).toBeNull();
  expect(dead!.exit_signal).toBeNull();
});

test("spawn_substrate_failed leaves exit_code and exit_signal NULL", async () => {
  // No real process ever ran; tmux's status is meaningless here. The
  // spawn-window classifier writes spawn_failed without touching the
  // exit pair, leaving both NULL — distinguishable from a real death.
  h = createHarness();
  h.clock.set("2026-05-10T12:03:00.000Z");

  const repoId = insertRepo(h.db, "repo-spawn-fail-exit");
  const worktreesRoot = join(h.dataDir, "worktrees");
  const t = insertRunningTask(h.db, {
    taskId: "task-spawn-fail-exit",
    repoId,
    worktreesRoot,
    remoteShaAtSpawn: null,
    prExistedAtSpawn: 0,
    tmuxSession: null,
  });

  const built = buildTickDeps(h);
  built.git.setRemoteHeadSha(repoId, t.branchName, null);
  built.github.setPrExists(repoId, t.branchName, false);

  await tick_once(built.deps);

  const dead = h.db
    .query<
      {
        exit_kind: string | null;
        exit_code: number | null;
        exit_signal: string | null;
      },
      [number]
    >(
      `SELECT exit_kind, exit_code, exit_signal
         FROM attempts WHERE attempt_id = ?`,
    )
    .get(t.attemptId);
  expect(dead!.exit_kind).toBe("spawn_failed");
  expect(dead!.exit_code).toBeNull();
  expect(dead!.exit_signal).toBeNull();
});
