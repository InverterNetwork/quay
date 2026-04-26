# Slice 9: PR, CI, Review, and Conflict Polling

## Required reading

1. `docs/quay-spec.md` — §5 (pr-open / done polling, CI source-of-
   truth, review/conflict non-budget respawns, non-budget cap), §13
   (`ci_workflow_name`).
2. `docs/quay-tdd-implementation-plan.md` — Slice 9 is the authority.
3. `docs/ralph/RUNBOOK.md`.

## Goal

`pr-open` and `done` polling read CI, review, conflict, and merge/
close state from GitHub. CI source-of-truth rules respect
`ci_workflow_name` when set and treat absence of required checks as
pass. Review feedback and merge conflicts schedule non-budget
respawns with dedupe; the non-budget safety cap parks runaway respawn
loops in `non_budget_loop`. Stale check SHA disagreement is logged as
`tick_error` without state transition or budget consumption.

## Red tests (must exist with these names and must pass)

| Test name | Proves |
|---|---|
| `test_066_named_workflow_only_controls_ci_status` | When `ci_workflow_name` is set, only matching workflow checks control pass/fail/pending. |
| `test_068_no_required_checks_means_pass` | When no `ci_workflow_name` and GitHub reports no required checks, Quay treats CI as pass and moves `pr-open` → `done`. |
| `test_076_stale_check_sha_logs_tick_error_without_transition` | If PR head SHA and check-run SHA disagree, log `tick_error`, leave state unchanged, consume no retry budget. |
| `test_048_nonbudget_review_dedupe_does_not_respawn_same_review` | Sticky `CHANGES_REQUESTED` with the same already-acted review id does not schedule another review respawn. |
| `test_052_non_budget_cap_parks_on_n_plus_one` | The first N review/conflict respawns are allowed; the N+1 trigger parks in `non_budget_loop` without scheduling. |
| `test_083_advice_answered_does_not_increment_non_budget_counter` | Human-reply-driven `advice_answered` respawns do not increment `non_budget_respawns_consumed`; only review/conflict paths do. |
| `test_053_pr_open_merged_transitions_terminal` | `pr-open` task whose PR was merged transitions to `merged` and runs terminal cleanup even if CI was still pending. |
| `test_054_pr_open_closed_transitions_closed_unmerged` | `pr-open` task whose PR was closed without merge transitions to `closed_unmerged` and runs terminal cleanup. |
| `test_review_feedback_schedules_non_budget_respawn` | New `CHANGES_REQUESTED` snapshots review comments, schedules a pending `review` attempt with `consumed_budget = 0`, records `last_review_id_acted_on`. |
| `test_conflict_schedules_non_budget_respawn` | A new merge-conflict observation snapshots conflict context, schedules a pending `conflict` attempt with `consumed_budget = 0`, records `last_conflict_observation`. |

Place tests under `tests/pr/`, `tests/ci/`, `tests/review/`,
`tests/conflict/`.

## Minimal implementation

- Fake `GitHubPort` extensions: PR state, checks, reviews,
  mergeability, head/check SHAs.
- CI classifier (named-workflow vs default required-checks).
- Review and conflict scheduling helpers using a shared non-budget
  routine with dedupe (`last_review_id_acted_on`,
  `last_conflict_observation`) and a counter
  (`non_budget_respawns_consumed`) capped at `max_non_budget_respawns`.
- Stale SHA detection that logs `tick_error` without mutation.

## Done criteria

- Sticky GitHub signals cannot create uncontrolled respawn loops.
- CI failures consume budget only through scheduled retry promotion
  (Slice 5 path).
- Human merge/close detected from both `pr-open` and `done`.
- All ten tests pass; suite green; typecheck green.

## Hard rules

- Spec and plan are read-only.
- Use fakes only.
- Do not touch `src/cli/`.
- Do not modify `docs/ralph/` outside `blockers/`; do not modify
  `scripts/`.
- Test names must match the table exactly.

Spec gap → `docs/ralph/blockers/SPEC-GAP-slice-9-<slug>.md`, stop.

## Working loop

1. `bun test` → first failing assertion.
2. `bun run typecheck`.
3. Smallest change toward green.
4. Re-run.

Prior gate feedback (if any) appended below.
