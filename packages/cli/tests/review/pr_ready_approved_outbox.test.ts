import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import type { PrCheckBucket, PrSnapshot } from "../../src/ports/github.ts";
import {
  REVIEWER_GH_TOKEN_ENV,
  tick_once,
  type TickOptions,
} from "../../src/core/tick.ts";
import {
  enqueuePrReadyApprovedOutboxItem,
  PR_READY_APPROVED_OUTBOX_KIND,
} from "../../src/core/pr_ready_approved_outbox.ts";
import { listOutboxItems } from "../../src/core/outbox.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { buildTickDeps } from "../support/tick_deps.ts";
import {
  insertAttempt,
  insertRepo,
  insertTask,
  seedTaskObjective,
} from "../support/fixtures.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

const REVIEWER_ENV: NodeJS.ProcessEnv = {
  GH_TOKEN: "ghs_worker_runtime_test",
  [REVIEWER_GH_TOKEN_ENV]: "ghs_reviewer_runtime_test",
};

function reviewerTickOptions(extra: TickOptions = {}): TickOptions {
  return {
    reviewerEnabled: true,
    gateQuayOwnedDone: true,
    env: REVIEWER_ENV,
    ...extra,
  };
}

function writeReviewResult(
  worktreePath: string,
  input: { verdict: "approved" | "changes_requested"; body: string },
): void {
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(
    join(worktreePath, ".quay-review-result.json"),
    JSON.stringify({ ...input, findings: [] }),
  );
}

test("Quay-owned pr-review approval enqueues one pr_ready_approved outbox item", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-ready-approved-direct");
  const taskId = insertTask(h.db, {
    repoId,
    taskId: "task-ready-approved-direct",
    state: "pr-review",
  });
  seedQuayOwnedReviewTask(h, taskId, {
    prNumber: 152,
    prUrl: "https://github.example/repo/pull/152",
    headSha: "head-approved",
    slackThreadRef: "C123:1700000000.000000",
    externalRef: "AST-152",
  });
  const attemptId = insertRunningReviewAttempt(h, taskId, "head-approved");
  built.github.setPrSnapshot(
    repoId,
    `quay/${taskId}`,
    openSnapshot("head-approved", "pass", {
      prNumber: 152,
      prUrl: "https://github.example/repo/pull/152",
    }),
  );
  built.github.setPrView(repoId, 152, {
    number: 152,
    title: "fix: improve ready-approved Slack notification",
    body: "",
    url: "https://github.example/repo/pull/152",
    headRefName: `quay/${taskId}`,
    headSha: "head-approved",
  });
  built.github.setPostedReview(repoId, 152, "head-approved", {
    reviewId: "R_ready",
    decision: "APPROVED",
    body: "Approved.",
    comments: "Approved.",
  });
  writeReviewResult(`${h.dataDir}/worktrees/${taskId}`, {
    verdict: "approved",
    body: "Approved.",
  });

  const results = await tick_once(built.deps, reviewerTickOptions());

  expect(results).toContainEqual({ task_id: taskId, action: "review_approved" });
  const rows = pendingReadyApprovedRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    task_id: taskId,
    kind: PR_READY_APPROVED_OUTBOX_KIND,
    handler_class: "delivery",
    idempotency_key: `${PR_READY_APPROVED_OUTBOX_KIND}:${taskId}:head-approved:R_ready`,
  });
  const payload = JSON.parse(rows[0]!.payload_json!);
  expect(payload).toMatchObject({
    task_id: taskId,
    external_ref: "AST-152",
    repo_id: repoId,
    pr_number: 152,
    pr_url: "https://github.example/repo/pull/152",
    head_sha: "head-approved",
    review_id: "R_ready",
    review_attempt_id: attemptId,
    branch_name: `quay/${taskId}`,
    pr_title: "fix: improve ready-approved Slack notification",
    approval_status: "approved",
  });
  expect(payload).not.toHaveProperty("title");
  expect(JSON.parse(rows[0]!.route_hint_json!)).toEqual({
    slack_thread_ref: "C123:1700000000.000000",
    fallback: "deployment_default_slack_channel",
  });
  expect(sourceEventType(rows[0]!.source_event_id)).toBe("review_approved");

  h.clock.set("2026-01-01T00:06:00.000Z");
  await tick_once(built.deps, reviewerTickOptions());
  expect(pendingReadyApprovedRows()).toHaveLength(1);
});

test("approved before CI pass enqueues when ci_passed later reaches done", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-ready-approved-late-ci");
  const taskId = insertTask(h.db, {
    repoId,
    taskId: "task-ready-approved-late-ci",
    state: "pr-review",
  });
  seedTaskObjective(h, taskId, "Finish AST-152.");
  seedQuayOwnedReviewTask(h, taskId, {
    prNumber: 153,
    prUrl: "https://github.example/repo/pull/153",
    headSha: "head-late-ci",
    slackThreadRef: null,
    externalRef: "AST-152",
  });
  insertRunningReviewAttempt(h, taskId, "head-late-ci");
  built.github.setPrSnapshot(
    repoId,
    `quay/${taskId}`,
    openSnapshot("head-late-ci", "pending", {
      prNumber: 153,
      prUrl: "https://github.example/repo/pull/153",
    }),
  );
  built.github.setPostedReview(repoId, 153, "head-late-ci", {
    reviewId: "R_before_ci",
    decision: "APPROVED",
    body: "Approved while CI is pending.",
    comments: "Approved while CI is pending.",
  });
  writeReviewResult(`${h.dataDir}/worktrees/${taskId}`, {
    verdict: "approved",
    body: "Approved while CI is pending.",
  });

  const pendingResults = await tick_once(built.deps, reviewerTickOptions());

  expect(pendingResults).toContainEqual({ task_id: taskId, action: "ci_pending" });
  expect(
    h.db.query<{ state: string }, [string]>(
      `SELECT state FROM tasks WHERE task_id = ?`,
    ).get(taskId)?.state,
  ).toBe("pr-open");
  expect(pendingReadyApprovedRows()).toHaveLength(0);

  built.github.setPrSnapshot(
    repoId,
    `quay/${taskId}`,
    openSnapshot("head-late-ci", "pass", {
      prNumber: 153,
      prUrl: "https://github.example/repo/pull/153",
    }),
  );
  built.github.setPrView(repoId, 153, {
    number: 153,
    title: "feat: AST-152",
    body: "",
    url: "https://github.example/repo/pull/153",
    headRefName: `quay/${taskId}`,
    headSha: "head-late-ci",
  });

  const readyResults = await tick_once(built.deps, reviewerTickOptions());

  expect(readyResults).toContainEqual({ task_id: taskId, action: "ci_passed" });
  const rows = pendingReadyApprovedRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    task_id: taskId,
    kind: PR_READY_APPROVED_OUTBOX_KIND,
    idempotency_key: `${PR_READY_APPROVED_OUTBOX_KIND}:${taskId}:head-late-ci:R_before_ci`,
  });
  expect(JSON.parse(rows[0]!.route_hint_json!)).toEqual({
    slack_thread_ref: null,
    fallback: "deployment_default_slack_channel",
  });
  expect(JSON.parse(rows[0]!.payload_json!)).toMatchObject({
    pr_title: "feat: AST-152",
    approval_status: "approved",
  });
  expect(sourceEventType(rows[0]!.source_event_id)).toBe("ci_passed");
});

test("later approval for a new head_sha is marked reapproved", () => {
  h = createHarness();
  const repoId = insertRepo(h.db, "repo-ready-approved-reapproval");
  const taskId = insertTask(h.db, {
    repoId,
    taskId: "task-ready-approved-reapproval",
    state: "done",
  });
  seedQuayOwnedReviewTask(h, taskId, {
    prNumber: 155,
    prUrl: "https://github.example/repo/pull/155",
    headSha: "head-first",
    slackThreadRef: null,
    externalRef: "AST-155",
  });
  const firstAttempt = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: h.clock.nowISO(),
  });
  h.db
    .query(
      `UPDATE attempts
          SET head_sha = 'head-first',
              ended_at = ?,
              review_verdict = 'approved',
              review_id = 'R_first'
        WHERE attempt_id = ?`,
    )
    .run("2026-01-01T00:00:00.000Z", firstAttempt);

  expect(
    enqueuePrReadyApprovedOutboxItem(
      { db: h.db, clock: h.clock },
      { taskId },
    ),
  ).not.toBeNull();

  seedQuayOwnedReviewTask(h, taskId, {
    prNumber: 155,
    prUrl: "https://github.example/repo/pull/155",
    headSha: "head-second",
    slackThreadRef: null,
    externalRef: "AST-155",
  });
  const secondAttempt = insertAttempt(h.db, {
    taskId,
    attemptNumber: 2,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: h.clock.nowISO(),
  });
  h.db
    .query(
      `UPDATE attempts
          SET head_sha = 'head-second',
              ended_at = ?,
              review_verdict = 'approved',
              review_id = 'R_second'
        WHERE attempt_id = ?`,
    )
    .run("2026-01-01T00:01:00.000Z", secondAttempt);

  expect(
    enqueuePrReadyApprovedOutboxItem(
      { db: h.db, clock: h.clock },
      { taskId },
    ),
  ).not.toBeNull();

  const payloads = pendingReadyApprovedRows().map((row) =>
    JSON.parse(row.payload_json!),
  );
  expect(payloads).toHaveLength(2);
  expect(payloads.map((payload) => payload.approval_status)).toEqual([
    "approved",
    "reapproved",
  ]);
});

test("latest current-head review verdict must be approved", () => {
  h = createHarness();
  const repoId = insertRepo(h.db, "repo-ready-approved-latest");
  const taskId = insertTask(h.db, {
    repoId,
    taskId: "task-ready-approved-latest",
    state: "done",
  });
  seedQuayOwnedReviewTask(h, taskId, {
    prNumber: 154,
    prUrl: "https://github.example/repo/pull/154",
    headSha: "head-latest",
    slackThreadRef: "C123:1700000000.000000",
    externalRef: "AST-152",
  });
  const approvedAttempt = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: h.clock.nowISO(),
  });
  const changesAttempt = insertAttempt(h.db, {
    taskId,
    attemptNumber: 2,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: h.clock.nowISO(),
  });
  h.db
    .query(
      `UPDATE attempts
          SET head_sha = 'head-latest',
              ended_at = ?,
              review_verdict = 'approved',
              review_id = 'R_old_approved'
        WHERE attempt_id = ?`,
    )
    .run("2026-01-01T00:00:00.000Z", approvedAttempt);
  h.db
    .query(
      `UPDATE attempts
          SET head_sha = 'head-latest',
              ended_at = ?,
              review_verdict = 'changes_requested',
              review_id = 'R_new_changes'
        WHERE attempt_id = ?`,
    )
    .run("2026-01-01T00:01:00.000Z", changesAttempt);

  const outboxItemId = enqueuePrReadyApprovedOutboxItem(
    { db: h.db, clock: h.clock },
    { taskId },
  );

  expect(outboxItemId).toBeNull();
  expect(pendingReadyApprovedRows()).toHaveLength(0);
});

function seedQuayOwnedReviewTask(
  h: Harness,
  taskId: string,
  input: {
    prNumber: number;
    prUrl: string;
    headSha: string;
    slackThreadRef: string | null;
    externalRef: string;
  },
): void {
  const worktreePath = `${h.dataDir}/worktrees/${taskId}`;
  mkdirSync(worktreePath, { recursive: true });
  h.db
    .query(
      `UPDATE tasks
          SET pr_number = ?,
              pr_url = ?,
              head_sha = ?,
              slack_thread_ref = ?,
              external_ref = ?,
              worktree_path = ?
        WHERE task_id = ?`,
    )
    .run(
      input.prNumber,
      input.prUrl,
      input.headSha,
      input.slackThreadRef,
      input.externalRef,
      worktreePath,
      taskId,
    );
}

function insertRunningReviewAttempt(
  h: Harness,
  taskId: string,
  headSha: string,
): number {
  const attemptId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: h.clock.nowISO(),
  });
  h.db
    .query(
      `UPDATE attempts
          SET head_sha = ?,
              tmux_session = ?
        WHERE attempt_id = ?`,
    )
    .run(headSha, `quay-review-${taskId}`, attemptId);
  return attemptId;
}

function openSnapshot(
  headSha: string,
  checkBucket: PrCheckBucket,
  input: { prNumber: number; prUrl: string },
): PrSnapshot {
  return {
    prNumber: input.prNumber,
    prUrl: input.prUrl,
    state: "open",
    headSha,
    baseSha: "base-sha",
    mergeable: "mergeable",
    latestReview: {
      decision: checkBucket === "pass" ? "APPROVED" : "NONE",
      latestReviewId: checkBucket === "pass" ? "R_latest" : null,
      comments: "",
    },
    checks: {
      checkSha: headSha,
      items: [
        { name: "build", workflow: null, bucket: checkBucket, required: true },
      ],
    },
  };
}

function pendingReadyApprovedRows() {
  if (h === null) throw new Error("harness not initialized");
  return listOutboxItems(h.db, {
    status: "pending",
    kind: PR_READY_APPROVED_OUTBOX_KIND,
    eligibleAtOrBefore: h.clock.nowISO(),
    includeIneligible: true,
  });
}

function sourceEventType(sourceEventId: number | null): string | null {
  if (h === null) throw new Error("harness not initialized");
  if (sourceEventId === null) return null;
  return (
    h.db
      .query<{ event_type: string }, [number]>(
        `SELECT event_type FROM events WHERE event_id = ?`,
      )
      .get(sourceEventId)?.event_type ?? null
  );
}
