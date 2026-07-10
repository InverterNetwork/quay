# Prompt-improvement analysis — 02: GitHub human-CR sweep (Signals A full + C)

**Date:** 2026-07-10. Sweep of all 369 distinct task PRs via `gh api repos/{o}/{r}/pulls/{n}/reviews` — 0 failures.

## Review inventory (all 369 PRs)

- 995 reviews by `quay-reviewer[bot]` (matches the 995 `review_comments` artifacts in the DB — good cross-check).
- 279 reviews by 6 human accounts; 1 by `quay-worker[bot]`.
- States: 757 APPROVED, 462 CHANGES_REQUESTED, 35 COMMENTED, 21 DISMISSED.

## Human CHANGES_REQUESTED reviews: 104 total, 60 distinct PRs

| Set | Reviews | PRs | Tasks | Repos |
|---|---|---|---|---|
| **Signal A full** (quay_owned) | 73 | 41 | 41 | iTRY-monorepo 47, atlas 7, quay 7, brix-indexer 4, iTRY-frontends 3, brix-landing 3, hermes-agent 2 (reviews per repo) |
| **Signal C** (synthetic_review) | 23 | 15 | — | iTRY-monorepo 17, iTRY-frontends 6 |
| adopted_external_pr (hybrid, kept separate) | 8 | 4 | — | — |

Reviewer concentration (all 104): lafawnduh1966 ×41, marvinkruse ×39, aminlatifi ×14, 0xNuggan ×8, johnshift ×2. **Gate 5 (overfitting guard) matters: two reviewers produce 77% of the human CRs.**

Signal C reviewer/author checks: 0 self-reviews (reviewer == PR author never happens in the CR set). PR authors in the C set include `quay-worker[bot]` ×2 — those two PRs are Quay-authored despite the synthetic-review task mode (PR shared with a quay task); they are excluded from the clean C set during content analysis.

## Content shape (matters for parsing)

- **Zero inline review comments on all 60 PRs** — the entire signal is in review bodies (~339k chars).
- 72/104 human CR bodies use the same structured `## Review Findings` format as the Quay reviewer (humans review with LLM assistance but sign with their accounts; per spec they count as human).
- Body sizes: median 2.6k chars, mean 3.3k, max 15.4k. 4 bodies are short pointers ("please address @marvinkruse's finding") — these defer to another review on the same PR and are folded into it during analysis.

## In-DB subset vs full set

The in-DB Signal A subset (41 tasks with `changes_requested` from `done`) and the sweep's Signal A set (41 tasks) are similarly sized but not identical; the sweep also catches human CRs that landed while the task was still in the review loop. Union is used downstream.

## Next
03: parse human CR bodies into findings; cluster Signal A (worker tier 1); match human CR SHAs against Quay bot reviews on the same PRs to establish reviewer misses; Signal C content diff at head_sha. Signal B clustering (worker tier 2) is already computed — see 03.
