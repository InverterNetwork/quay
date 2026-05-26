import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";
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
    payload: {
      task_id: task.task_id,
      external_ref: task.external_ref,
      repo_id: task.repo_id,
      pr_number: task.pr_number,
      pr_url: task.pr_url,
      head_sha: task.head_sha,
      review_id: review.review_id,
      review_attempt_id: review.attempt_id,
      branch_name: task.branch_name,
    },
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
