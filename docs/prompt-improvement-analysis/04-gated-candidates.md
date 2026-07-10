# Prompt-improvement analysis — 04: §7 gate decisions

**Date:** 2026-07-10. Thresholds: recurring N≥3 distinct tasks/PRs; global K≥2 repos.
Support notation: `B: tasks/repos` (Quay-reviewer CRs, worker tier 2), `A: PRs/repos/reviewers`
(human CRs on quay-owned PRs), `C: PRs/reviewers` (human CRs on human PRs, reviewer-only).
`miss` = PRs where the bot approved the identical SHA the human then CR'd.

## Accepted — WORKER preamble (global)

Gate 1 note: the current worker preamble (code v3) contains **zero** engineering-quality
guidance — it is entirely PR mechanics — so every candidate below passes "already-in-prompt"
trivially. All are objective-defect-shaped (gate 2), all clear N/K (gates 3–4), and all
human-derived ones have ≥3 independent reviewers (gate 5).

| # | Rule (condensed) | Evidence |
|---|---|---|
| W1 | Fix the class, not the instance: sweep every parallel site/path; a template copy carries all the template's obligations | B: 22/6 (46 "still…" findings across 33 tasks); A: 9/4/3. Exemplars: mint.tsx-but-not-redeem.tsx (iTRY-monorepo#1088), one-route-not-all-routes (atlas#61 era, quay#102), half-copied endpoint template (#1113) |
| W2 | State + external side effects: idempotency, crash windows, confirm-before-record, concurrent interleavings | B: 14/5; A: 11/3/2 (+C 3 PRs). Exemplars: Safe reservation saga (#1076, ~20 findings), claim-before-send (#1003), reorg replay (brix-indexer#4) |
| W3 | Failures must surface: no swallowed errors, no success reporting on failed side effects, alerting must actually fire, UI must not show success on failure | B: 5/3; A: 11/4/3; C: 5/3. Exemplars: alarm-never-fires (#950), green toast on failed TX (#985), 403 skips NewRelic (#1090) |
| W4 | Wire it end-to-end in the deployed shape: routes registered, env vars/config plumbed through IaC, referenced APIs/fields exist, infra-code removal ≠ deployed-stack removal | B: 10/4; A: 9/4/2; C: 3/2. Exemplars: CHAIN_ID never injected (#950 and again C#1048), wrong endpoint path (#200), nonexistent GraphQL field (quay#38), CDK stack cutover (#1007) |
| W5 | Update every doc the change invalidates (README, CLAUDE/AGENTS.md, runbooks, specs, docs indexes); never describe shipped behavior as future | B: 12/5; A: 14/6/3; C: 4/3 |
| W6 | Boundaries, defaults, units: null-vs-unset, empty/zero, moving defaults, date/precision; never round money through floats, never hardcode decimals, unit changes are breaking | B: 11/6; A: 7/3/3; C: 4/2. Exemplars: Number() precision (#1088), USDC-scale hardcode (#1056), 1e12 unit shifts (#1048) |
| W7 | Contracts & consumers: changing a shared primitive/response shape requires checking every consumer (pinned schemas, sibling apps, legacy params); alias or migrate, don't silently break | B: 9/4; A: 5/3/2; C: 3/1. Exemplars: pinned frontend schema (#1059 + 5 B-findings), legacy `include=` ignored, rename without alias (#1048) |
| W8 | Security hygiene: secrets/PII never into logs, error details, argv, prompts, or synthesized templates (respect existing redaction layers); validate untrusted input; new surfaces get authz | B: 11+8/5 (SEC+VALIDATE); A: 3/3/2 + 2/2; C: 2/3. Exemplars: redactor bypass (#1074), key in cron argv, tar-as-root (hermes-agent) |
| W9 | Tests must be able to fail: assert the failure direction, no vacuous env-guarded passes, cover the changed critical path; don't relax repo-wide checks in a feature PR | A: 5/2/4; C: 2/1 (8 findings incl. the #1079 untested-path audit). Repos = 2 → passes K |
| W10 | No dead/duplicative code: no unused exports, dead branches, duplicate implementations, leftover scaffolding | A: 7/3/2; C: 2/1; reinforces the deployment's existing no-fallback convention |

## Accepted — REVIEWER preamble (global)

Same rules seen from the miss side; the reviewer gets **lenses** (what to actively check
before approving). Gate 1: none of these are in review v6 except as generic phrases
("logic errors", "poor error handling"); the specific lenses are new.

| # | Lens | Miss evidence (A+C, same-SHA verified) |
|---|---|---|
| R1 | Interleaving analysis on stateful flows (crash windows, retries, concurrency, external-side-effect confirmation) | 14 PRs / 4 repos / 3 reviewers; 9 miss-PRs. The bot approved multiple heads of #1076 mid-saga |
| R2 | Deployed-reality check (env plumbed? route registered? API/field exists? IaC teardown semantics?) | 12 PRs / 4 repos / 4 reviewers; 11 miss-PRs |
| R3 | Failure-path trace (who catches it, what user sees, does alerting fire; error-classification boundaries like "only ≥500 is operational") | 16 PRs / 5 repos / 4 reviewers; 16 miss-PRs |
| R4 | Test-quality audit (could this test ever fail? env-guarded vacuous passes, one-direction assertions, dead scaffolding, green-with-zero-checks CI jobs) | 7 PRs / 2 repos / **5 reviewers** (strongest agreement); 6 miss-PRs |
| R5 | Parallel-site completeness (fix applied to every sibling path/entrypoint; template obligations carried) | 11 PRs / 4 repos / 4 reviewers; 10 miss-PRs |
| R6 | Units/precision/boundary sweep on money-adjacent math (decimals hardcoding, float precision, scale changes, null-vs-unset) | 11 PRs / 4 repos / 4 reviewers; 9 miss-PRs |
| R7 | Consumer sweep on shared-surface changes (pinned schemas, sibling apps, blast radius of shared primitives) | 8 PRs / 4 repos / 3 reviewers; 5 miss-PRs |
| R8 | Extend existing noise-comment watchlist bullet to dead/duplicative code (unused exports, dead branches, duplicate impls) | 9 PRs / 3 repos / 3 reviewers; 8 miss-PRs |
| R9 | Sharpen existing security stance: data flowing into logs/prompts/templates is an exfiltration surface; verify new log/detail fields pass the repo's redaction layer; a silenced security warning needs a valid justification | 5 PRs / 4 repos / 4 reviewers; 5 miss-PRs |
| R10 | Perf clause (small): unbounded external reads / pathological complexity on hot paths | 5 PRs / 3 repos / 4 reviewers; 4 miss-PRs |

## Rejected / routed elsewhere

| Candidate | Verdict | Reason |
|---|---|---|
| DOCS lens for **reviewer** | **Reject (gate 1)** | "Documentation impact" already in v6 watchlist; DOCS is still the #1 miss cluster (16 miss-PRs) → salience/adherence problem; another line won't help. Worker-side W5 attacks root cause. Consider structural salience (ordering) only. |
| Noise-comments strengthening | Reject (gate 1) | Already in v6 watchlist; humans still catch missed instances (C: #1079, #1048) — adherence. |
| CHECKS ("run repo typecheck before approving/PR") | Reject (gate 3), borderline | Only 2 PRs (atlas#37 approved with failing typecheck; #977 lint-rule relaxation). High-embarrassment miss; revisit at N≥3 or fix via CI lever in atlas (typecheck not CI-enforced there). |
| PERF as **worker** rule | Reject (gate 3 via B) | B support thin; human PERF findings were mostly non-blocking style. Kept only as reviewer clause R10. |
| Scope/architecture CRs (#83 APY split, #1127 WAF redesign, #985 nav move, #15 event-indexing model) | Route: task-brief lever | Gate 2: product/design decisions, not prompt-shaped defects. |
| brix-landing "mirror the app's data sources" (#83, #97) | Route: repo guidance (n=2, watch) | Repo-specific consistency convention. |
| iTRY-monorepo `isPublicSessionlessPath` registration for public endpoints (#1113, C#1048) | Route: repo guidance (n=2, watch) | Exactly the repo-idiom case gate 2 routes to AGENTS.md / reviewer guidance catalog. |
| iTRY-monorepo pinned frontend consumer schemas (B×5 findings 1 task, #1059, #1048) | Route: repo guidance (n=3, **accepted repo-level**) | Global W7/R7 covers the class; the repo doc should name the actual pinned-schema locations. |
| Worker preamble §§9–12 (BRIX titles, Didier changelog, monorepo scopes) | Flag only | Pre-existing repo-specific content in the global prompt (violates gate 4 routing); moving it is an operational change (per-repo preamble wiring), not part of this proposal. |

## Bloat guard

Worker: +1 section (~12 lines) on a 83-line preamble; every line backed by ≥5 tasks. Reviewer:
+1 lens section (~12 lines) + 2 watchlist-bullet extensions on a 215-line preamble; no other
text touched. Both ship as new preamble versions; measure per gate 6 against the baselines in
03 (worker: CR-cycles/task, current 0.64; reviewer: human-CR rate on approved PRs, current
~25–33%).
