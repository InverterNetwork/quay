import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { createArtifactStore } from "../../src/artifacts/store.ts";
import { REVIEWER_GH_TOKEN_ENV, tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo, insertTask, seedTaskObjective } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

const REVIEWER_OPTIONS = {
  reviewerEnabled: true,
  env: {
    [REVIEWER_GH_TOKEN_ENV]: "ghs_reviewer_runtime_test",
  },
};

function writeReviewResult(
  taskId: string,
  input: { verdict: "approved" | "changes_requested"; body: string },
): void {
  const worktreePath = `/tmp/${taskId}`;
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(
    join(worktreePath, ".quay-review-result.json"),
    JSON.stringify({ ...input, findings: [] }),
  );
}

function markedReviewBody(input: {
  body: string;
  taskId: string;
  attemptId: number;
  headSha: string;
}): string {
  return `${input.body.trimEnd()}\n\n<!-- quay-review-result task_id=${input.taskId} attempt_id=${input.attemptId} head_sha=${input.headSha} -->`;
}

test("AST-120: non-required failing check blocks pr-review and schedules ci_fail", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-ast-120-open");
  const taskId = insertTask(h.db, {
    taskId: "task-ast-120-open",
    repoId,
    state: "pr-open",
  });
  seedTaskObjective(h, taskId);
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

test("global ignored failing check allows otherwise green product CI", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-ci-ignore-global");
  const taskId = insertTask(h.db, {
    taskId: "task-ci-ignore-global",
    repoId,
    state: "pr-open",
  });
  seedTaskObjective(h, taskId);
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-05-14T06:20:00.000Z",
  });

  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    prNumber: 92,
    state: "open",
    headSha: "head-green-with-review-failure",
    baseSha: "base",
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "head-green-with-review-failure",
      items: [
        { name: "build", workflow: "ci", bucket: "pass", required: true },
        { name: "FE PR Review", workflow: "review", bucket: "fail", required: false },
      ],
    },
  });

  const results = await tick_once(built.deps, {
    reviewerEnabled: false,
    gateQuayOwnedDone: false,
    ciIgnorePolicy: {
      ignoredCheckNames: ["FE PR Review"],
      ignoredWorkflowNames: [],
    },
  });

  expect(results).toEqual([{ task_id: taskId, action: "ci_passed" }]);
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
  seedTaskObjective(h, taskId);
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
    body: markedReviewBody({
      body: "Looks good.",
      taskId,
      attemptId: reviewAttemptId,
      headSha: "head-reviewed",
    }),
    comments: markedReviewBody({
      body: "Looks good.",
      taskId,
      attemptId: reviewAttemptId,
      headSha: "head-reviewed",
    }),
  });
  writeReviewResult(taskId, { verdict: "approved", body: "Looks good." });
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

  const results = await tick_once(built.deps, REVIEWER_OPTIONS);

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
  // The shared composer pulls the stable task objective into every retry and
  // never inherits the reviewer-only brief.
  expect(retryBrief).toContain("Original task objective.");
  expect(retryBrief).not.toContain("reviewer-only brief");
});

test("AST-120: stale approved review on red new head schedules ci_fail", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-ast-120-stale-red");
  const taskId = insertTask(h.db, {
    taskId: "task-ast-120-stale-red",
    repoId,
    state: "pr-review",
  });
  seedTaskObjective(h, taskId);
  h.db
    .query(`UPDATE tasks SET pr_number = 92, head_sha = 'old-head' WHERE task_id = ?`)
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
    content: "fix red CI on the current head",
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
          SET head_sha = 'old-head',
              tmux_session = 'quay-review-stale-red'
        WHERE attempt_id = ?`,
    )
    .run(reviewAttemptId);
  built.github.setPostedReview(repoId, 92, "old-head", {
    reviewId: "R_stale_red",
    decision: "APPROVED",
    body: "Old head looked good.",
    comments: "Old head looked good.",
  });
  writeReviewResult(taskId, {
    verdict: "approved",
    body: "Old head looked good.",
  });
  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    prNumber: 92,
    state: "open",
    headSha: "new-red-head",
    baseSha: "base",
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "new-red-head",
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

  const results = await tick_once(built.deps, REVIEWER_OPTIONS);

  expect(results).toContainEqual({ task_id: taskId, action: "ci_failed" });
  const oldReview = h.db
    .query<{ ended_at: string | null; review_verdict: string | null }, [number]>(
      `SELECT ended_at, review_verdict FROM attempts WHERE attempt_id = ?`,
    )
    .get(reviewAttemptId);
  expect(oldReview?.ended_at).not.toBeNull();
  expect(oldReview?.review_verdict).toBe("superseded");
  const latest = h.db
    .query<{ reason: string; consumed_budget: number }, [string]>(
      `SELECT reason, consumed_budget FROM attempts
        WHERE task_id = ? ORDER BY attempt_id DESC LIMIT 1`,
    )
    .get(taskId);
  expect(latest).toEqual({ reason: "ci_fail", consumed_budget: 1 });
  expect(countActiveReviewAttempts(taskId)).toBe(0);
});

test("AST-120: stale approved review on green new head schedules fresh review", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-ast-120-stale-green");
  const taskId = insertTask(h.db, {
    taskId: "task-ast-120-stale-green",
    repoId,
    state: "pr-review",
  });
  seedTaskObjective(h, taskId);
  h.db
    .query(`UPDATE tasks SET pr_number = 93, head_sha = 'old-head' WHERE task_id = ?`)
    .run(taskId);
  const codeAttemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
    spawnedAt: "2026-05-14T06:00:00.000Z",
  });
  createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  }).writeArtifact({
    taskId,
    attemptId: codeAttemptId,
    kind: "brief",
    content: "review the current head",
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
          SET head_sha = 'old-head',
              tmux_session = 'quay-review-stale-green'
        WHERE attempt_id = ?`,
    )
    .run(reviewAttemptId);
  built.github.setPostedReview(repoId, 93, "old-head", {
    reviewId: "R_stale_green",
    decision: "APPROVED",
    body: "Old head looked good.",
    comments: "Old head looked good.",
  });
  writeReviewResult(taskId, {
    verdict: "approved",
    body: "Old head looked good.",
  });
  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    prNumber: 93,
    state: "open",
    headSha: "new-green-head",
    baseSha: "base",
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "new-green-head",
      items: [{ name: "build", workflow: "ci", bucket: "pass", required: true }],
    },
  });
  built.github.setPrView(repoId, 93, {
    number: 93,
    title: "New green head",
    body: "",
    url: "https://example.test/pr/93",
    headRefName: `quay/${taskId}`,
    headSha: "new-green-head",
  });

  const results = await tick_once(built.deps, REVIEWER_OPTIONS);

  expect(results).toContainEqual({ task_id: taskId, action: "review_requested" });
  const oldReview = h.db
    .query<{ ended_at: string | null; review_verdict: string | null }, [number]>(
      `SELECT ended_at, review_verdict FROM attempts WHERE attempt_id = ?`,
    )
    .get(reviewAttemptId);
  expect(oldReview?.ended_at).not.toBeNull();
  expect(oldReview?.review_verdict).toBe("superseded");
  const freshReview = h.db
    .query<{ reason: string; head_sha: string | null; spawned_at: string | null }, [string]>(
      `SELECT reason, head_sha, spawned_at FROM attempts
        WHERE task_id = ? ORDER BY attempt_id DESC LIMIT 1`,
    )
    .get(taskId);
  expect(freshReview).toEqual({
    reason: "review_only",
    head_sha: "new-green-head",
    spawned_at: null,
  });
});

test("AST-120: approved review waiting on pending CI frees reviewer capacity", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-ast-120-pending");
  const taskId = insertTask(h.db, {
    taskId: "task-ast-120-pending",
    repoId,
    state: "pr-review",
  });
  seedTaskObjective(h, taskId);
  h.db
    .query(`UPDATE tasks SET pr_number = 94, head_sha = 'head-pending' WHERE task_id = ?`)
    .run(taskId);
  const attemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: "2026-05-14T06:25:00.000Z",
  });
  h.db
    .query(
      `UPDATE attempts
          SET head_sha = 'head-pending',
              tmux_session = 'quay-review-pending'
        WHERE attempt_id = ?`,
    )
    .run(attemptId);
  built.github.setPostedReview(repoId, 94, "head-pending", {
    reviewId: "R_pending",
    decision: "APPROVED",
    body: "Looks good.",
    comments: "Looks good.",
  });
  writeReviewResult(taskId, { verdict: "approved", body: "Looks good." });
  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    prNumber: 94,
    state: "open",
    headSha: "head-pending",
    baseSha: "base",
    mergeable: "mergeable",
    latestReview: { decision: "APPROVED", latestReviewId: "R_pending", comments: "" },
    checks: {
      checkSha: "head-pending",
      items: [{ name: "build", workflow: "ci", bucket: "pending", required: true }],
    },
  });
  built.github.setPrView(repoId, 94, {
    number: 94,
    title: "Pending CI",
    body: "",
    url: "https://example.test/pr/94",
    headRefName: `quay/${taskId}`,
    headSha: "head-pending",
  });

  const first = await tick_once(built.deps, REVIEWER_OPTIONS);

  expect(first).toContainEqual({ task_id: taskId, action: "ci_pending" });
  expect(countActiveReviewAttempts(taskId)).toBe(0);
  let task = h.db
    .query<{ state: string }, [string]>(`SELECT state FROM tasks WHERE task_id = ?`)
    .get(taskId);
  expect(task?.state).toBe("pr-open");

  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    prNumber: 94,
    state: "open",
    headSha: "head-pending",
    baseSha: "base",
    mergeable: "mergeable",
    latestReview: { decision: "APPROVED", latestReviewId: "R_pending", comments: "" },
    checks: {
      checkSha: "head-pending",
      items: [{ name: "build", workflow: "ci", bucket: "pass", required: true }],
    },
  });

  const second = await tick_once(built.deps, {
    reviewerEnabled: true,
    gateQuayOwnedDone: true,
  });

  expect(second).toContainEqual({ task_id: taskId, action: "ci_passed" });
  task = h.db
    .query<{ state: string }, [string]>(`SELECT state FROM tasks WHERE task_id = ?`)
    .get(taskId);
  expect(task?.state).toBe("done");
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

function countActiveReviewAttempts(taskId: string): number {
  if (!h) throw new Error("harness not initialized");
  const row = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM attempts
        WHERE task_id = ?
          AND reason = 'review_only'
          AND spawned_at IS NOT NULL
          AND ended_at IS NULL`,
    )
    .get(taskId);
  return row?.n ?? 0;
}
