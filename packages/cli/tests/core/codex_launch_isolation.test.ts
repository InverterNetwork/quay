import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { createAgentResolver } from "../../src/core/agents.ts";
import {
  REVIEWER_GH_TOKEN_ENV,
  WORKER_GH_TOKEN_ENV,
  tick_once,
} from "../../src/core/tick.ts";
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
      [WORKER_GH_TOKEN_ENV]: "ghs_fresh_worker_token",
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
    [WORKER_GH_TOKEN_ENV]: undefined,
    [REVIEWER_GH_TOKEN_ENV]: undefined,
    QUAY_CODEX_SOURCE_HOME: "",
    CODEX_HOME: join(
      call.worktreePath,
      "..",
      ".quay-codex-home",
      createHash("sha256").update(taskId).digest("hex"),
    ),
  });
  expect(call.env!.CODEX_HOME!.startsWith(call.worktreePath)).toBe(false);
  expect(call.envFiles).toBeUndefined();
  expect(spawnedTokenSource(h, taskId)).toBe(`env:${WORKER_GH_TOKEN_ENV}`);
});

test("worker QUAY_WORKER_GH_TOKEN is promoted to GH_TOKEN and cleared before spawn", async () => {
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
    env: { [WORKER_GH_TOKEN_ENV]: "ghs_only_worker_token" },
  });

  expect(results).toContainEqual({ task_id: taskId, action: "spawned" });
  expect(built.tmux.spawnCalls).toHaveLength(1);
  const call = built.tmux.spawnCalls[0]!;
  expect(call.env?.GH_TOKEN).toBe("ghs_only_worker_token");
  expect(call.env?.GITHUB_TOKEN).toBeUndefined();
  expect(call.env?.[WORKER_GH_TOKEN_ENV]).toBeUndefined();
  expect(spawnedTokenSource(h, taskId)).toBe(`env:${WORKER_GH_TOKEN_ENV}`);
});

test("worker PR existence snapshot uses resolved actor token", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-worker-pr-exists-token");
  const taskId = insertTask(h.db, {
    repoId,
    taskId: "task-worker-pr-exists-token",
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
  built.github.setPrExists(repoId, "quay/task-worker-pr-exists-token", true);
  const token = "ghs_worker_pr_exists_token";
  built.github.setTokenAccessHandler(() => {
    expect(built.github.calls).toHaveLength(0);
  });

  const results = await tick_once(built.deps, {
    env: {
      [WORKER_GH_TOKEN_ENV]: token,
      GH_TOKEN: "ghs_ambient_should_not_be_used",
      GITHUB_TOKEN: "ghs_secondary_should_not_be_used",
    },
  });

  expect(results).toContainEqual({ task_id: taskId, action: "spawned" });
  expect(built.github.calls).toHaveLength(0);
  expect(built.github.prExistsWithTokenCalls).toEqual([
    {
      repoId,
      branch: "quay/task-worker-pr-exists-token",
      token,
    },
  ]);
  const row = h.db
    .query<{ pr_existed_at_spawn: number }, [number]>(
      `SELECT pr_existed_at_spawn FROM attempts WHERE attempt_id = ?`,
    )
    .get(attemptId);
  expect(row?.pr_existed_at_spawn).toBe(1);
});

test("worker spawn fails before tmux when actor token is invalid", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-worker-invalid-token");
  const taskId = insertTask(h.db, {
    repoId,
    taskId: "task-worker-invalid-token",
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
  const token = "ghs_WORKER_BAD_TOKEN_MARKER";
  built.github.setTokenAccessHandler(() => {
    throw new Error(`HTTP 401: Bad credentials for ${token}`);
  });

  const results = await tick_once(built.deps, {
    env: { [WORKER_GH_TOKEN_ENV]: token },
  });

  const match = results.find((r) => r.task_id === taskId);
  expect(match?.action).toBe("spawn_substrate_failed");
  expect(match?.error).toContain("worker GitHub token");
  expect(match?.error).toContain("HTTP 401");
  expect(match?.error).not.toContain(token);
  expect(built.github.tokenAccessCalls).toEqual([
    { repoId, token, actor: "worker" },
  ]);
  expect(built.github.calls).toHaveLength(0);
  expect(built.github.prExistsWithTokenCalls).toHaveLength(0);
  expect(built.tmux.spawnCalls).toHaveLength(0);
  expect(attemptSpawnedAt(h, attemptId)).toBeNull();
});

test("worker empty token fails with clear error", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-worker-empty-token");
  const taskId = insertTask(h.db, {
    repoId,
    taskId: "task-worker-empty-token",
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
    env: { [WORKER_GH_TOKEN_ENV]: "  " },
  });

  const match = results.find((r) => r.task_id === taskId);
  expect(match?.action).toBe("spawn_substrate_failed");
  expect(match?.error).toContain(WORKER_GH_TOKEN_ENV);
  expect(match?.error).toMatch(/empty/i);
  expect(built.github.tokenAccessCalls).toHaveLength(0);
  expect(built.tmux.spawnCalls).toHaveLength(0);
});

test("worker token file is preferred over ambient env without exposing token bytes", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-worker-token-file");
  const taskId = insertTask(h.db, {
    repoId,
    taskId: "task-worker-token-file",
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
  const tokenPath = join(h.dataDir, "worker-gh-token");
  const token = "ghs_WORKER_FILE_TOKEN_MARKER";
  mkdirSync(h.dataDir, { recursive: true });
  writeFileSync(tokenPath, `${token}\n`);

  const results = await tick_once(built.deps, {
    workerGhTokenFile: tokenPath,
    env: {
      [WORKER_GH_TOKEN_ENV]: "ghs_STALE_WORKER_ENV_TOKEN",
      GH_TOKEN: "ghs_stale_ambient_token",
      GITHUB_TOKEN: "ghs_stale_secondary_token",
      [REVIEWER_GH_TOKEN_ENV]: "ghs_reviewer_should_not_leak",
    },
  });

  expect(results).toContainEqual({ task_id: taskId, action: "spawned" });
  expect(built.github.tokenAccessCalls).toEqual([
    { repoId, token, actor: "worker" },
  ]);
  const call = built.tmux.spawnCalls[0]!;
  expect(call.env).toEqual({
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    [WORKER_GH_TOKEN_ENV]: undefined,
    [REVIEWER_GH_TOKEN_ENV]: undefined,
  });
  expect(call.envFiles).toEqual([{ name: "GH_TOKEN", path: tokenPath }]);
  expect(JSON.stringify(call)).not.toContain(token);
  expect(JSON.stringify(call)).not.toContain("ghs_STALE_WORKER_ENV_TOKEN");
  expect(JSON.stringify(call)).not.toContain("ghs_stale_ambient_token");
  expect(JSON.stringify(call)).not.toContain("ghs_stale_secondary_token");
  expect(JSON.stringify(call)).not.toContain("ghs_reviewer_should_not_leak");
  expect(spawnedTokenSource(h, taskId)).toBe("file:worker.gh_token_file");
});

function attemptSpawnedAt(harness: Harness, attemptId: number): string | null {
  const row = harness.db
    .query<{ spawned_at: string | null }, [number]>(
      `SELECT spawned_at FROM attempts WHERE attempt_id = ?`,
    )
    .get(attemptId);
  return row?.spawned_at ?? null;
}

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
