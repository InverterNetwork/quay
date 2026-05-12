import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { tick_once } from "../../src/core/tick.ts";
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
  return { taskId, attemptId };
}

test("reviewer spawn passes only the token file path, never the token bytes", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const { taskId } = seedPendingReview(h, "token-ok");
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
  expect(built.tmux.spawnCalls).toHaveLength(1);
  const call = built.tmux.spawnCalls[0]!;
  expect(call.envFiles).toEqual([{ name: "GH_TOKEN", path: tokenPath }]);
  // The whole point of the in-pane `$(cat ...)` design: the token's bytes
  // must NOT travel through the spawn input (and therefore not through
  // any argv on the host). A naive implementation that read the file and
  // stuffed the value into the spawn would regress this.
  expect(JSON.stringify(call)).not.toContain(tokenBytes);
});

test("worker spawn never receives GH_TOKEN envFiles even when reviewer config is set", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const tokenPath = join(h.dataDir, "reviewer-gh-token");
  mkdirSync(h.dataDir, { recursive: true });
  writeFileSync(tokenPath, "ghs_irrelevant_for_worker\n");
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
  });

  expect(results).toContainEqual({ task_id: taskId, action: "spawned" });
  expect(built.tmux.spawnCalls).toHaveLength(1);
  // The worker pane must inherit the host's default gh auth — never the
  // reviewer-specific token.
  expect(built.tmux.spawnCalls[0]!.envFiles).toBeUndefined();
});

test("reviewer spawn fails when gh_token_file is missing", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const { taskId } = seedPendingReview(h, "token-missing");
  const tokenPath = join(h.dataDir, "missing-reviewer-token");

  const results = await tick_once(built.deps, {
    reviewerEnabled: true,
    reviewerGhTokenFile: tokenPath,
  });

  const match = results.find((r) => r.task_id === taskId);
  expect(match?.action).toBe("spawn_substrate_failed");
  expect(match?.error).toContain("reviewer gh_token_file");
  expect(built.tmux.spawnCalls).toHaveLength(0);
});

test("reviewer spawn fails when gh_token_file is empty", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const { taskId } = seedPendingReview(h, "token-empty");
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
});
