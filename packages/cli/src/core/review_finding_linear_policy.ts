// Resolves whether a repo's non-blocking review findings should be filed as
// Linear issues (BRIX-1898), and gates the enqueue accordingly.
//
// Precedence: per-repo override (repos.review_finding_linear_enabled) wins when
// set; otherwise the deployment default (deployment_settings.
// review_finding_linear_enabled); otherwise ON. Both columns are nullable
// INTEGER tri-states (NULL/0/1) where NULL means "inherit / unset".
//
// The gate lives at enqueue time only. When resolved off we skip placing the
// `review_finding_linear_issue` outbox row; the findings themselves are still
// persisted and still surface in the PR review. Only `synthetic_review` tasks
// reach the enqueue path (see enqueueReviewFindingLinearIssuesInOpenTxn), so
// worker-authored `quay_owned` tasks are unaffected regardless of the switch.

import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";
import { enqueueReviewFindingLinearIssuesInOpenTxn } from "./review_finding_linear_outbox.ts";

interface ToggleRow {
  review_finding_linear_enabled: number | null;
}

export function resolveReviewFindingLinearEnabled(db: DB, repoId: string): boolean {
  const repoRow =
    db
      .query<ToggleRow, [string]>(
        `SELECT review_finding_linear_enabled FROM repos WHERE repo_id = ?`,
      )
      .get(repoId) ?? null;
  if (repoRow !== null && repoRow.review_finding_linear_enabled !== null) {
    return repoRow.review_finding_linear_enabled !== 0;
  }

  const globalRow =
    db
      .query<ToggleRow, []>(
        `SELECT review_finding_linear_enabled
           FROM deployment_settings
          WHERE singleton_id = 1`,
      )
      .get() ?? null;
  if (globalRow !== null && globalRow.review_finding_linear_enabled !== null) {
    return globalRow.review_finding_linear_enabled !== 0;
  }

  // Unset at both scopes resolves to ON, preserving the current behavior.
  return true;
}

// Enqueue gate used by tick's review-finding persistence. Delegates to the
// pure enqueue when the resolved value is on; skips it (no outbox row) when
// off. Returns the enqueued outbox ids (empty when gated off).
export function enqueueReviewFindingLinearIssuesIfEnabledInOpenTxn(
  deps: { db: DB; clock: Clock },
  input: {
    taskId: string;
    attemptId: number;
    reviewId: string;
    repoId: string;
  },
): number[] {
  if (!resolveReviewFindingLinearEnabled(deps.db, input.repoId)) return [];
  return enqueueReviewFindingLinearIssuesInOpenTxn(deps, {
    taskId: input.taskId,
    attemptId: input.attemptId,
    reviewId: input.reviewId,
  });
}
