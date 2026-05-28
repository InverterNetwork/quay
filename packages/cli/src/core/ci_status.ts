// CI status classifier (spec §5 "CI status rules"). Pure function over a
// `PrSnapshot`.
//
// Returns `"stale"` when the SHA the checks were run against doesn't match
// the PR's current head SHA — caller logs `tick_error` and skips the
// transition (no budget consumed).
import type { PrCheck, PrSnapshot } from "../ports/github.ts";

export type CiOutcome = "pass" | "fail" | "pending" | "stale";

export function classifyCi(
  snapshot: PrSnapshot,
  _ciWorkflowName: string | null,
): CiOutcome {
  if (
    snapshot.checks.checkSha !== null &&
    snapshot.checks.checkSha !== snapshot.headSha
  ) {
    return "stale";
  }

  // `ci_workflow_name` is retained in the repo schema for compatibility, but
  // it is no longer authoritative for failure detection: any reported failing
  // product-CI check blocks review/done, even when GitHub marks it
  // non-required. Review automation checks are excluded because they report
  // on Quay/legacy reviewer execution, not on the PR's code health.
  return classifySet(snapshot.checks.items.filter(isProductCiCheck));
}

function classifySet(items: PrCheck[]): CiOutcome {
  if (items.length === 0) return "pass";
  let hasFail = false;
  let hasPending = false;
  for (const c of items) {
    if (c.bucket === "fail" || c.bucket === "cancelled") {
      hasFail = true;
      continue;
    }
    if (c.bucket === "pending") {
      hasPending = true;
    }
  }
  if (hasFail) return "fail";
  if (hasPending) return "pending";
  return "pass";
}

function isProductCiCheck(check: PrCheck): boolean {
  return !isReviewAutomationCheckName(check.name) &&
    !isReviewAutomationCheckName(check.workflow);
}

function isReviewAutomationCheckName(value: string | null): boolean {
  if (value === null) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "fe pr review" || normalized === "quay review";
}
