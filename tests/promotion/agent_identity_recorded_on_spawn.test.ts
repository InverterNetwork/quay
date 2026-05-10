import { afterEach, expect, test } from "bun:test";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import {
  insertAttempt,
  insertFinalPromptArtifact,
  insertRepo,
  insertTask,
} from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("agent_identity is captured on a successful spawn", async () => {
  h = createHarness();
  h.clock.set("2026-05-09T22:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-agent-id");
  const taskId = insertTask(h.db, { taskId: "task-agent-id", repoId });
  const attemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
  });
  insertFinalPromptArtifact(h.db, h.artifactRoot, h.clock, taskId, attemptId);

  const built = buildTickDeps(h);
  built.git.setRemoteHeadSha(repoId, `quay/${taskId}`, null);
  built.github.setPrExists(repoId, `quay/${taskId}`, false);

  // bun is the runtime executing this test, so the probe is guaranteed
  // to find a working `--version` and we can assert the prefix tightly.
  const results = await tick_once(built.deps, {
    agentInvocation: "bun --version",
  });
  expect(results).toEqual([{ task_id: taskId, action: "spawned" }]);

  const att = h.db
    .query<
      { agent_identity: string | null; tmux_session: string | null },
      [number]
    >(`SELECT agent_identity, tmux_session FROM attempts WHERE attempt_id = ?`)
    .get(attemptId);
  expect(att!.tmux_session).not.toBeNull();
  expect(att!.agent_identity).not.toBeNull();
  expect(att!.agent_identity!.startsWith("bun/")).toBe(true);
  expect(att!.agent_identity!.endsWith("/unknown")).toBe(true);
  expect(att!.agent_identity!.split("/").length).toBe(3);
});

test("agent_identity falls back to unknown when the binary is missing", async () => {
  h = createHarness();
  h.clock.set("2026-05-09T22:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-agent-id-missing");
  const taskId = insertTask(h.db, { taskId: "task-agent-id-missing", repoId });
  const attemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
  });
  insertFinalPromptArtifact(h.db, h.artifactRoot, h.clock, taskId, attemptId);

  const built = buildTickDeps(h);
  built.git.setRemoteHeadSha(repoId, `quay/${taskId}`, null);
  built.github.setPrExists(repoId, `quay/${taskId}`, false);

  const missing = `quay-nonexistent-${Math.random().toString(36).slice(2, 10)}`;
  const results = await tick_once(built.deps, {
    agentInvocation: `${missing} --some-flag`,
  });
  expect(results).toEqual([{ task_id: taskId, action: "spawned" }]);

  const att = h.db
    .query<{ agent_identity: string | null }, [number]>(
      `SELECT agent_identity FROM attempts WHERE attempt_id = ?`,
    )
    .get(attemptId);
  // Missing binary must still produce a non-NULL identity so the column
  // doubles as the "spawn observability landed" signal.
  expect(att!.agent_identity).toBe(`${missing}/unknown/unknown`);
});

test("agent_identity stays NULL when the substrate spawn fails", async () => {
  h = createHarness();
  h.clock.set("2026-05-09T22:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-spawn-fail-id");
  const taskId = insertTask(h.db, { taskId: "task-spawn-fail-id", repoId });
  const attemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
  });
  insertFinalPromptArtifact(h.db, h.artifactRoot, h.clock, taskId, attemptId);

  const built = buildTickDeps(h);
  built.git.setRemoteHeadSha(repoId, `quay/${taskId}`, null);
  built.github.setPrExists(repoId, `quay/${taskId}`, false);
  built.tmux.failSpawnNext();

  const results = await tick_once(built.deps, {
    agentInvocation: "bun --version",
  });
  expect(results).toEqual([
    {
      task_id: taskId,
      action: "spawn_substrate_failed",
      error: expect.any(String),
    },
  ]);

  // No tmux_session was recorded; agent_identity also stays NULL — the two
  // are written together so the spawn-failure window is uniformly NULL.
  const att = h.db
    .query<
      { agent_identity: string | null; tmux_session: string | null },
      [number]
    >(`SELECT agent_identity, tmux_session FROM attempts WHERE attempt_id = ?`)
    .get(attemptId);
  expect(att!.tmux_session).toBeNull();
  expect(att!.agent_identity).toBeNull();
});
