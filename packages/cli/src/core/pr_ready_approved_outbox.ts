import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";
import type { GitHubPort } from "../ports/github.ts";
import { enqueueOutboxItem } from "./outbox.ts";

export const PR_READY_APPROVED_OUTBOX_KIND = "pr_ready_approved";

interface PrReadyApprovedTaskRow {
  task_id: string;
  repo_id: string;
  external_ref: string | null;
  authoring_mode: string;
  branch_name: string;
  pr_number: number | null;
  pr_url: string | null;
  head_sha: string | null;
  slack_thread_ref: string | null;
}

interface ApprovedReviewAttemptRow {
  attempt_id: number;
  review_verdict: string | null;
  review_id: string;
}

export interface PrReadyApprovedOutboxDeps {
  db: DB;
  clock: Clock;
  github?: GitHubPort;
}

export interface EnqueuePrReadyApprovedInput {
  taskId: string;
  sourceEventId?: number | null;
}

export function enqueuePrReadyApprovedOutboxItem(
  deps: PrReadyApprovedOutboxDeps,
  input: EnqueuePrReadyApprovedInput,
): number | null {
  const task = loadEligibleTask(deps.db, input.taskId);
  if (task === null || task.head_sha === null) return null;

  const review = loadLatestReviewAttempt(
    deps.db,
    task.task_id,
    task.head_sha,
  );
  if (review === null || review.review_verdict !== "approved") return null;

  const prTitle = loadPrTitle(deps, task);
  const approvalStatus = hasPriorReadyApprovedEmission(
    deps.db,
    task,
  )
    ? "reapproved"
    : "approved";

  const payload: Record<string, unknown> = {
    task_id: task.task_id,
    external_ref: task.external_ref,
    repo_id: task.repo_id,
    pr_number: task.pr_number,
    pr_url: task.pr_url,
    head_sha: task.head_sha,
    review_id: review.review_id,
    review_attempt_id: review.attempt_id,
    branch_name: task.branch_name,
    approval_status: approvalStatus,
  };
  if (prTitle !== null) payload.pr_title = prTitle;

  return enqueueOutboxItem(deps, {
    taskId: task.task_id,
    kind: PR_READY_APPROVED_OUTBOX_KIND,
    handlerClass: "delivery",
    sourceEventId: input.sourceEventId ?? null,
    idempotencyKey: [
      PR_READY_APPROVED_OUTBOX_KIND,
      task.task_id,
      task.head_sha,
      review.review_id,
    ].join(":"),
    payload,
    routeHint: {
      slack_thread_ref: task.slack_thread_ref,
      fallback: "deployment_default_slack_channel",
    },
  });
}

function loadEligibleTask(db: DB, taskId: string): PrReadyApprovedTaskRow | null {
  const row =
    db
      .query<PrReadyApprovedTaskRow, [string]>(
        `SELECT task_id, repo_id, external_ref, authoring_mode, branch_name,
                pr_number, pr_url, head_sha, slack_thread_ref
           FROM tasks
          WHERE task_id = ?
            AND state = 'done'
            AND authoring_mode = 'quay_owned'
            AND task_id NOT LIKE 'pr-review-%'`,
      )
      .get(taskId) ?? null;
  return row;
}

function loadLatestReviewAttempt(
  db: DB,
  taskId: string,
  headSha: string,
): ApprovedReviewAttemptRow | null {
  return (
    db
      .query<ApprovedReviewAttemptRow, [string, string]>(
        `SELECT attempt_id, review_verdict, review_id
           FROM attempts
          WHERE task_id = ?
            AND reason = 'review_only'
            AND review_id IS NOT NULL
            AND head_sha = ?
          ORDER BY ended_at DESC, attempt_id DESC
          LIMIT 1`,
      )
      .get(taskId, headSha) ?? null
  );
}

function loadPrTitle(
  deps: PrReadyApprovedOutboxDeps,
  task: PrReadyApprovedTaskRow,
): string | null {
  if (deps.github === undefined || task.pr_number === null) return null;
  try {
    const pr = deps.github.prView(task.repo_id, task.pr_number);
    if (pr === null) return null;
    return pr.title;
  } catch {
    return null;
  }
}

function hasPriorReadyApprovedEmission(
  db: DB,
  task: PrReadyApprovedTaskRow,
): boolean {
  const rows = db
    .query<{ payload_json: string | null }, [string, string]>(
      `SELECT payload_json
         FROM outbox_items
        WHERE task_id = ?
          AND kind = ?`,
    )
    .all(task.task_id, PR_READY_APPROVED_OUTBOX_KIND);

  for (const row of rows) {
    if (row.payload_json === null) continue;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (payload.head_sha === task.head_sha) continue;
    if (
      task.pr_number !== null &&
      typeof payload.pr_number === "number" &&
      payload.pr_number !== task.pr_number
    ) {
      continue;
    }
    return true;
  }
  return false;
}
