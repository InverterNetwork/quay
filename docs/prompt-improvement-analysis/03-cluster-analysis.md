# Prompt-improvement analysis — 03: change-request content clusters

**Date:** 2026-07-10. All change-request content parsed into findings and hand-clustered.
Corpus: Signal B = 152 findings from 129 Quay-reviewer CR reviews (74 quay_owned tasks);
Signal A = 148 findings from 73 human CR reviews (41 quay_owned PRs); Signal C = 81 findings
from 21 clean human CR reviews (13 human-authored PRs; 2 `quay-worker[bot]`-authored PRs excluded).

**Reviewer-miss precision (Signal A):** 64/73 human CR reviews landed on a commit the Quay
reviewer had **approved at the exact same SHA** (69/73 bot-reviewed at same SHA). The §2.2
assumption is not needed for these: they are directly verified reviewer false negatives.

## Taxonomy

| Cluster | Meaning |
|---|---|
| RACE | race / non-atomic transition / crash-window / idempotency / durability / staleness |
| INCOMPLETE | partial fix or partial rollout: parallel code path or second call-site missed; rework fixed the flagged instance, not the class |
| SILENT | failure swallowed, misleading success, error-path data loss, no alert on failure |
| WIRE | implemented but not wired end-to-end: not deployed/scheduled/registered/reachable, config knob not plumbed, calls a nonexistent API/field |
| DOCS | docs/runbooks/specs/CLAUDE.md not updated with (or contradicted by) the change |
| EDGE | boundary/default/empty/zero/null/precision/units handling |
| COMPAT | breaks an existing consumer/contract/legacy param/migration |
| SEC | secret/credential exposure, authz gap, privilege issue |
| TESTQ | tests vacuous/weak/missing for the changed behavior (human-review-specific) |
| DEADCODE | dead, duplicative, or leftover code shipped |
| VALIDATE | missing input validation |
| CHECKS | PR head fails repo checks (typecheck), or PR relaxes repo-wide checks |
| PERF | performance |
| SCOPE | product/design/scope disagreement → task-brief lever, **not** prompt (per gate 2) |

## Signal B — Quay-reviewer CRs on quay-owned PRs (worker tier 2)

152 findings, 74 tasks, 8 repos. By distinct **tasks**:

| Cluster | findings | tasks | repos |
|---|---|---|---|
| INCOMPLETE | 30 | 22 | 6 |
| RACE | 32 | 14 | 5 |
| DOCS | 12 | 12 | 5 |
| SEC | 14 | 11 | 4 |
| EDGE | 13 | 11 | 6 |
| WIRE | 10 | 10 | 4 |
| COMPAT | 14 | 9 | 4 |
| VALIDATE | 8 | 8 | 5 |
| SILENT | 8 | 5 | 3 |
| MISC | 11 | 11 | 4 |

46 findings across 33 tasks and 5 repos contain "still": the worker's rework addressed the
flagged instance but not the class ("applied the gate to `mint.tsx` but not `redeem.tsx`",
"applies the body limit to one route, not every POST route").

## Signal A — human CRs on quay-owned PRs (worker tier 1 + reviewer misses)

148 findings, 41 PRs, 7 repos, 5 human reviewers. By distinct **PRs** (miss@sha = findings in
reviews where the bot had approved the identical commit):

| Cluster | findings | PRs | repos | reviewers | miss@sha |
|---|---|---|---|---|---|
| DOCS | 21 | 14 | 6 | 3 | 19 |
| SILENT | 20 | 11 | 4 | 3 | 18 |
| RACE | 25 | 11 | 3 | 2 | 17 |
| WIRE | 11 | 9 | 4 | 2 | 9 |
| INCOMPLETE | 11 | 9 | 4 | 3 | 11 |
| EDGE | 9 | 7 | 3 | 3 | 9 |
| DEADCODE | 8 | 7 | 3 | 2 | 7 |
| TESTQ | 6 | 5 | 2 | 4 | 6 |
| COMPAT | 5 | 5 | 3 | 2 | 4 |
| SCOPE | 5 | 5 | 3 | 3 | — |
| SEC | 4 | 3 | 3 | 2 | 4 |
| PERF | 4 | 3 | 3 | 1 | 3 |
| VALIDATE | 2 | 2 | 2 | 1 | 2 |
| CHECKS | 2 | 1 | 1 | 1 | 2 |
| MISC | 12 | 9 | 4 | 4 | 12 |

## Signal C — human CRs on human-authored PRs (reviewer only, highest precision)

81 findings, 13 PRs, 2 repos (iTRY-monorepo, iTRY-frontends), 4 reviewers.
Top by distinct PRs: SILENT 5, EDGE 4, DOCS 4, WIRE 3, RACE 3, COMPAT 3, TESTQ 2 (but 8
findings — the iTRY-monorepo#1079 review alone identified 7 untested/dead-scaffold areas the
bot approved), SEC 2, INCOMPLETE 2, CHECKS 1.

## Representative evidence (all verified same-SHA reviewer misses unless noted)

- **RACE** — iTRY-monorepo#1076: ~20 human findings across review rounds on Safe-proposal
  reservation races (cancel vs proposal creation, computed hash treated as Safe acceptance,
  abandoned reservation wedges scheduler); the bot approved multiple heads mid-saga. Same class
  in brix-indexer#4 (reorg replay of cached RPC reads), iTRY-monorepo#961/#1003 (watermark
  races, claim-before-send drops notification).
- **WIRE** — iTRY-monorepo#950: `CHAIN_ID` never injected into the Lambda → monitor is a
  silent no-op on staging/prod. iTRY-frontends#200: wrong endpoint path → proposed markup
  never loads. iTRY-monorepo#985: new admin route not in route table. quay#38: auth preflight
  calls a nonexistent GraphQL field. iTRY-monorepo#1007: removing a CDK stack from the app
  doesn't destroy the deployed stack → 3 live consumers on one stream. Signal C:
  iTRY-monorepo#1048 `CHAIN_ID` never set on order-notification Lambdas (same class, human PR).
- **SILENT** — iTRY-monorepo#950: per-Safe failures swallowed so the new failure alarm never
  fires. iTRY-monorepo#985: green success toast when the on-chain TX failed; client swallows
  real server error messages. iTRY-monorepo#1090: fail-closed 403 skips `newrelicNoticeError`
  (only ≥500 is "operational") → prod-wide order halt would alert nothing. atlas#46: `atlas
  query` silently ignores runtime-config AI settings.
- **DOCS** — 26 same-SHA misses across 6 repos; typical: `packages/serverless/CLAUDE.md` still
  documents the old channel split (iTRY-monorepo#1003), docs index/architecture docs missing
  the new reconciler (#1001), spec still calls shipped behavior future work (quay#102).
- **TESTQ** — iTRY-monorepo#1126: env-guarded test passes vacuously outside prod.
  iTRY-frontends#225: exact-equality guard tested in only one direction; funnel exit without a
  failure-event assertion. iTRY-monorepo#1079 (Signal C): EIP-1271 path ships untested with
  dead test scaffolding. iTRY-frontends#183: spender-drift workflow can go green running zero
  checks.
- **CHECKS** — atlas#37: bot approved a head where `bun run typecheck` fails (multiple strict
  TS errors); iTRY-monorepo#977 (C): feature PR relaxes a repo-wide test lint rule.
- **INCOMPLETE** — iTRY-monorepo#1088: resolution gate applied to `mint.tsx` but not
  `redeem.tsx`. iTRY-monorepo#1113: endpoint copies the `/v1/itry` template "only halfway" —
  not registered in `isPublicSessionlessPath` in either entrypoint; same gap again in
  iTRY-monorepo#1048 (C#51).
- **EDGE/NUMERIC** — iTRY-monorepo#1088: `Number()` precision loss + hardcoded 1e18;
  #1056 (C): FX collateral math hard-coded to USDC decimals; #1048 (C): SELL volumes change
  by 1e12, `totalVolume` mixes incommensurable units; iTRY-frontends#183 (C): token switch
  rescales typed amount by 10^12.
- **SEC** — iTRY-monorepo#1074: `errorDetails` logged raw, bypassing the key-name redactor
  (wallet addresses to CloudWatch). hermes-agent#134: private Slack file URLs copied into an
  agent prompt. iTRY-monorepo#1035 (C): zizmor cache-poisoning warning silenced with a bogus
  justification — human caught the silencing.
- **SCOPE (routed away per gate 2)** — brix-landing#83 (split shared APY primitive),
  iTRY-monorepo#1127 (WAF redesign), #985 (move control to dedicated nav), brix-indexer#15
  (model as event indexing), brix-landing#97 (landing must mirror app data sources —
  repo-guidance candidate, not global prompt).

## Adherence findings (gate 1: already-in-prompt, so no new line)

- **DOCS misses vs reviewer prompt:** the reviewer watchlist already has a "Documentation
  impact" bullet, yet DOCS is the #1 miss cluster (26 same-SHA misses). Salience problem.
  For the **worker** prompt there is no docs-update instruction at all → worker line justified
  (kills the root cause; also directly supported by 12 Signal-B tasks / 5 repos).
- **Noise comments:** already a reviewer watchlist bullet; humans still flag them on
  bot-approved heads (C#10, C#46 on iTRY-monorepo#1079/#1048). Adherence, not absence.

## Baseline metrics (for measuring any preamble change, gate 6)

- Worker (merged quay_owned tasks, CR-cycles per task): v1 = 0.93 (28 tasks) → v3 = 0.64 (113 tasks).
- Reviewer (human-CR rate on bot-approved quay_owned PRs): v2 = 25.0% (n=92), v5 = 32.6% (n=46), v6 = 22.2% (n=9, low n).

## Notes & caveats

- 72/104 human CR bodies use the reviewer's own structured format (LLM-assisted human review);
  they still count as human signal per spec §2. Zero inline comments exist anywhere.
- Reviewer concentration: lafawnduh1966 + marvinkruse = 77% of human CRs. Clusters below 3
  reviewers are flagged in 04 under gate 5.
- Cluster assignment is single-label by primary failure mode; many findings straddle
  (e.g. "swallowed failure in a race window").
