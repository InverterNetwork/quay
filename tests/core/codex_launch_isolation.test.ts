import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { createAgentResolver } from "../../src/core/agents.ts";
import { REVIEWER_GH_TOKEN_ENV, tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { buildTickDeps } from "../support/tick_deps.ts";
import {
  insertAttempt,
  insertFinalPromptArtifact,
  insertRepo,
  insertTask,
} from "../support/fixtures.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("codex worker spawn gets isolated CODEX_HOME and canonical fresh GH_TOKEN", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-codex-isolation");
  const taskId = insertTask(h.db, {
    repoId,
    taskId: "task-codex-isolation",
    state: "queued",
  });
  const attemptId = insertAttempt(h.db, { taskId, consumedBudget: 0 });
  insertFinalPromptArtifact(
    h.db,
    h.artifactRoot,
    h.clock,
    taskId,
    attemptId,
    "worker prompt",
  );

  const resolver = createAgentResolver({
    db: h.db,
    config: {
      agents: {
        worker: "codex",
        invocations: {
          codex: {
            worker: "codex exec < {prompt_file}",
            reviewer: "codex exec --review < {prompt_file}",
          },
        },
      },
    },
  });

  const results = await tick_once(built.deps, {
    agentResolver: resolver,
    env: {
      GH_TOKEN: "ghs_fresh_worker_token",
      GITHUB_TOKEN: "ghs_stale_secondary_token",
      [REVIEWER_GH_TOKEN_ENV]: "ghs_reviewer_should_not_leak",
    },
  });

  expect(results).toContainEqual({ task_id: taskId, action: "spawned" });
  expect(built.tmux.spawnCalls).toHaveLength(1);
  const call = built.tmux.spawnCalls[0]!;
  expect(call.env).toEqual({
    GH_TOKEN: "ghs_fresh_worker_token",
    GITHUB_TOKEN: undefined,
    [REVIEWER_GH_TOKEN_ENV]: undefined,
    CODEX_HOME: join(call.worktreePath, ".quay-codex-home"),
  });
  expect(call.envFiles).toBeUndefined();
  expect(spawnedTokenSource(h, taskId)).toBe("env:GH_TOKEN");
});

test("worker GITHUB_TOKEN is promoted to GH_TOKEN and cleared before spawn", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-github-token");
  const taskId = insertTask(h.db, {
    repoId,
    taskId: "task-github-token",
    state: "queued",
  });
  const attemptId = insertAttempt(h.db, { taskId, consumedBudget: 0 });
  insertFinalPromptArtifact(
    h.db,
    h.artifactRoot,
    h.clock,
    taskId,
    attemptId,
    "worker prompt",
  );

  const results = await tick_once(built.deps, {
    env: { GITHUB_TOKEN: "ghs_only_github_token" },
  });

  expect(results).toContainEqual({ task_id: taskId, action: "spawned" });
  expect(built.tmux.spawnCalls).toHaveLength(1);
  const call = built.tmux.spawnCalls[0]!;
  expect(call.env?.GH_TOKEN).toBe("ghs_only_github_token");
  expect(call.env?.GITHUB_TOKEN).toBeUndefined();
  expect(spawnedTokenSource(h, taskId)).toBe("env:GITHUB_TOKEN");
});

function spawnedTokenSource(harness: Harness, taskId: string): string | null {
  const row = harness.db
    .query<{ event_data: string | null }, [string]>(
      `SELECT event_data FROM events
        WHERE task_id = ? AND event_type = 'spawned'
        ORDER BY event_id DESC LIMIT 1`,
    )
    .get(taskId);
  if (!row?.event_data) return null;
  const data = JSON.parse(row.event_data) as { github_token_source?: string };
  return data.github_token_source ?? null;
}
