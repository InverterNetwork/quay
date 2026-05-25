import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dispatch } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";
import { enqueue } from "../../src/core/enqueue.ts";
import {
  clearAllFailpoints,
  setFailpoint,
} from "../../src/core/failpoints.ts";
import { createRepoService } from "../../src/core/repos/service.ts";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { buildCliDeps } from "../support/cli_deps.ts";
import { insertRunningTask, seedTaskObjective } from "../support/fixtures.ts";

let h: Harness | null = null;
afterEach(() => {
  clearAllFailpoints();
  h?.cleanup();
  h = null;
});

function addRepo(harness: Harness, repoId: string, baseBranch = "main"): void {
  createRepoService({ db: harness.db, clock: harness.clock }).add({
    repo_id: repoId,
    repo_url: `git@example.com:owner/${repoId}.git`,
    base_branch: baseBranch,
    package_manager: "bun",
    install_cmd: "bun install",
  });
}

test("task retarget clones source task into target repo and audits source cancellation", async () => {
  h = createHarness();
  addRepo(h, "repo-source");
  addRepo(h, "repo-target", "dev");

  const built = buildCliDeps(h);
  built.git.seedBareClone("repo-source");
  built.git.seedBareClone("repo-target");
  h.ids.push("11111111aaaaaaaaaaaaaaaaaaaaaaaa");
  h.ids.push("22222222bbbbbbbbbbbbbbbbbbbbbbbb");

  const source = enqueue(
    {
      db: h.db,
      clock: h.clock,
      ids: h.ids,
      git: built.git,
      commandRunner: built.commandRunner,
      artifactStore: built.deps.artifactStore,
      paths: built.deps.paths,
      retryBudget: 7,
      agentResolver: built.deps.agentResolver,
    },
    {
      repo_id: "repo-source",
      brief: "Move this work to the right repo.",
      ticket_snapshot: "Ticket body",
      external_ref: "BRIX-1469",
      tags: ["backend", "retarget"],
      base_branch: "main",
    },
  );

  const io = bufferIO();
  const result = await dispatch(
    [
      "task",
      "retarget",
      source.task_id,
      "--repo",
      "repo-target",
      "--base-branch",
      "release",
      "--yes",
    ],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");
  const payload = JSON.parse(io.out());
  expect(payload).toMatchObject({
    task_id: source.task_id,
    state: "cancelled",
    retargeted_task_id: "22222222bbbbbbbbbbbbbbbbbbbbbbbb",
    retargeted_repo_id: "repo-target",
  });

  const rows = h.db
    .query<
      {
        task_id: string;
        repo_id: string;
        state: string;
        base_branch: string | null;
        retargeted_from_task_id: string | null;
        retry_budget: number;
      },
      []
    >(
      `SELECT task_id, repo_id, state, base_branch, retargeted_from_task_id,
              retry_budget
         FROM tasks
        ORDER BY task_id`,
    )
    .all();
  expect(rows).toContainEqual({
    task_id: source.task_id,
    repo_id: "repo-source",
    state: "cancelled",
    base_branch: "main",
    retargeted_from_task_id: null,
    retry_budget: 7,
  });
  expect(rows).toContainEqual({
    task_id: "22222222bbbbbbbbbbbbbbbbbbbbbbbb",
    repo_id: "repo-target",
    state: "queued",
    base_branch: "release",
    retargeted_from_task_id: source.task_id,
    retry_budget: 7,
  });

  const objectivePath = h.db
    .query<{ file_path: string }, [string]>(
      `SELECT file_path FROM artifacts
        WHERE task_id = ? AND kind = 'task_objective' AND attempt_id IS NULL`,
    )
    .get("22222222bbbbbbbbbbbbbbbbbbbbbbbb")!.file_path;
  expect(readFileSync(objectivePath, "utf8")).toBe("Move this work to the right repo.");

  const tags = h.db
    .query<{ tag: string }, [string]>(
      `SELECT tag FROM task_tags WHERE task_id = ? ORDER BY tag`,
    )
    .all("22222222bbbbbbbbbbbbbbbbbbbbbbbb")
    .map((row) => row.tag);
  expect(tags).toEqual(["backend", "retarget"]);

  const event = h.db
    .query<
      { event_type: string; from_state: string | null; to_state: string | null; event_data: string | null },
      [string]
    >(
      `SELECT event_type, from_state, to_state, event_data
         FROM events
        WHERE task_id = ?
        ORDER BY event_id DESC
        LIMIT 1`,
    )
    .get(source.task_id);
  expect(event).toMatchObject({
    event_type: "retargeted",
    from_state: "queued",
    to_state: "cancelled",
  });
  expect(JSON.parse(event!.event_data!)).toMatchObject({
    target_repo_id: "repo-target",
    target_task_id: "22222222bbbbbbbbbbbbbbbbbbbbbbbb",
    base_branch_override: "release",
  });

  const getIo = bufferIO();
  const getResult = await dispatch(
    ["task", "get", "22222222bbbbbbbbbbbbbbbbbbbbbbbb"],
    built.deps,
    getIo,
  );
  expect(getResult.exitCode).toBe(0);
  expect(JSON.parse(getIo.out())).toMatchObject({
    task_id: "22222222bbbbbbbbbbbbbbbbbbbbbbbb",
    retargeted_from_task_id: source.task_id,
  });
});

test("task retarget requires explicit confirmation", async () => {
  h = createHarness();
  addRepo(h, "repo-source");
  addRepo(h, "repo-target");

  const built = buildCliDeps(h);
  built.git.seedBareClone("repo-source");
  built.git.seedBareClone("repo-target");
  h.ids.push("33333333aaaaaaaaaaaaaaaaaaaaaaaa");

  const source = enqueue(
    {
      db: h.db,
      clock: h.clock,
      ids: h.ids,
      git: built.git,
      commandRunner: built.commandRunner,
      artifactStore: built.deps.artifactStore,
      paths: built.deps.paths,
      agentResolver: built.deps.agentResolver,
    },
    {
      repo_id: "repo-source",
      brief: "Needs another repo.",
    },
  );

  const io = bufferIO();
  const result = await dispatch(
    ["task", "retarget", source.task_id, "--repo", "repo-target"],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(io.err())).toMatchObject({
    error: "confirmation_required",
  });
  expect(
    h.db
      .query<{ count: number }, []>(`SELECT count(*) AS count FROM tasks`)
      .get()!.count,
  ).toBe(1);
});

test("task retarget closes active attempt when source is running", async () => {
  h = createHarness();
  h.clock.set("2026-05-25T10:00:00.000Z");
  addRepo(h, "repo-source");
  addRepo(h, "repo-target");

  const built = buildCliDeps(h);
  built.git.seedBareClone("repo-source");
  built.git.seedBareClone("repo-target");
  h.ids.push("44444444bbbbbbbbbbbbbbbbbbbbbbbb");

  const source = insertRunningTask(h.db, {
    taskId: "running-retarget-source",
    repoId: "repo-source",
    worktreesRoot: built.worktreesRoot,
    spawnedAt: "2026-05-25T09:00:00.000Z",
    tmuxSession: "quay-task-running-retarget-source-1",
  });
  seedTaskObjective(h, source.taskId, "Retarget this active worker.");
  built.tmux.liveSessions.add(source.sessionName!);
  h.db
    .query(`UPDATE attempts SET kill_intent = 'wall_clock' WHERE attempt_id = ?`)
    .run(source.attemptId);

  const io = bufferIO();
  const result = await dispatch(
    ["task", "retarget", source.taskId, "--repo", "repo-target", "--yes"],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  expect(built.tmux.killCalls).toContain(source.sessionName!);
  expect(built.tmux.liveSessions.has(source.sessionName!)).toBe(false);

  const attempt = h.db
    .query<
      { ended_at: string | null; exit_kind: string | null; kill_intent: string | null },
      [number]
    >(
      `SELECT ended_at, exit_kind, kill_intent
         FROM attempts
        WHERE attempt_id = ?`,
    )
    .get(source.attemptId);
  expect(attempt).toEqual({
    ended_at: "2026-05-25T10:00:00.000Z",
    exit_kind: "killed_cancel",
    kill_intent: null,
  });

  const event = h.db
    .query<{ attempt_id: number | null; event_type: string }, [string]>(
      `SELECT attempt_id, event_type
         FROM events
        WHERE task_id = ?
        ORDER BY event_id DESC
        LIMIT 1`,
    )
    .get(source.taskId);
  expect(event).toEqual({
    attempt_id: source.attemptId,
    event_type: "retargeted",
  });
});

test("task retarget kills canonical session when running attempt has no tmux_session yet", async () => {
  h = createHarness();
  h.clock.set("2026-05-25T10:00:00.000Z");
  addRepo(h, "repo-source");
  addRepo(h, "repo-target");

  const built = buildCliDeps(h);
  built.git.seedBareClone("repo-source");
  built.git.seedBareClone("repo-target");
  h.ids.push("55555555bbbbbbbbbbbbbbbbbbbbbbbb");

  const source = insertRunningTask(h.db, {
    taskId: "spawn-window-retarget-source",
    repoId: "repo-source",
    worktreesRoot: built.worktreesRoot,
    tmuxId: "spawn-window",
    attemptNumber: 3,
    tmuxSession: null,
  });
  seedTaskObjective(h, source.taskId, "Retarget this spawn-window worker.");
  const canonicalSession = `quay-task-${source.tmuxId}-${source.attemptNumber}`;
  built.tmux.liveSessions.add(canonicalSession);

  const io = bufferIO();
  const result = await dispatch(
    ["task", "retarget", source.taskId, "--repo", "repo-target", "--yes"],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  expect(built.tmux.killCalls).toContain(canonicalSession);
  expect(built.tmux.liveSessions.has(canonicalSession)).toBe(false);

  const attempt = h.db
    .query<
      { ended_at: string | null; exit_kind: string | null; tmux_session: string | null },
      [number]
    >(
      `SELECT ended_at, exit_kind, tmux_session
         FROM attempts
        WHERE attempt_id = ?`,
    )
    .get(source.attemptId);
  expect(attempt).toEqual({
    ended_at: "2026-05-25T10:00:00.000Z",
    exit_kind: "killed_cancel",
    tmux_session: null,
  });
});

test("task retarget crash after intent is recovered by cancel finalizer", async () => {
  h = createHarness();
  h.clock.set("2026-05-25T10:00:00.000Z");
  addRepo(h, "repo-source");
  addRepo(h, "repo-target");

  const built = buildCliDeps(h);
  built.git.seedBareClone("repo-source");
  built.git.seedBareClone("repo-target");
  built.github.setPrIsOpen("repo-source", "quay/running-retarget-source", false);
  h.ids.push("66666666bbbbbbbbbbbbbbbbbbbbbbbb");

  const source = insertRunningTask(h.db, {
    taskId: "running-retarget-source",
    repoId: "repo-source",
    worktreesRoot: built.worktreesRoot,
    spawnedAt: "2026-05-25T09:00:00.000Z",
    tmuxSession: "quay-task-running-retarget-source-1",
  });
  seedTaskObjective(h, source.taskId, "Retarget with recoverable intent.");
  built.tmux.liveSessions.add(source.sessionName!);

  setFailpoint("after_retarget_intent_commit", () => {
    throw new Error("simulated crash after retarget intent commit");
  });

  const io = bufferIO();
  const result = await dispatch(
    ["task", "retarget", source.taskId, "--repo", "repo-target", "--yes"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(io.err())).toMatchObject({
    error: "internal_error",
    message: expect.stringContaining("simulated crash"),
  });

  const midTask = h.db
    .query<
      {
        state: string;
        cancel_requested_at: string | null;
        retargeted_from_task_id: string | null;
      },
      [string]
    >(
      `SELECT state, cancel_requested_at, retargeted_from_task_id
         FROM tasks
        WHERE task_id = ?`,
    )
    .get(source.taskId);
  expect(midTask).toEqual({
    state: "running",
    cancel_requested_at: "2026-05-25T10:00:00.000Z",
    retargeted_from_task_id: null,
  });
  const cloned = h.db
    .query<{ retargeted_from_task_id: string | null }, [string]>(
      `SELECT retargeted_from_task_id FROM tasks WHERE task_id = ?`,
    )
    .get("66666666bbbbbbbbbbbbbbbbbbbbbbbb");
  expect(cloned).toEqual({ retargeted_from_task_id: source.taskId });
  const midAttempt = h.db
    .query<{ ended_at: string | null; kill_intent: string | null }, [number]>(
      `SELECT ended_at, kill_intent FROM attempts WHERE attempt_id = ?`,
    )
    .get(source.attemptId);
  expect(midAttempt).toEqual({ ended_at: null, kill_intent: "cancel" });
  expect(built.tmux.liveSessions.has(source.sessionName!)).toBe(true);

  clearAllFailpoints();
  expect(await tick_once(built.deps)).toContainEqual({
    task_id: source.taskId,
    action: "cancel_finalized",
  });

  const finalTask = h.db
    .query<{ state: string }, [string]>(
      `SELECT state FROM tasks WHERE task_id = ?`,
    )
    .get(source.taskId);
  expect(finalTask).toEqual({ state: "cancelled" });
  const finalAttempt = h.db
    .query<{ ended_at: string | null; exit_kind: string | null; kill_intent: string | null }, [number]>(
      `SELECT ended_at, exit_kind, kill_intent FROM attempts WHERE attempt_id = ?`,
    )
    .get(source.attemptId);
  expect(finalAttempt!.ended_at).not.toBeNull();
  expect(finalAttempt!.exit_kind).toBe("killed_cancel");
  expect(finalAttempt!.kill_intent).toBeNull();
  expect(built.tmux.killCalls).toContain(source.sessionName!);
});
