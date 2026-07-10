# Prompt-improvement analysis — 01: data snapshot

**Date:** 2026-07-10. Analysis run per `docs/quay-prompt-improvement-signals.md`.
**Thresholds chosen (§7):** recurring = ≥3 distinct tasks; global = ≥2 repos (else repo-specific).
**Deliverable:** full proposed worker + reviewer preambles, changes annotated with evidence.

## DB snapshot (quay.db copied from krustentier 2026-07-10 ~09:14 UTC)

- 405 tasks: 207 `quay_owned`, 187 `synthetic_review`, 11 `adopted_external_pr`.
- States: 295 merged, 39 cancelled, 36 merged_to_feature_branch, 11 closed_unmerged, 8 done, 8 waiting_human, rest in flight.
- 369 tasks have a `pr_url` (deduped for the GitHub sweep).

## Preamble versions (the prompts under improvement)

| kind | id | created | note |
|---|---|---|---|
| code (worker) | 1 | 2026-05-09 | early, 1.1k chars |
| code (worker) | **3** | 2026-05-26 | **current**, 4.6k chars, "monorepo v2" |
| review | 2 | 2026-05-12 | 549 reviewer runs (May 13 – Jun 12) |
| review | 4, 5 | 2026-06-12 | v5: 535 runs (Jun 12 – Jul 6) |
| review | **6** | 2026-07-06 | **current**, 38 runs since Jul 7 |

Worker attempts split: preamble 1 = 114 attempts, preamble 3 = ~450 attempts (all reasons).
Reviewer (`review_only`) attempts: v2=549, v5=535, v6=38.

## Signal set sizes (this snapshot)

| Signal | Definition | Count |
|---|---|---|
| B (all) | reviewer verdict `changes_requested` (attempts == events cross-check) | 151 tasks |
| B (worker tier 2) | …restricted to `authoring_mode='quay_owned'` | 74 tasks |
| A (in-DB subset) | `changes_requested` event with `from_state='done'` | 41 tasks |
| C candidates | `synthetic_review` tasks | 187 tasks |

### Signal A (in-DB subset, 41) by repo
iTRY-monorepo 24, quay 5, atlas 3, iTRY-frontends 3, brix-indexer 2, brix-landing 2, hermes-agent 2.
By authoring mode: 37 quay_owned, 3 adopted_external_pr, 1 synthetic_review.

### Signal B (quay_owned, 74) by repo
quay 25, iTRY-monorepo 18, atlas 12, hermes-agent 9, iTRY-frontends 5, brix-indexer 3, itry-liquidation-bot 1, brix-landing 1.

### Signal C candidates (187) by repo
iTRY-monorepo 108, iTRY-frontends 59, brix-landing 12, brix-prototypes 4, brix-prototyping-sandbox 2, test-factory-code 1, itry-liquidation-bot 1.

## Working data (scratchpad, not committed)

Local copies pulled to the analysis scratchpad: `quay.db`, all 1032 `review_comments`/`review_result` artifact files (14 MB), preamble bodies v1/v3 (code) and v2/v4/v5/v6 (review), signal-set JSON extracts. GitHub review sweep across all 369 PR urls running via `gh api repos/{o}/{r}/pulls/{n}/reviews`.

Current preamble bodies are committed alongside this analysis for diffing:
- `current-preamble-code-v3.md`
- `current-preamble-review-v6.md`

## Next steps
1. (02) GitHub sweep → complete human-CR set; split Signal A full vs Signal C.
2. (03) Cluster Signal B review content (worker tier 2) + Signal A human CR content (worker tier 1 + reviewer misses); Signal C content diff at head_sha.
3. (04) Apply §7 gates. 4. (05/06) Proposed preambles.
