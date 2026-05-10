// When the dead-worker classifier observes an exit-status capture from
// the tmux adapter, it persists it as an `exit_status` artifact. This
// is the cheap discriminator the silent-exit triage path needs:
// presence + a numeric value separates "wrapper observed the agent
// exit" from "wrapper itself was reaped" (no artifact). Both cases are
// asserted here.
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

test("dead worker with exit_code captured produces an exit_status artifact", async () => {
  h = createHarness();
  h.clock.set("2026-05-09T22:00:00.000Z");

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
  built.tmux.setExitStatus(t.sessionName!, {
    rawStatus: 0,
    exitCode: 0,
    signalName: null,
  });
  built.git.setRemoteHeadSha(repoId, t.branchName, null);
  built.github.setPrExists(repoId, t.branchName, false);

  await tick_once(built.deps);

  const row = h.db
    .query<
      { kind: string; file_path: string },
      [string, number]
    >(
      `SELECT kind, file_path FROM artifacts
        WHERE task_id = ? AND attempt_id = ? AND kind = 'exit_status'`,
    )
    .get(t.taskId, t.attemptId);
  expect(row).not.toBeNull();
  const content = readFileSync(row!.file_path, "utf8");
  expect(content).toContain("raw_status=0");
  expect(content).toContain("exit_code=0");
  expect(content).not.toContain("exit_signal=");
});

test("dead worker killed by signal records exit_signal in the artifact", async () => {
  h = createHarness();
  h.clock.set("2026-05-09T22:00:00.000Z");

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
  built.tmux.setExitStatus(t.sessionName!, {
    rawStatus: 137,
    exitCode: null,
    signalName: "SIGKILL",
  });
  built.git.setRemoteHeadSha(repoId, t.branchName, null);
  built.github.setPrExists(repoId, t.branchName, false);

  await tick_once(built.deps);

  const row = h.db
    .query<
      { kind: string; file_path: string },
      [string, number]
    >(
      `SELECT kind, file_path FROM artifacts
        WHERE task_id = ? AND attempt_id = ? AND kind = 'exit_status'`,
    )
    .get(t.taskId, t.attemptId);
  expect(row).not.toBeNull();
  const content = readFileSync(row!.file_path, "utf8");
  expect(content).toContain("raw_status=137");
  expect(content).toContain("exit_signal=SIGKILL");
  expect(content).not.toContain("exit_code=");
});

test("dead worker with no exit-status capture produces no exit_status artifact", async () => {
  // The "wrapper itself was reaped" case: no .quay-exit-code file ever
  // landed because the whole pane was killed (cgroup reap, OOM, tmux
  // kill). FakeTmux.collectExitStatus returns null when no status was
  // set; the classifier must NOT fabricate an artifact.
  h = createHarness();
  h.clock.set("2026-05-09T22:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-exit-missing");
  const worktreesRoot = join(h.dataDir, "worktrees");
  const t = insertRunningTask(h.db, {
    taskId: "task-exit-missing",
    repoId,
    worktreesRoot,
    remoteShaAtSpawn: null,
    prExistedAtSpawn: 0,
  });

  const built = buildTickDeps(h);
  built.tmux.markDead(t.sessionName!);
  // deliberately do NOT call setExitStatus — collectExitStatus returns null.
  built.git.setRemoteHeadSha(repoId, t.branchName, null);
  built.github.setPrExists(repoId, t.branchName, false);

  await tick_once(built.deps);

  const rows = h.db
    .query<
      { n: number },
      [string, number]
    >(
      `SELECT COUNT(*) AS n FROM artifacts
        WHERE task_id = ? AND attempt_id = ? AND kind = 'exit_status'`,
    )
    .get(t.taskId, t.attemptId);
  expect(rows!.n).toBe(0);
});
