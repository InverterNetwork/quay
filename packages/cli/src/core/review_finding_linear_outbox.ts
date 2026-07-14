import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";
import { enqueueOutboxItem } from "./outbox.ts";

export const REVIEW_FINDING_LINEAR_ISSUE_OUTBOX_KIND =
  "delivery.review_finding_linear_issue";

interface ReviewFindingOutboxRow {
  finding_id: number;
  task_id: string;
  review_id: string;
  head_sha: string;
  severity: string;
  title: string;
  body_markdown: string;
  principle_text: string | null;
  fingerprint: string;
  repo_id: string;
  authoring_mode: string;
  pr_number: number | null;
  pr_url: string | null;
}

interface ReviewFindingLocationRow {
  path: string | null;
  start_line: number | null;
  end_line: number | null;
  url: string | null;
}

export function enqueueReviewFindingLinearIssuesInOpenTxn(
  deps: { db: DB; clock: Clock },
  input: {
    taskId: string;
    attemptId: number;
    reviewId: string;
  },
): number[] {
  const findings = loadEligibleFindings(
    deps.db,
    input.taskId,
    input.attemptId,
    input.reviewId,
  );
  const outboxIds: number[] = [];

  for (const finding of findings) {
    const existing = loadExternalLink(
      deps.db,
      finding.task_id,
      finding.review_id,
      finding.fingerprint,
    );
    if (existing !== null) {
      deps.db
        .query(
          `UPDATE review_finding_external_links
              SET finding_id = ?,
                  updated_at = ?
            WHERE link_id = ?`,
        )
        .run(finding.finding_id, deps.clock.nowISO(), existing.link_id);
      continue;
    }

    const locations = loadLocations(deps.db, finding.finding_id);
    const outboxId = enqueueOutboxItem(deps, {
      taskId: finding.task_id,
      kind: REVIEW_FINDING_LINEAR_ISSUE_OUTBOX_KIND,
      handlerClass: "delivery",
      idempotencyKey: linearIssueOutboxIdempotencyKey(finding),
      payload: {
        finding_id: finding.finding_id,
        task_id: finding.task_id,
        review_id: finding.review_id,
        head_sha: finding.head_sha,
        fingerprint: finding.fingerprint,
        title: finding.title,
        body_markdown: finding.body_markdown,
        principle_text: finding.principle_text,
        repo_id: finding.repo_id,
        pr_number: finding.pr_number,
        pr_url: finding.pr_url,
        locations,
      },
      routeHint: { provider: "linear" },
    });
    outboxIds.push(outboxId);
  }

  return outboxIds;
}

function loadEligibleFindings(
  db: DB,
  taskId: string,
  attemptId: number,
  reviewId: string,
): ReviewFindingOutboxRow[] {
  return db
    .query<ReviewFindingOutboxRow, [string, number, string]>(
      `SELECT f.finding_id, f.task_id, f.review_id, f.head_sha, f.severity,
              f.title, f.body_markdown, f.principle_text, f.fingerprint,
              t.repo_id, t.authoring_mode, t.pr_number, t.pr_url
         FROM review_findings f
         JOIN tasks t ON t.task_id = f.task_id
        WHERE f.task_id = ?
          AND f.attempt_id = ?
          AND f.review_id = ?
          AND f.severity = 'non_blocking'
          AND t.authoring_mode = 'synthetic_review'
        ORDER BY f.ordinal`,
    )
    .all(taskId, attemptId, reviewId);
}

function loadLocations(db: DB, findingId: number): ReviewFindingLocationRow[] {
  return db
    .query<ReviewFindingLocationRow, [number]>(
      `SELECT path, start_line, end_line, url
         FROM review_finding_locations
        WHERE finding_id = ?
        ORDER BY ordinal`,
    )
    .all(findingId);
}

function loadExternalLink(
  db: DB,
  taskId: string,
  reviewId: string,
  fingerprint: string,
): {
  link_id: number;
  provider_url: string;
} | null {
  return (
    db
      .query<{ link_id: number; provider_url: string }, [string, string, string]>(
        `SELECT link_id, provider_url
           FROM review_finding_external_links
          WHERE provider = 'linear'
            AND task_id = ?
            AND review_id = ?
            AND fingerprint = ?`,
      )
      .get(taskId, reviewId, fingerprint) ?? null
  );
}

function linearIssueOutboxIdempotencyKey(finding: ReviewFindingOutboxRow): string {
  return [
    REVIEW_FINDING_LINEAR_ISSUE_OUTBOX_KIND,
    finding.task_id,
    finding.review_id,
    finding.fingerprint,
  ].join(":");
}
