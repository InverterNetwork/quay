// Linear ticket-state writeback hooked into the existing state-transition
// emitters in claims / tick / cancel. Best-effort, idempotent, and silent
// on non-Linear / non-configured paths.
//
// The mapping is hardcoded — every Linear team that uses quay must have
// workflow states named exactly "In Progress", "Waiting", and "Canceled".
//
// PR-driven transitions (pr-open, merged, closed_unmerged) deliberately
// skip the sync: Linear's native GitHub integration already moves the
// ticket on PR-open / PR-merge, and a double-write would race that
// integration. Tick callers must NOT invoke `syncLinearState` on those
// events — the absence is asserted by an integration test.
//
// Critically, callers under the supervisor lock (tick_once, cancel_task)
// use `LinearSyncQueue` to schedule the writeback rather than awaiting
// inline: the HTTP round-trip begins immediately but the lock-holder
// does not block on completion. The queue is drained after the lock
// releases, so a slow Linear (or a 30s timeout) cannot extend the
// supervisor-lock-held window.

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

// Per-process record of (identifier, stateName) pairs we've already warned
// about. Stops a Linear outage from emitting one stderr line per task per
// tick — the operator sees each failure mode once and can act on it.
// Cleared on process restart; not bounded because the state-name domain
// is small (3 values) and identifier turnover is operator-paced.
const warnedFailures = new Set<string>();

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
    const key = `${externalRef}|${stateName}`;
    if (warnedFailures.has(key)) return;
    warnedFailures.add(key);
    const message = err instanceof Error ? err.message : String(err);
    // Single-line so log scrapers can join on the prefix without having to
    // handle multi-line wrapping.
    process.stderr.write(
      `[linear-sync] failed to set state="${stateName}" on ${externalRef}: ${message}\n`,
    );
  }
}

// Schedule-and-drain queue for callers that run under the supervisor lock.
// `enqueue` starts the underlying HTTP round-trip immediately (so the local
// short-circuit cache + first-byte latency overlap with the rest of the
// in-lock work), but does not await — the caller awaits via `drain()`
// once the lock is released. Promises returned by `syncLinearState` never
// reject (errors are caught internally), so `Promise.allSettled` is used
// for safety rather than necessity.
export class LinearSyncQueue {
  private readonly pending: Promise<void>[] = [];

  constructor(private readonly linear: LinearPort | undefined) {}

  enqueue(externalRef: string | null, stateName: string): void {
    this.pending.push(syncLinearState(this.linear, externalRef, stateName));
  }

  async drain(): Promise<void> {
    if (this.pending.length === 0) return;
    const inflight = this.pending.splice(0, this.pending.length);
    await Promise.allSettled(inflight);
  }
}

// Test-only: drop the warn-dedup memory so multi-failure scenarios in the
// same process can be exercised independently. Production code never calls
// this — there is no operator surface for it.
export function resetLinearSyncWarnings(): void {
  warnedFailures.clear();
}
