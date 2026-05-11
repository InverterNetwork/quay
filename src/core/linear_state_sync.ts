// Linear ticket-state writeback hooked into the existing state-transition
// emitters in claims / tick / cancel. Best-effort, idempotent, and silent
// on non-Linear / non-configured paths.
//
// The mapping below is hardcoded — every Linear team that uses quay must
// have workflow states named exactly "In Progress", "Waiting", and
// "Canceled". Per-team overrides + a feature flag for opt-in deployments
// are deferred follow-ups.
//
// PR-driven transitions (pr-open, merged, closed_unmerged) deliberately
// skip the sync: Linear's native GitHub integration already moves the
// ticket on PR-open / PR-merge, and a double-write would race that
// integration. Tick callers must NOT invoke `syncLinearState` on those
// events — the absence is asserted by an integration test.

import type { LinearPort } from "../ports/linear.ts";

// "queued" and "spawned" both map to the same Linear state; the writeback
// stays idempotent on the second hop. Exposed as named constants so the
// emit sites read like the spec table verbatim.
export const LINEAR_STATE_IN_PROGRESS = "In Progress";
export const LINEAR_STATE_WAITING = "Waiting";
export const LINEAR_STATE_CANCELED = "Canceled";

// Linear identifier shape: TEAM_KEY-NUMBER (e.g. ENG-1234, ITRY-1327).
// Pinned at the sink so a non-Linear external_ref (legacy
// `--brief-file --external-ref` callers, or some future second source)
// is never sent to the Linear adapter and never logs a noisy warning.
const LINEAR_IDENTIFIER = /^[A-Z][A-Z0-9]*-\d+$/;

// Best-effort writeback. Catches every adapter error and downgrades to a
// stderr warning; quay's own state remains the source of truth.
export async function syncLinearState(
  linear: LinearPort | undefined,
  externalRef: string | null,
  stateName: string,
): Promise<void> {
  if (linear === undefined) return;
  if (externalRef === null) return;
  if (!LINEAR_IDENTIFIER.test(externalRef)) return;
  try {
    await linear.setIssueState(externalRef, stateName);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Single-line so log scrapers can join on the prefix without having to
    // handle multi-line wrapping.
    process.stderr.write(
      `[linear-sync] failed to set state="${stateName}" on ${externalRef}: ${message}\n`,
    );
  }
}
