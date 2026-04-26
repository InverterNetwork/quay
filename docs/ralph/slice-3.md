# Slice 3: Tick Promotion, Capacity, and Spawn Accounting

## Required reading

1. `docs/quay-spec.md` — read-only. §4 (lifecycle), §5 (tick),
   especially the chokepoint and spawn accounting subsections; §9
   (attempts table predicates).
2. `docs/quay-tdd-implementation-plan.md` — Slice 3 is the authority.
3. `docs/ralph/RUNBOOK.md`.

## Goal

`tick_once(...)` is the single spawn point. It promotes a queued
task's pending attempt to running atomically, consuming budget at
promotion (not at trigger detection). Capacity caps apply to both
initial spawns and respawns. A spawn-failure window leaves the row
recoverable without misclassification.

## Red tests (must exist with these names and must pass)

| Test name | Proves |
|---|---|
| `test_001_tick_promotes_queued_to_running` | Tick reads active tasks, promotes a queued task's pending attempt to running, records `spawned_at`, `remote_sha_at_spawn`, `pr_existed_at_spawn`, increments `attempts_consumed`, and writes a `spawned` event. |
| `test_035_capacity_cap_prevents_extra_spawn` | At capacity, additional queued tasks are not promoted; budget is not consumed. |
| `test_promotion_consumes_budget_once` | Successful promotion increments `attempts_consumed` exactly once for the promoted attempt. |
| `test_promotion_rowcount_zero_on_cancel_intent_skips_spawn` | If `tasks.cancel_requested_at` is set during promotion, the predicate yields zero rows and tmux spawn is skipped; no budget consumed. |
| `test_spawn_failure_window_leaves_running_with_null_session_for_recovery` | A crash between SQL promotion and tmux session record leaves `state=running` with `tmux_session=NULL`; recovery (Slice 4) handles it without spawning a duplicate. |

Place tests under `tests/tick/` and `tests/promotion/`.

## Minimal implementation

- `tick_once(...)` reads active tasks under a supervisor-lock
  abstraction (a small wrapper that serializes side effects per task;
  in-process Mutex is fine for fakes).
- Pending-attempt lookup.
- Fake `TmuxPort` with `spawn`, `is_alive`, `kill` (kill/is_alive
  may be stubs at this point; spawn must be functional).
- Promotion transaction records `spawned_at`, `remote_sha_at_spawn`,
  `pr_existed_at_spawn`, increments `attempts_consumed`, writes
  `spawned` event. Predicate must filter on
  `cancel_requested_at IS NULL`.
- Session recording happens *after* successful substrate spawn so the
  spawn-failure window is real.

## Done criteria

- All spawns flow through `tick_once`. There is no other path that
  changes a task to `running`.
- Capacity prevents promotion before budget is consumed.
- All five tests pass; full suite green; typecheck green.

## Hard rules

- Spec and plan are read-only.
- Do not implement the dead-worker classifier, deterministic retries,
  claim, cancel, Slack, PR polling, or CLI.
- Use fakes only; no real adapters.
- Do not touch `src/cli/`.
- Do not modify `docs/ralph/` outside `blockers/`; do not modify
  `scripts/`.
- Test names must match the table exactly.

If you discover a spec gap, write
`docs/ralph/blockers/SPEC-GAP-slice-3-<slug>.md` and stop without
emitting the completion promise.

## Working loop

1. `bun test` → first failing assertion is next target.
2. `bun run typecheck`.
3. Smallest change toward green.
4. Re-run; confirm no regression.

Prior gate feedback (if any) appended below.
