import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertRepo, insertRunningTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("dead-worker classifier ingests .quay-tool-trace.log on any terminal path", async () => {
  // Crashed path is the most demanding: the worker died without a
  // PR or signal. The wrapper's debug-file streamed events as the
  // worker ran, so there should still be a trace to capture even on
  // the crash path.
  h = createHarness();
  h.clock.set("2026-05-10T14:30:00.000Z");

  const repoId = insertRepo(h.db, "repo-trace-e2e");
  const worktreesRoot = join(h.dataDir, "worktrees");
  const t = insertRunningTask(h.db, {
    taskId: "task-trace-e2e",
    repoId,
    worktreesRoot,
    remoteShaAtSpawn: null,
    prExistedAtSpawn: 0,
  });

  const trace =
    "[2026-05-10T14:30:00Z] tool_dispatch_start tool=Read\n" +
    "[2026-05-10T14:30:00Z] tool_dispatch_end tool=Read outcome=ok\n" +
    "[2026-05-10T14:30:01Z] [API:request] Creating client\n";
  writeFileSync(join(t.worktreePath, ".quay-tool-trace.log"), trace);

  const built = buildTickDeps(h);
  built.tmux.markDead(t.sessionName!);
  built.git.setRemoteHeadSha(repoId, t.branchName, null);
  built.github.setPrExists(repoId, t.branchName, false);

  await tick_once(built.deps);

  const rows = h.db
    .query<{ artifact_id: number }, [string, number]>(
      `SELECT artifact_id FROM artifacts
         WHERE task_id = ? AND attempt_id = ? AND kind = 'tool_trace'`,
    )
    .all(t.taskId, t.attemptId);
  expect(rows).toHaveLength(1);
});

test("no tool_trace artifact when the worker did not write a debug file", async () => {
  h = createHarness();
  h.clock.set("2026-05-10T14:31:00.000Z");

  const repoId = insertRepo(h.db, "repo-trace-absent");
  const worktreesRoot = join(h.dataDir, "worktrees");
  const t = insertRunningTask(h.db, {
    taskId: "task-trace-absent",
    repoId,
    worktreesRoot,
    remoteShaAtSpawn: null,
    prExistedAtSpawn: 0,
  });

  const built = buildTickDeps(h);
  built.tmux.markDead(t.sessionName!);
  built.git.setRemoteHeadSha(repoId, t.branchName, null);
  built.github.setPrExists(repoId, t.branchName, false);

  await tick_once(built.deps);

  const count = h.db
    .query<{ n: number }, [string, number]>(
      `SELECT COUNT(*) AS n FROM artifacts
         WHERE task_id = ? AND attempt_id = ? AND kind = 'tool_trace'`,
    )
    .get(t.taskId, t.attemptId);
  expect(count!.n).toBe(0);
});
