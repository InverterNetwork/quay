import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
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

function seedPendingReview(harness: Harness, slug: string): {
  repoId: string;
  taskId: string;
  attemptId: number;
} {
  const repoId = insertRepo(harness.db, `repo-${slug}`);
  const taskId = insertTask(harness.db, {
    repoId,
    taskId: `task-${slug}`,
    state: "pr-review",
  });
  harness.db
    .query(`UPDATE tasks SET pr_number = 11, head_sha = 'sha-${slug}' WHERE task_id = ?`)
    .run(taskId);
  const attemptId = insertAttempt(harness.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
  });
  harness.db
    .query(`UPDATE attempts SET head_sha = 'sha-${slug}' WHERE attempt_id = ?`)
    .run(attemptId);
  insertFinalPromptArtifact(
    harness.db,
    harness.artifactRoot,
    harness.clock,
    taskId,
    attemptId,
    "review prompt",
  );
  return { repoId, taskId, attemptId };
}

test("reviewer spawn passes only the token file path, never the token bytes", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const { repoId, taskId } = seedPendingReview(h, "token-ok");
  const tokenPath = join(h.dataDir, "reviewer-gh-token");
  mkdirSync(h.dataDir, { recursive: true });
  // Marker distinctive enough that a serialization check can prove the
  // token bytes don't appear anywhere in the spawn input.
  const tokenBytes = "ghs_TOKEN_MARKER_424242";
  writeFileSync(tokenPath, `${tokenBytes}\n`);

  const results = await tick_once(built.deps, {
    reviewerEnabled: true,
    reviewerGhTokenFile: tokenPath,
  });

  expect(results).toContainEqual({ task_id: taskId, action: "spawned" });
  expect(built.github.tokenAccessCalls).toEqual([
    { repoId, token: tokenBytes, actor: "reviewer" },
  ]);
  expect(built.tmux.spawnCalls).toHaveLength(1);
  const call = built.tmux.spawnCalls[0]!;
  expect(call.env).toEqual({
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    [WORKER_GH_TOKEN_ENV]: undefined,
    [REVIEWER_GH_TOKEN_ENV]: undefined,
  });
  expect(call.envFiles).toEqual([{ name: "GH_TOKEN", path: tokenPath }]);
  expect(reviewSpawnedTokenSource(h, taskId)).toBe("file:reviewer.gh_token_file");
  // The whole point of the in-pane `$(cat ...)` design: the token's bytes
  // must NOT travel through the spawn input (and therefore not through
  // any argv on the host). A naive implementation that read the file and
  // stuffed the value into the spawn would regress this.
  expect(JSON.stringify(call)).not.toContain(tokenBytes);
});

test("worker spawn receives the worker token and not the reviewer token as GH_TOKEN", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const tokenPath = join(h.dataDir, "reviewer-gh-token");
  mkdirSync(h.dataDir, { recursive: true });
  writeFileSync(tokenPath, "ghs_irrelevant_for_worker\n");
  const workerToken = "ghs_worker_runtime_token";
  const reviewerToken = "ghs_reviewer_runtime_token";
  // A plain queued worker task.
  const repoId = insertRepo(h.db, "repo-worker-isolation");
  const taskId = insertTask(h.db, {
    repoId,
    taskId: "task-worker-isolation",
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
    reviewerGhTokenFile: tokenPath,
    env: {
      [WORKER_GH_TOKEN_ENV]: workerToken,
      [REVIEWER_GH_TOKEN_ENV]: reviewerToken,
    },
  });

  expect(results).toContainEqual({ task_id: taskId, action: "spawned" });
  expect(built.tmux.spawnCalls).toHaveLength(1);
  const call = built.tmux.spawnCalls[0]!;
  expect(call.env?.GH_TOKEN).toBe(workerToken);
  expect(call.env?.GITHUB_TOKEN).toBeUndefined();
  expect(call.env?.[WORKER_GH_TOKEN_ENV]).toBeUndefined();
  expect(call.env?.[REVIEWER_GH_TOKEN_ENV]).toBeUndefined();
  expect(call.envFiles).toBeUndefined();
  expect(reviewSpawnedTokenSource(h, taskId, "spawned")).toBe(
    `env:${WORKER_GH_TOKEN_ENV}`,
  );
});

test("reviewer spawn uses reviewer env token as GH_TOKEN", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const { repoId, taskId } = seedPendingReview(h, "token-env");
  const workerToken = "ghs_worker_runtime_token";
  const reviewerToken = "ghs_reviewer_runtime_token";

  const results = await tick_once(built.deps, {
    reviewerEnabled: true,
    env: {
      GH_TOKEN: workerToken,
      GITHUB_TOKEN: "ghs_worker_github_token",
      [REVIEWER_GH_TOKEN_ENV]: reviewerToken,
    },
  });

  expect(results).toContainEqual({ task_id: taskId, action: "spawned" });
  expect(built.github.tokenAccessCalls).toEqual([
    { repoId, token: reviewerToken, actor: "reviewer" },
  ]);
  expect(built.tmux.spawnCalls).toHaveLength(1);
  const call = built.tmux.spawnCalls[0]!;
  expect(call.env?.GH_TOKEN).toBe(reviewerToken);
  expect(call.env?.GITHUB_TOKEN).toBeUndefined();
  expect(call.env?.GH_TOKEN).not.toBe(workerToken);
  expect(call.env?.[REVIEWER_GH_TOKEN_ENV]).toBeUndefined();
  expect(call.envFiles).toBeUndefined();
  expect(reviewSpawnedTokenSource(h, taskId)).toBe(
    `env:${REVIEWER_GH_TOKEN_ENV}`,
  );
});

test("reviewer env token wins over gh_token_file when both are present", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const { repoId, taskId } = seedPendingReview(h, "token-env-wins");
  const tokenPath = join(h.dataDir, "reviewer-gh-token");
  mkdirSync(h.dataDir, { recursive: true });
  writeFileSync(tokenPath, "ghs_file_token_that_should_not_be_used\n");
  const reviewerToken = "ghs_reviewer_env_wins";

  const results = await tick_once(built.deps, {
    reviewerEnabled: true,
    reviewerGhTokenFile: tokenPath,
    env: {
      GH_TOKEN: "ghs_worker",
      GITHUB_TOKEN: "ghs_worker_github_token",
      [REVIEWER_GH_TOKEN_ENV]: reviewerToken,
    },
  });

  expect(results).toContainEqual({ task_id: taskId, action: "spawned" });
  expect(built.github.tokenAccessCalls).toEqual([
    { repoId, token: reviewerToken, actor: "reviewer" },
  ]);
  expect(built.tmux.spawnCalls).toHaveLength(1);
  const call = built.tmux.spawnCalls[0]!;
  expect(call.env?.GH_TOKEN).toBe(reviewerToken);
  expect(call.env?.GITHUB_TOKEN).toBeUndefined();
  expect(call.envFiles).toBeUndefined();
  expect(JSON.stringify(call)).not.toContain("ghs_file_token_that_should_not_be_used");
  expect(reviewSpawnedTokenSource(h, taskId)).toBe(
    `env:${REVIEWER_GH_TOKEN_ENV}`,
  );
});

test("reviewer spawn fails before promotion when no reviewer token source exists", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const { taskId, attemptId } = seedPendingReview(h, "token-none");

  const results = await tick_once(built.deps, {
    reviewerEnabled: true,
    env: { GH_TOKEN: "ghs_worker_only" },
  });

  const match = results.find((r) => r.task_id === taskId);
  expect(match?.action).toBe("spawn_substrate_failed");
  expect(match?.error).toContain(REVIEWER_GH_TOKEN_ENV);
  expect(match?.error).toContain("reviewer.gh_token_file");
  expect(built.tmux.spawnCalls).toHaveLength(0);
  expect(built.github.tokenAccessCalls).toHaveLength(0);
  expect(reviewAttemptSpawnedAt(h, attemptId)).toBeNull();
});

test("reviewer spawn fails when gh_token_file is missing", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const { taskId, attemptId } = seedPendingReview(h, "token-missing");
  const tokenPath = join(h.dataDir, "missing-reviewer-token");

  const results = await tick_once(built.deps, {
    reviewerEnabled: true,
    reviewerGhTokenFile: tokenPath,
  });

  const match = results.find((r) => r.task_id === taskId);
  expect(match?.action).toBe("spawn_substrate_failed");
  expect(match?.error).toContain("reviewer gh_token_file");
  expect(match?.error).toMatch(/missing|unreadable/i);
  expect(built.tmux.spawnCalls).toHaveLength(0);
  expect(reviewAttemptSpawnedAt(h, attemptId)).toBeNull();
});

test("reviewer spawn fails when gh_token_file is empty", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const { taskId, attemptId } = seedPendingReview(h, "token-empty");
  const tokenPath = join(h.dataDir, "empty-reviewer-token");
  mkdirSync(h.dataDir, { recursive: true });
  // Whitespace-only file — operator wrote it but the minter hasn't filled
  // it yet. Treat the same as missing: the silent self-review fallback is
  // exactly what this knob exists to prevent.
  writeFileSync(tokenPath, "\n  \n");

  const results = await tick_once(built.deps, {
    reviewerEnabled: true,
    reviewerGhTokenFile: tokenPath,
  });

  const match = results.find((r) => r.task_id === taskId);
  expect(match?.action).toBe("spawn_substrate_failed");
  expect(match?.error).toMatch(/empty/i);
  expect(built.tmux.spawnCalls).toHaveLength(0);
  expect(built.github.tokenAccessCalls).toHaveLength(0);
  expect(reviewAttemptSpawnedAt(h, attemptId)).toBeNull();
});

test("reviewer spawn validates non-empty gh_token_file credentials before promoting attempt", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const { repoId, taskId, attemptId } = seedPendingReview(h, "token-invalid");
  const tokenPath = join(h.dataDir, "invalid-reviewer-token");
  mkdirSync(h.dataDir, { recursive: true });
  const tokenBytes = "ghs_STALE_TOKEN_MARKER_125";
  writeFileSync(tokenPath, `${tokenBytes}\n`);
  built.github.setTokenAccessHandler(() => {
    throw new Error(`HTTP 401: Bad credentials for ${tokenBytes}`);
  });

  const results = await tick_once(built.deps, {
    reviewerEnabled: true,
    reviewerGhTokenFile: tokenPath,
  });

  const match = results.find((r) => r.task_id === taskId);
  expect(match?.action).toBe("spawn_substrate_failed");
  expect(match?.error).toContain("is invalid, expired");
  expect(match?.error).toContain("HTTP 401");
  expect(match?.error).not.toContain(tokenBytes);
  expect(built.github.tokenAccessCalls).toEqual([
    { repoId, token: tokenBytes, actor: "reviewer" },
  ]);
  expect(built.tmux.spawnCalls).toHaveLength(0);
  expect(reviewAttemptSpawnedAt(h, attemptId)).toBeNull();
  expect(reviewInfraFailureEventCount(h, taskId)).toBe(0);
});

function reviewAttemptSpawnedAt(harness: Harness, attemptId: number): string | null {
  const row = harness.db
    .query<{ spawned_at: string | null }, [number]>(
      `SELECT spawned_at FROM attempts WHERE attempt_id = ?`,
    )
    .get(attemptId);
  return row?.spawned_at ?? null;
}

function reviewInfraFailureEventCount(harness: Harness, taskId: string): number {
  const row = harness.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n
         FROM events
        WHERE task_id = ?
          AND event_type = 'review_infra_failed'`,
    )
    .get(taskId);
  return row?.n ?? 0;
}

function reviewSpawnedTokenSource(
  harness: Harness,
  taskId: string,
  eventType = "review_spawned",
): string | null {
  const row = harness.db
    .query<{ event_data: string | null }, [string, string]>(
      `SELECT event_data
         FROM events
        WHERE task_id = ? AND event_type = ?
        ORDER BY event_id DESC LIMIT 1`,
    )
    .get(taskId, eventType);
  if (row?.event_data === null || row?.event_data === undefined) return null;
  const data = JSON.parse(row.event_data) as { github_token_source?: string };
  return data.github_token_source ?? null;
}
