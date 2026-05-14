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
  // check blocks review/done, even when GitHub marks it non-required.
  return classifySet(snapshot.checks.items);
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
