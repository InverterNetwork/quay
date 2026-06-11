import { createHash } from "node:crypto";
import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";
import type { LinearPort } from "../ports/linear.ts";
import { QuayError } from "./errors.ts";
import {
  claimOutboxItem,
  completeOutboxItem,
  enqueueOutboxItem,
  failOutboxItem,
  type CompleteOutboxItemResult,
  type OutboxItemRow,
} from "./outbox.ts";

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

export async function processReviewFindingLinearIssueOutboxItem(
  deps: { db: DB; clock: Clock; linear: LinearPort },
  input: { outboxItemId: number },
): Promise<CompleteOutboxItemResult> {
  const claimed = claimOutboxItem(deps, { outboxItemId: input.outboxItemId });
  if (!claimed.ok) throw new Error(claimed.error.message);
  const row = loadOutboxItem(deps.db, input.outboxItemId);
  if (row === null) throw new Error(`outbox item ${input.outboxItemId} disappeared`);

  try {
    await deliverClaimedReviewFindingLinearIssue(deps, row);
    const completed = completeOutboxItem(deps, {
      outboxItemId: row.outbox_item_id,
      claimId: claimed.value.claim_id,
    });
    if (!completed.ok) throw new Error(completed.error.message);
    return completed.value;
  } catch (err) {
    const failed = failOutboxItem(deps, {
      outboxItemId: row.outbox_item_id,
      claimId: claimed.value.claim_id,
      lastError: err instanceof Error ? err.message : String(err),
      nextEligibleAt: nextEligibleAtFromError(deps.clock, err),
    });
    if (!failed.ok) throw new Error(failed.error.message);
    throw err;
  }
}

function nextEligibleAtFromError(clock: Clock, err: unknown): string | null {
  if (!(err instanceof QuayError)) return null;
  if (err.code !== "adapter_error") return null;
  const retryAfter = err.details?.retry_after;
  if (
    typeof retryAfter !== "number" ||
    !Number.isFinite(retryAfter) ||
    retryAfter <= 0
  ) {
    return null;
  }
  const now = Date.parse(clock.nowISO());
  if (!Number.isFinite(now)) return null;
  return new Date(now + retryAfter * 1000).toISOString();
}

async function deliverClaimedReviewFindingLinearIssue(
  deps: { db: DB; clock: Clock; linear: LinearPort },
  row: OutboxItemRow,
): Promise<void> {
  if (row.kind !== REVIEW_FINDING_LINEAR_ISSUE_OUTBOX_KIND) {
    throw new Error(`unsupported outbox kind ${row.kind}`);
  }
  const payload = parsePayload(row.payload_json);
  const finding = loadCurrentFinding(deps.db, payload);
  if (finding === null) return;
  const existing = loadExternalLink(
    deps.db,
    finding.task_id,
    finding.review_id,
    finding.fingerprint,
  );
  if (existing !== null && existing.provider_url !== "") {
    deps.db
      .query(
        `UPDATE review_finding_external_links
            SET finding_id = ?,
                outbox_item_id = COALESCE(outbox_item_id, ?),
                updated_at = ?
          WHERE link_id = ?`,
      )
      .run(finding.finding_id, row.outbox_item_id, deps.clock.nowISO(), existing.link_id);
    return;
  }

  const locations = loadLocations(deps.db, finding.finding_id);
  const created = await deps.linear.createIssue({
    title: finding.title,
    body: renderLinearIssueBody(finding, locations),
    idempotencyKey: linearIssueProviderIdempotencyKey(finding),
  });
  const now = deps.clock.nowISO();
  deps.db
    .query(
      `INSERT INTO review_finding_external_links (
         finding_id, task_id, review_id, fingerprint, provider,
         provider_external_id, provider_url, outbox_item_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'linear', ?, ?, ?, ?, ?)
       ON CONFLICT(provider, task_id, review_id, fingerprint) DO UPDATE SET
         finding_id = excluded.finding_id,
         provider_external_id = excluded.provider_external_id,
         provider_url = excluded.provider_url,
         outbox_item_id = excluded.outbox_item_id,
         updated_at = excluded.updated_at`,
    )
    .run(
      finding.finding_id,
      finding.task_id,
      finding.review_id,
      finding.fingerprint,
      created.id,
      created.url,
      row.outbox_item_id,
      now,
      now,
    );
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
          AND t.authoring_mode IN ('synthetic_review', 'adopted_external_pr')
        ORDER BY f.ordinal`,
    )
    .all(taskId, attemptId, reviewId);
}

function loadCurrentFinding(
  db: DB,
  payload: {
    finding_id: number;
    task_id: string;
    review_id: string;
    fingerprint: string;
  },
): ReviewFindingOutboxRow | null {
  return (
    db
      .query<ReviewFindingOutboxRow, [string, string, string]>(
        `SELECT f.finding_id, f.task_id, f.review_id, f.head_sha, f.severity,
                f.title, f.body_markdown, f.principle_text, f.fingerprint,
                t.repo_id, t.authoring_mode, t.pr_number, t.pr_url
           FROM review_findings f
           JOIN tasks t ON t.task_id = f.task_id
          WHERE f.task_id = ?
            AND f.review_id = ?
            AND f.fingerprint = ?
            AND f.severity = 'non_blocking'
            AND t.authoring_mode IN ('synthetic_review', 'adopted_external_pr')
          ORDER BY f.finding_id DESC
          LIMIT 1`,
      )
      .get(payload.task_id, payload.review_id, payload.fingerprint) ?? null
  );
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

function loadOutboxItem(db: DB, outboxItemId: number): OutboxItemRow | null {
  return (
    db
      .query<OutboxItemRow, [number]>(
        `SELECT outbox_item_id, task_id, kind, handler_class, source_event_id,
                idempotency_key, payload_json, route_hint_json, status, claim_id,
                claimed_at, delivered_at, completed_at, last_error,
                next_eligible_at, created_at, updated_at
           FROM outbox_items
          WHERE outbox_item_id = ?`,
      )
      .get(outboxItemId) ?? null
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

function linearIssueProviderIdempotencyKey(finding: ReviewFindingOutboxRow): string {
  return stableUuid([
    REVIEW_FINDING_LINEAR_ISSUE_OUTBOX_KIND,
    finding.task_id,
    finding.review_id,
    finding.fingerprint,
  ].join(":"));
}

function stableUuid(source: string): string {
  const bytes = createHash("sha256").update(source).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function renderLinearIssueBody(
  finding: ReviewFindingOutboxRow,
  locations: ReviewFindingLocationRow[],
): string {
  const lines = [
    finding.body_markdown,
    "",
    "## Quay Review Finding",
    `- Task: ${finding.task_id}`,
    `- Review: ${finding.review_id}`,
    `- Head SHA: ${finding.head_sha}`,
  ];
  if (finding.pr_url !== null) lines.push(`- PR: ${finding.pr_url}`);
  else if (finding.pr_number !== null) lines.push(`- PR number: ${finding.pr_number}`);
  if (finding.principle_text !== null) {
    lines.push("", "## quay-principle", finding.principle_text);
  }
  if (locations.length > 0) {
    lines.push("", "## Locations");
    for (const location of locations) {
      const locus = [
        location.path,
        formatLineRange(location.start_line, location.end_line),
      ].filter((part) => part !== null && part !== "").join(":");
      lines.push(`- ${locus === "" ? "(review body)" : locus}`);
      if (location.url !== null) lines.push(`  ${location.url}`);
    }
  }
  return lines.join("\n");
}

function formatLineRange(start: number | null, end: number | null): string | null {
  if (start === null && end === null) return null;
  if (start !== null && end !== null && start !== end) return `${start}-${end}`;
  return String(start ?? end);
}

function parsePayload(payloadJson: string | null): {
  finding_id: number;
  task_id: string;
  review_id: string;
  fingerprint: string;
} {
  if (payloadJson === null) throw new Error("review finding outbox payload is empty");
  const parsed = JSON.parse(payloadJson) as Record<string, unknown>;
  const findingId = parsed.finding_id;
  const taskId = parsed.task_id;
  const reviewId = parsed.review_id;
  const fingerprint = parsed.fingerprint;
  if (
    typeof findingId !== "number" ||
    typeof taskId !== "string" ||
    typeof reviewId !== "string" ||
    typeof fingerprint !== "string"
  ) {
    throw new Error("review finding outbox payload is malformed");
  }
  return { finding_id: findingId, task_id: taskId, review_id: reviewId, fingerprint };
}
