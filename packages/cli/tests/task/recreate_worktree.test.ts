import { afterEach, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { dispatch } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";
import { enqueue } from "../../src/core/enqueue.ts";
import { createRepoService } from "../../src/core/repos/service.ts";
import { recreate_task_worktree } from "../../src/core/recreate_worktree.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { buildCliDeps, type BuiltCliDeps } from "../support/cli_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

function setupTask(): {
  h: Harness;
  built: BuiltCliDeps;
  task: {
    task_id: string;
    branch_name: string;
    worktree_path: string;
  };
} {
  const harness = createHarness();
  createRepoService({ db: harness.db, clock: harness.clock }).add({
    repo_id: "repo-a",
    repo_url: "git@example.com:owner/repo-a.git",
    base_branch: "main",
    package_manager: "bun",
    install_cmd: "bun install",
  });
  const built = buildCliDeps(harness);
  built.git.seedBareClone("repo-a");
  harness.ids.push("11111111aaaaaaaaaaaaaaaaaaaaaaaa");
  const task = enqueue(
    {
      db: harness.db,
      clock: harness.clock,
      ids: harness.ids,
      git: built.git,
      commandRunner: built.commandRunner,
      artifactStore: built.deps.artifactStore,
      paths: built.deps.paths,
      agentResolver: built.deps.agentResolver,
    },
    {
      repo_id: "repo-a",
      brief: "Recover this task worktree.",
      external_ref: "BRIX-1923",
    },
  );
  h = harness;
  return { h: harness, built, task };
}

function removeRecordedWorktree(task: { worktree_path: string }): void {
  rmSync(task.worktree_path, { recursive: true, force: true });
}

test("recreate_task_worktree restores from remote task branch and audits event", async () => {
  const { h, built, task } = setupTask();
  removeRecordedWorktree(task);
  built.git.setRemoteBranches("repo-a", [task.branch_name]);

  const result = await recreate_task_worktree(
    {
      db: h.db,
      clock: h.clock,
      git: built.git,
      commandRunner: built.commandRunner,
      supervisorLock: built.deps.supervisorLock,
    },
    { taskId: task.task_id, yes: true },
  );

  expect(result).toEqual({
    ok: true,
    value: {
      task_id: task.task_id,
      repo_id: "repo-a",
      branch_name: task.branch_name,
      base_branch: "main",
      worktree_path: task.worktree_path,
      recovery_base: "remote_task_branch",
      recovery_ref: `origin/${task.branch_name}`,
      forced: false,
    },
  });
  expect(existsSync(task.worktree_path)).toBe(true);
  expect(built.commandRunner.calls.at(-1)).toEqual({
    command: "bun install",
    cwd: task.worktree_path,
  });
  expect(built.git.calls).toContainEqual({
    op: "worktreeAddExistingBranch",
    args: {
      repoId: "repo-a",
      worktreePath: task.worktree_path,
      branch: task.branch_name,
      baseRef: `origin/${task.branch_name}`,
    },
  });

  const event = h.db
    .query<
      {
        event_type: string;
        from_state: string;
        to_state: string;
        event_data: string;
      },
      [string]
    >(
      `SELECT event_type, from_state, to_state, event_data
         FROM events
        WHERE task_id = ? AND event_type = 'worktree_recreated'`,
    )
    .get(task.task_id);
  expect(event).toMatchObject({
    event_type: "worktree_recreated",
    from_state: "queued",
    to_state: "queued",
  });
  expect(JSON.parse(event!.event_data)).toMatchObject({
    worktree_path: task.worktree_path,
    branch_name: task.branch_name,
    recovery_base: "remote_task_branch",
    recovery_ref: `origin/${task.branch_name}`,
    forced: false,
  });
});

test("recreate_task_worktree falls back to origin base branch when task branch is not remote", async () => {
  const { built, task } = setupTask();
  removeRecordedWorktree(task);
  built.git.setRemoteBranches("repo-a", []);

  const result = await recreate_task_worktree(
    {
      db: h!.db,
      clock: h!.clock,
      git: built.git,
      commandRunner: built.commandRunner,
      supervisorLock: built.deps.supervisorLock,
    },
    { taskId: task.task_id, yes: true },
  );

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected success");
  expect(result.value.recovery_base).toBe("remote_base_branch");
  expect(result.value.recovery_ref).toBe("origin/main");
  expect(built.git.calls).toContainEqual({
    op: "fetch",
    args: { repoId: "repo-a", ref: "main" },
  });
  expect(built.git.worktreeBranches.get(task.worktree_path)).toEqual({
    repoId: "repo-a",
    branch: task.branch_name,
  });
});

test("recreate_task_worktree refuses an existing path unless forced", async () => {
  const { built, task } = setupTask();

  const refused = await recreate_task_worktree(
    {
      db: h!.db,
      clock: h!.clock,
      git: built.git,
      commandRunner: built.commandRunner,
      supervisorLock: built.deps.supervisorLock,
    },
    { taskId: task.task_id, yes: true },
  );
  expect(refused).toMatchObject({
    ok: false,
    error: { code: "worktree_exists" },
  });

  built.git.setRemoteBranches("repo-a", [task.branch_name]);
  const forced = await recreate_task_worktree(
    {
      db: h!.db,
      clock: h!.clock,
      git: built.git,
      commandRunner: built.commandRunner,
      supervisorLock: built.deps.supervisorLock,
    },
    { taskId: task.task_id, yes: true, force: true },
  );
  expect(forced.ok).toBe(true);
  expect(built.git.countCalls("worktreeRemove")).toBe(1);
});

test("recreate_task_worktree refuses an active attempt unless forced", async () => {
  const { built, task } = setupTask();
  removeRecordedWorktree(task);
  h!.db
    .query(
      `UPDATE attempts
          SET spawned_at = ?, tmux_session = ?
        WHERE task_id = ? AND ended_at IS NULL`,
    )
    .run(h!.clock.nowISO(), "quay-live", task.task_id);

  const refused = await recreate_task_worktree(
    {
      db: h!.db,
      clock: h!.clock,
      git: built.git,
      commandRunner: built.commandRunner,
      supervisorLock: built.deps.supervisorLock,
    },
    { taskId: task.task_id, yes: true },
  );
  expect(refused).toMatchObject({
    ok: false,
    error: {
      code: "active_task",
      details: { tmux_session: "quay-live" },
    },
  });

  const forced = await recreate_task_worktree(
    {
      db: h!.db,
      clock: h!.clock,
      git: built.git,
      commandRunner: built.commandRunner,
      supervisorLock: built.deps.supervisorLock,
    },
    { taskId: task.task_id, yes: true, force: true },
  );
  expect(forced.ok).toBe(true);
});

test("task recreate-worktree CLI validates confirmation and emits JSON result", async () => {
  const { built, task } = setupTask();
  removeRecordedWorktree(task);
  built.git.setRemoteBranches("repo-a", [task.branch_name]);

  const missingYesIo = bufferIO();
  const missingYes = await dispatch(
    ["task", "recreate-worktree", task.task_id],
    built.deps,
    missingYesIo,
  );
  expect(missingYes.exitCode).toBe(1);
  expect(JSON.parse(missingYesIo.err())).toMatchObject({
    error: "confirmation_required",
  });

  const io = bufferIO();
  const result = await dispatch(
    ["task", "recreate-worktree", task.task_id, "--yes"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");
  expect(JSON.parse(io.out())).toMatchObject({
    task_id: task.task_id,
    repo_id: "repo-a",
    recovery_base: "remote_task_branch",
    recovery_ref: `origin/${task.branch_name}`,
    forced: false,
  });
});
