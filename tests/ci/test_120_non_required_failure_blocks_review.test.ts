import { readFileSync } from "node:fs";
import { afterEach, expect, test } from "bun:test";
import { createArtifactStore } from "../../src/artifacts/store.ts";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo, insertTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("AST-120: non-required failing check blocks pr-review and schedules ci_fail", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-ast-120-open");
  const taskId = insertTask(h.db, {
    taskId: "task-ast-120-open",
    repoId,
    state: "pr-open",
  });
  const attemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-05-14T06:20:00.000Z",
  });
  createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  }).writeArtifact({
    taskId,
    attemptId,
    kind: "brief",
    content: "fix the installer",
    extension: "md",
  });

  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    prNumber: 90,
    state: "open",
    headSha: "head-failing",
    baseSha: "base",
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "head-failing",
      items: [
        {
          name: "install",
          workflow: "installer-smoke",
          bucket: "fail",
          required: false,
        },
      ],
    },
  });

  const results = await tick_once(built.deps, {
    reviewerEnabled: true,
    gateQuayOwnedDone: true,
  });

  expect(results).toEqual([{ task_id: taskId, action: "ci_failed" }]);
  const task = h.db
    .query<{ state: string }, [string]>(`SELECT state FROM tasks WHERE task_id = ?`)
    .get(taskId);
  expect(task?.state).toBe("queued");
  const reviewAttempts = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM attempts
        WHERE task_id = ? AND reason = 'review_only'`,
    )
    .get(taskId);
  expect(reviewAttempts?.n).toBe(0);
  const retry = h.db
    .query<{ reason: string; consumed_budget: number }, [string]>(
      `SELECT reason, consumed_budget FROM attempts
        WHERE task_id = ? ORDER BY attempt_id DESC LIMIT 1`,
    )
    .get(taskId);
  expect(retry).toEqual({ reason: "ci_fail", consumed_budget: 1 });
  expect(readArtifact("ci_failure_excerpt")).toContain(
    "installer-smoke/install = fail",
  );
});

test("AST-120: approved Quay-owned review cannot mark done with failing checks", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-ast-120-review");
  const taskId = insertTask(h.db, {
    taskId: "task-ast-120-review",
    repoId,
    state: "pr-review",
  });
  h.db
    .query(`UPDATE tasks SET pr_number = 91, head_sha = 'head-reviewed' WHERE task_id = ?`)
    .run(taskId);
  const codeAttemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
    spawnedAt: "2026-05-14T06:00:00.000Z",
  });
  const store = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });
  store.writeArtifact({
    taskId,
    attemptId: codeAttemptId,
    kind: "brief",
    content: "fix the installer",
    extension: "md",
  });
  const reviewAttemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 2,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: "2026-05-14T06:25:00.000Z",
  });
  h.db
    .query(
      `UPDATE attempts
          SET head_sha = 'head-reviewed',
              tmux_session = 'quay-review-ast-120'
        WHERE attempt_id = ?`,
    )
    .run(reviewAttemptId);
  store.writeArtifact({
    taskId,
    attemptId: reviewAttemptId,
    kind: "brief",
    content: "reviewer-only brief; do not edit files",
    extension: "md",
  });
  built.github.setPostedReview(repoId, 91, "head-reviewed", {
    reviewId: "R_approved_red_ci",
    decision: "APPROVED",
    body: "Looks good.",
    comments: "Looks good.",
  });
  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    prNumber: 91,
    state: "open",
    headSha: "head-reviewed",
    baseSha: "base",
    mergeable: "mergeable",
    latestReview: { decision: "APPROVED", latestReviewId: "R_approved_red_ci", comments: "" },
    checks: {
      checkSha: "head-reviewed",
      items: [
        {
          name: "install",
          workflow: "installer-smoke",
          bucket: "fail",
          required: false,
        },
      ],
    },
  });

  const results = await tick_once(built.deps, { reviewerEnabled: true });

  expect(results).toContainEqual({ task_id: taskId, action: "ci_failed" });
  const task = h.db
    .query<{ state: string }, [string]>(`SELECT state FROM tasks WHERE task_id = ?`)
    .get(taskId);
  expect(task?.state).toBe("queued");
  const reviewAttempt = h.db
    .query<{ review_verdict: string | null; review_id: string | null }, [number]>(
      `SELECT review_verdict, review_id FROM attempts WHERE attempt_id = ?`,
    )
    .get(reviewAttemptId);
  expect(reviewAttempt).toEqual({
    review_verdict: "approved",
    review_id: "R_approved_red_ci",
  });
  const latest = h.db
    .query<{ reason: string; consumed_budget: number }, [string]>(
      `SELECT reason, consumed_budget FROM attempts
        WHERE task_id = ? ORDER BY attempt_id DESC LIMIT 1`,
    )
    .get(taskId);
  expect(latest).toEqual({ reason: "ci_fail", consumed_budget: 1 });
  expect(readArtifact("review_comments")).toContain("R_approved_red_ci");
  expect(readArtifact("ci_failure_excerpt")).toContain(
    "installer-smoke/install = fail",
  );
  const retryBrief = readArtifact("brief");
  expect(retryBrief).toContain("fix the installer");
  expect(retryBrief).not.toContain("reviewer-only brief");
});

function readArtifact(kind: string): string {
  if (!h) throw new Error("harness not initialized");
  const row = h.db
    .query<{ file_path: string }, [string]>(
      `SELECT file_path FROM artifacts
        WHERE kind = ?
        ORDER BY artifact_id DESC LIMIT 1`,
    )
    .get(kind);
  if (!row) throw new Error(`artifact ${kind} not found`);
  return readFileSync(row.file_path, "utf8");
}
