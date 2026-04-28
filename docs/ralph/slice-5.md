# Slice 5: Deterministic Retries and Budget Exhaustion

## Required reading

1. `docs/quay-spec.md` — §5 (kill intents: stale, wall_clock,
   spawn-failure rollback), §7 (retry composition, budget rules,
   exhaustion → orchestrator), §9 (retry templates), §15
   (spawn-failure cases 45, 46b, 62, 63).
2. `docs/quay-tdd-implementation-plan.md` — Slice 5 is the authority.
3. `docs/ralph/RUNBOOK.md`.

## Goal

Compose deterministic retry briefs from retry templates + the most
recent brief. Schedule pending budget-consuming attempts. Budget is
consumed at promotion (Slice 3), not at trigger detection. When the
budget cap is reached, do not insert a pending attempt — write
`last_failure`, set `budget_exhausted = true`, transition the task to
`awaiting-next-brief`, and hand it back to the orchestrator.

## Red tests (must exist with these names and must pass)

| Test name | Proves |
|---|---|
| `test_005_ci_fail_schedules_budget_consuming_retry` | Failed CI in `pr-open` snapshots a `ci_failure_excerpt`, composes a Quay-owned retry brief from the `ci_fail` template + latest brief, inserts a pending `ci_fail` attempt with `consumed_budget = 1`, and leaves budget spending to later promotion. |
| `test_013_final_attempt_blocker_sets_budget_exhausted` | A valid blocker on the final allowed attempt is ingested, sets `budget_exhausted = true`, writes `last_failure`, transitions to `awaiting-next-brief`, and schedules no `blocker_resolved` retry. |
| `test_021_retry_budget_exhaustion_creates_last_failure` | Any deterministic retry trigger at budget cap does not insert a pending attempt; it writes the would-have-been retry context as `last_failure`, sets `budget_exhausted`, hands the task to the orchestrator. |
| `test_022_wall_clock_kill_schedules_retry` | A live worker past `max_attempt_duration_seconds` gets `kill_intent = wall_clock` before tmux kill; the finalizer marks `killed_wall_clock` and schedules a pending budget-consuming `wall_clock` retry. |
| `test_023_retry_brief_uses_most_recent_brief` | Quay-composed deterministic retry briefs wrap the latest spawned brief (including orchestrator-submitted follow-ups), not the initial enqueue brief. |
| `test_stale_kill_schedules_retry_once` | A stale live worker gets `kill_intent = stale` before tmux kill; retry/finalizer re-entry schedules exactly one pending `stale` retry. |
| `test_045_spawn_failure_no_evidence_rolls_back_budget_and_requeues` | A `running` attempt with `spawned_at` set, `tmux_session = NULL`, and no worker evidence is classified as `spawn_failed`, rolls back the promotion budget increment, increments `spawn_failures_consecutive`, and schedules a clean retry of the same logical attempt. |
| `test_046b_spawn_window_push_without_pr_takes_spawn_failed_default` | In the spawn-window recovery path, a worker push without a PR is not trackable as `pr-open`; with no signal file and no PR, the no-evidence default applies: `spawn_failed`, budget rollback, fresh queued attempt. |
| `test_062_max_spawn_failures_parks_worktree_error` | Consecutive no-evidence spawn failures increment `spawn_failures_consecutive`; once the configured cap is reached, the task transitions to parked `worktree_error` instead of requeueing forever. |
| `test_063_evidence_found_recovery_resets_spawn_failures` | Any evidence-found spawn-window recovery outcome, such as PR opened or blocker written, resets `spawn_failures_consecutive` to 0 and preserves budget. |

Place tests under `tests/retries/`, `tests/kill_intent/`, and
`tests/spawn_failure/`.

## Minimal implementation

- Retry-template lookup (table from spec §9).
- Attempt-scheduling helper that inserts a pending attempt with
  `consumed_budget = 1` and the composed retry brief artifact.
- Budget-exhausted helper: write `last_failure`, set
  `budget_exhausted`, transition to `awaiting-next-brief`.
- Stale and wall-clock kill-intent finalizers (kill_intent set
  before tmux kill; failpoint `after_kill_intent_commit`).
- Spawn-failure rollback helper for `running + spawned_at NOT NULL +
  tmux_session IS NULL` with no evidence: write `exit_kind =
  'spawn_failed'`, roll back budget if consumed, increment
  `spawn_failures_consecutive`, requeue below cap, park in
  `worktree_error` at cap, and reset the counter on evidence-found
  recovery.

## Done criteria

- Trigger detection never increments budget directly.
- Budget-consuming attempts increment only on later promotion.
- Exhausted tasks are handed back to the orchestrator (not
  terminal-failed).
- All ten tests pass; suite green; typecheck green.

## Hard rules

- Spec and plan are read-only.
- Do not implement claim, cancel, Slack, PR polling, or CLI.
- Use fakes only.
- Do not touch `src/cli/`.
- Do not modify `docs/ralph/` outside `blockers/`; do not modify
  `scripts/`.
- Test names must match the table exactly.

Spec gap → `docs/ralph/blockers/SPEC-GAP-slice-5-<slug>.md`, stop.

## Working loop

1. `bun test` → first failing assertion.
2. `bun run typecheck`.
3. Smallest change toward green.
4. Re-run.

Prior gate feedback (if any) appended below.
