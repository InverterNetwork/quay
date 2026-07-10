# Prompt-improvement analysis — 05: proposed preambles (worker v4, reviewer v7)

**Date:** 2026-07-10. Final deliverable of the analysis run defined in
`docs/quay-prompt-improvement-signals.md`. Full texts:

- **Worker (code) v4** → `proposed-preamble-code-v4.md` (from current v3, `current-preamble-code-v3.md`)
- **Reviewer (review) v7** → `proposed-preamble-review-v7.md` (from current v6, `current-preamble-review-v6.md`)

Both are strictly additive except the worker header bump ("monorepo v2" → "monorepo v3") and
the renumbering of worker items 8–13 → 9–14. Every added line traces to gate decisions in
`04-gated-candidates.md`; evidence and exemplar PRs in `03-cluster-analysis.md`.

## Worker v4 — what changed

One new item **8. Engineering quality bar** (10 bullets). Rationale: the v3 preamble is
entirely process/PR mechanics; 100% of the engineering-defect mass in Signals A and B had no
corresponding instruction. Bullet → evidence:

| Bullet | Cluster | Support (tasks/PRs, repos) |
|---|---|---|
| Fix the class, not the instance | INCOMPLETE | B 22/6 + A 9/4 (46 "still…" re-review findings) |
| State + external side effects | RACE | B 14/5 + A 11/3 |
| Failures must surface | SILENT | B 5/3 + A 11/4 |
| Wire it end-to-end | WIRE | B 10/4 + A 9/4 |
| Contracts and consumers | COMPAT | B 9/4 + A 5/3 |
| Boundaries and units | EDGE | B 11/6 + A 7/3 |
| Tests must be able to fail | TESTQ | A 5/2 (4 reviewers) + C |
| Security hygiene | SEC+VALIDATE | B 19/5 + A 5/4 |
| Docs are part of the change | DOCS | B 12/5 + A 14/6 |
| Ship no dead code | DEADCODE | A 7/3 + C 2/1 |

## Reviewer v7 — what changed

1. New section **## High-miss lenses** inserted directly after **## Mindset** (8 lenses:
   interleavings, deployed reality, failure paths, test quality, parallel sites,
   units/boundaries, consumers, hot paths). All lens claims are same-SHA-verified misses:
   64/73 Signal-A human CRs landed on commits this reviewer had approved at the identical SHA.
2. Watchlist: added **Dead code** bullet (9 PRs / 3 repos / 3 reviewers).
3. Watchlist: added **Redaction boundaries** bullet (5 PRs / 4 repos / 4 reviewers; exemplars:
   iTRY-monorepo#1074 redactor bypass, hermes-agent#134 private URLs into prompt,
   iTRY-monorepo#1035 silenced zizmor warning).

Deliberately **not** changed (gate 1 — already in prompt, misses are adherence problems):
Documentation-impact bullet (still the #1 miss cluster) and noise-comments bullet. If v7's
lens section doesn't move the DOCS miss rate, the next lever is structural (e.g. a required
pre-approve checklist step), not more text.

## How to ship & measure (gate 6)

1. Insert each body as a new `preambles` row (`kind='code'` / `kind='review'`) on Kostia;
   Quay stamps `preamble_id` on every attempt.
2. Measure against the 2026-07-10 baselines (03):
   - Worker: mean CR-cycles per merged quay_owned task — v3 baseline **0.64** (n=113).
   - Reviewer: human-CR rate on bot-approved quay_owned PRs — v2 25.0%, v5 32.6%, v6 22.2% (n=9, immature).
   - Re-run the queries in the signals spec §6 / this analysis after ~50 tasks per version.

## Repo-specific routing (not in the global preambles)

Per gate 4, these belong in per-repo guidance (AGENTS.md / reviewer guidance catalog):

- **iTRY-monorepo** (accepted, n=3): new/changed stats or APY responses must be validated
  against the pinned frontend consumer schemas before changing shape or scale.
- **iTRY-monorepo** (watch, n=2): public, unauthenticated endpoints must be registered in
  `isPublicSessionlessPath` in **both** entrypoints (`lambda-hono.ts`, `index.ts`).
- **brix-landing** (watch, n=2): landing-page metrics must use the same data sources/derivation
  as the app (`/api/v1/itry/stats` paths), not landing-side recomputation.
- **atlas** (watch, n=2): enforce `bun run typecheck` in CI; the reviewer approved a head that
  failed typecheck (atlas#37) — a CI lever, not a prompt lever.

## Known limitations

- Cluster labels are single-label, hand-assigned; counts are conservative at task/PR level.
- Two reviewers produce 77% of human CRs; gate 5 was applied per-cluster (all accepted
  clusters have ≥3 reviewers), but reviewer taste bias can't be fully excluded.
- Signal C's 3 bot-CR-at-same-SHA reviews were not content-diffed finding-by-finding (14 of 17
  same-SHA cases were bot approvals, which need no diff).
- The worker preamble retains its pre-existing iTRY-monorepo-specific sections (10–14);
  moving them to repo guidance requires per-repo preamble wiring (operational change, flagged
  in 04, out of scope here).
