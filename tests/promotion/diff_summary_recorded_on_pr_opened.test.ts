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

interface AttemptRow {
  exit_kind: string | null;
  diff_summary: string | null;
}

function readAttempt(attemptId: number): AttemptRow {
  return h!.db
    .query<AttemptRow, [number]>(
      `SELECT exit_kind, diff_summary FROM attempts WHERE attempt_id = ?`,
    )
    .get(attemptId)!;
}

test("pr_opened populates diff_summary JSON when both spawn/exit SHAs are present", async () => {
  h = createHarness();
  h.clock.set("2026-05-10T16:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-diff-success");
  const worktreesRoot = join(h.dataDir, "worktrees");

  const t = insertRunningTask(h.db, {
    taskId: "task-diff-success",
    repoId,
    worktreesRoot,
    remoteShaAtSpawn: "base-sha-aaa",
    prExistedAtSpawn: 0,
  });

  const built = buildTickDeps(h);
  built.tmux.markDead(t.sessionName!);
  built.git.setRemoteHeadSha(repoId, t.branchName, "head-sha-bbb");
  built.github.setPrExists(repoId, t.branchName, true);
  built.git.setDiffSummary(repoId, "base-sha-aaa", "head-sha-bbb", {
    files_changed: 2,
    insertions: 10,
    deletions: 3,
    files: [
      { path: "src/foo.ts", status: "M", ins: 7, del: 3 },
      { path: "src/bar.ts", status: "A", ins: 3, del: 0 },
    ],
  });

  await tick_once(built.deps);

  const row = readAttempt(t.attemptId);
  expect(row.exit_kind).toBe("pr_opened");
  expect(row.diff_summary).not.toBeNull();
  const summary = JSON.parse(row.diff_summary!);
  expect(summary.files_changed).toBe(2);
  expect(summary.insertions).toBe(10);
  expect(summary.deletions).toBe(3);
  expect(summary.files).toHaveLength(2);
  expect(summary.files[0]).toEqual({
    path: "src/foo.ts",
    status: "M",
    ins: 7,
    del: 3,
  });
});

test("pr_opened with unchanged remote SHA leaves diff_summary NULL", async () => {
  h = createHarness();
  h.clock.set("2026-05-10T16:01:00.000Z");

  const repoId = insertRepo(h.db, "repo-diff-unchanged");
  const worktreesRoot = join(h.dataDir, "worktrees");

  // 074c case: prior attempt pushed; this attempt only opens the PR.
  // remote SHA didn't change during *this* attempt → no diff to capture.
  const t = insertRunningTask(h.db, {
    taskId: "task-diff-unchanged",
    repoId,
    worktreesRoot,
    attemptNumber: 2,
    reason: "crash",
    consumedBudget: 1,
    remoteShaAtSpawn: "same-sha",
    prExistedAtSpawn: 0,
    attemptsConsumed: 2,
  });

  const built = buildTickDeps(h);
  built.tmux.markDead(t.sessionName!);
  built.git.setRemoteHeadSha(repoId, t.branchName, "same-sha");
  built.github.setPrExists(repoId, t.branchName, true);

  await tick_once(built.deps);

  const row = readAttempt(t.attemptId);
  expect(row.exit_kind).toBe("pr_opened");
  expect(row.diff_summary).toBeNull();

  // No spurious git.diffSummary call when there's nothing to diff.
  expect(built.git.countCalls("diffSummary")).toBe(0);
});

test("pr_opened with spawn SHA NULL (first push) leaves diff_summary NULL", async () => {
  h = createHarness();
  h.clock.set("2026-05-10T16:02:00.000Z");

  const repoId = insertRepo(h.db, "repo-diff-firstpush");
  const worktreesRoot = join(h.dataDir, "worktrees");

  const t = insertRunningTask(h.db, {
    taskId: "task-diff-firstpush",
    repoId,
    worktreesRoot,
    remoteShaAtSpawn: null, // branch didn't exist remotely yet
    prExistedAtSpawn: 0,
  });

  const built = buildTickDeps(h);
  built.tmux.markDead(t.sessionName!);
  built.git.setRemoteHeadSha(repoId, t.branchName, "first-push-sha");
  built.github.setPrExists(repoId, t.branchName, true);

  await tick_once(built.deps);

  const row = readAttempt(t.attemptId);
  expect(row.exit_kind).toBe("pr_opened");
  // No base SHA → can't compute a diff range. Stays NULL by design;
  // first-push diff is reconstructable from `<empty-tree>..head` if
  // anyone ever wants it.
  expect(row.diff_summary).toBeNull();
});

test("git failure leaves diff_summary NULL and emits a tick_error event", async () => {
  h = createHarness();
  h.clock.set("2026-05-10T16:03:00.000Z");

  const repoId = insertRepo(h.db, "repo-diff-fail");
  const worktreesRoot = join(h.dataDir, "worktrees");

  const t = insertRunningTask(h.db, {
    taskId: "task-diff-fail",
    repoId,
    worktreesRoot,
    remoteShaAtSpawn: "base-sha-x",
    prExistedAtSpawn: 0,
  });

  const built = buildTickDeps(h);
  built.tmux.markDead(t.sessionName!);
  built.git.setRemoteHeadSha(repoId, t.branchName, "head-sha-y");
  built.github.setPrExists(repoId, t.branchName, true);
  // Don't seed a diff summary → FakeGit.diffSummary returns null,
  // mimicking the "SHA missing locally" / git error case.

  await tick_once(built.deps);

  const row = readAttempt(t.attemptId);
  // Transition still succeeds — diff capture is best-effort.
  expect(row.exit_kind).toBe("pr_opened");
  expect(row.diff_summary).toBeNull();

  // tick_error event with capture=diff_summary in event_data so retro
  // analysis can distinguish "didn't capture" from "captured zero diff".
  const ev = h.db
    .query<
      { event_type: string; event_data: string | null },
      [string]
    >(
      `SELECT event_type, event_data FROM events
         WHERE task_id = ? AND event_type = 'tick_error'
         ORDER BY event_id DESC LIMIT 1`,
    )
    .get(t.taskId);
  expect(ev).not.toBeNull();
  expect(ev!.event_data).not.toBeNull();
  const data = JSON.parse(ev!.event_data!);
  expect(data.capture).toBe("diff_summary");
  expect(data.base_sha).toBe("base-sha-x");
  expect(data.head_sha).toBe("head-sha-y");

  // Task itself stays clean — diff capture failure is not a tick error
  // for the *task* (which transitioned successfully); just an event for
  // observability.
  const task = h.db
    .query<{ state: string; tick_error: string | null }, [string]>(
      `SELECT state, tick_error FROM tasks WHERE task_id = ?`,
    )
    .get(t.taskId);
  expect(task!.state).toBe("pr-open");
  expect(task!.tick_error).toBeNull();
});
