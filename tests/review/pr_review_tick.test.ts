import { mkdirSync } from "node:fs";
import { afterEach, expect, test } from "bun:test";
import { tick_once } from "../../src/core/tick.ts";
import { createArtifactStore } from "../../src/artifacts/store.ts";
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

test("CI-green pr-open task enters pr-review when reviewer gate is enabled", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-gated");
  const taskId = insertTask(h.db, { repoId, taskId: "task-gated", state: "pr-open" });
  const attemptId = insertAttempt(h.db, {
    taskId,
    spawnedAt: "2026-01-01T00:00:00.000Z",
  });
  const store = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });
  store.writeArtifact({
    taskId,
    attemptId,
    kind: "brief",
    content: "original task brief",
    extension: "md",
  });
  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    prNumber: 99,
    state: "open",
    headSha: "head-99",
    baseSha: "base-1",
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "head-99",
      items: [{ name: "build", workflow: null, bucket: "pass", required: true }],
    },
  });
  built.github.setPrView(repoId, 99, {
    number: 99,
    title: "Quay-owned PR",
    body: "",
    url: "https://example.test/pr/99",
    headRefName: `quay/${taskId}`,
    headSha: "head-99",
  });

  const results = await tick_once(built.deps, {
    reviewerEnabled: true,
    gateQuayOwnedDone: true,
  });

  expect(results).toContainEqual({ task_id: taskId, action: "review_requested" });
  const task = h.db
    .query<{ state: string; pr_number: number | null }, [string]>(
      `SELECT state, pr_number FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toEqual({ state: "pr-review", pr_number: 99 });
  const reviewAttempt = h.db
    .query<{ reason: string; head_sha: string | null }, [string]>(
      `SELECT reason, head_sha FROM attempts
        WHERE task_id = ? ORDER BY attempt_id DESC LIMIT 1`,
    )
    .get(taskId);
  expect(reviewAttempt).toEqual({ reason: "review_only", head_sha: "head-99" });
});

test("tick spawns pending review attempts without moving task to running", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-spawn-review");
  const taskId = insertTask(h.db, {
    repoId,
    taskId: "task-review-spawn",
    state: "pr-review",
  });
  h.db
    .query(`UPDATE tasks SET pr_number = 10, head_sha = 'review-sha' WHERE task_id = ?`)
    .run(taskId);
  const attemptId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
  });
  h.db
    .query(`UPDATE attempts SET head_sha = 'review-sha' WHERE attempt_id = ?`)
    .run(attemptId);
  insertFinalPromptArtifact(h.db, h.artifactRoot, h.clock, taskId, attemptId, "review prompt");

  const results = await tick_once(built.deps, { reviewerEnabled: true });

  expect(results).toContainEqual({ task_id: taskId, action: "spawned" });
  expect(built.tmux.spawnCalls).toHaveLength(1);
  expect(built.tmux.spawnCalls[0]!.sessionName).toContain("quay-review-");
  const row = h.db
    .query<{ state: string; spawned_at: string | null; tmux_session: string | null }, [number]>(
      `SELECT t.state, a.spawned_at, a.tmux_session
         FROM attempts a JOIN tasks t ON t.task_id = a.task_id
        WHERE a.attempt_id = ?`,
    )
    .get(attemptId);
  expect(row?.state).toBe("pr-review");
  expect(row?.spawned_at).not.toBeNull();
  expect(row?.tmux_session).toContain("quay-review-");
});

test("dead synthetic reviewer approval stores review artifact and marks task done", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-review-done");
  const taskId = "pr-review-repo-review-done-7";
  const worktreePath = `${h.dataDir}/worktrees/review-7`;
  mkdirSync(worktreePath, { recursive: true });
  h.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, state, branch_name, tmux_id, worktree_path,
         pr_number, head_sha, retry_budget, created_at, updated_at
       ) VALUES (?, ?, 'pr-review', 'quay-review/7', 'quay-review-repo-review-done-7',
                 ?, 7, 'sha-7', 1, ?, ?)`,
    )
    .run(taskId, repoId, worktreePath, h.clock.nowISO(), h.clock.nowISO());
  const attemptId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: h.clock.nowISO(),
  });
  h.db
    .query(
      `UPDATE attempts
          SET head_sha = 'sha-7', tmux_session = 'quay-review-session'
        WHERE attempt_id = ?`,
    )
    .run(attemptId);
  built.github.setPostedReview(repoId, 7, "sha-7", {
    reviewId: "R_approved",
    decision: "APPROVED",
    body: "Looks good.",
    comments: "Looks good.",
  });

  const results = await tick_once(built.deps, { reviewerEnabled: true });

  expect(results).toContainEqual({ task_id: taskId, action: "review_approved" });
  const task = h.db
    .query<{ state: string }, [string]>(`SELECT state FROM tasks WHERE task_id = ?`)
    .get(taskId);
  expect(task?.state).toBe("done");
  const attempt = h.db
    .query<{ review_verdict: string | null; review_id: string | null }, [number]>(
      `SELECT review_verdict, review_id FROM attempts WHERE attempt_id = ?`,
    )
    .get(attemptId);
  expect(attempt).toEqual({
    review_verdict: "approved",
    review_id: "R_approved",
  });
  const artifact = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM artifacts
        WHERE task_id = ? AND kind = 'review_comments'`,
    )
    .get(taskId);
  expect(artifact?.n).toBe(1);
});
