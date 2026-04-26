# Slice 4: Dead-Worker Classifier

## Required reading

1. `docs/quay-spec.md` — read-only. §5 (tick: dead worker handling,
   classifier, idempotent PR contract), §6 (worker contract:
   `.quay-blocked.md`, blocker schema), §8 (artifacts), §14
   (invariants for blocker recovery).
2. `docs/quay-tdd-implementation-plan.md` — Slice 4 is the authority.
3. `docs/ralph/RUNBOOK.md`.

## Goal

When a worker is no longer alive, classify the outcome from durable
evidence: blocker signal, malformed signal, PR opened, no remote
progress, or unexplained crash. The classifier writes exactly one
terminal transition per outcome. Blocker artifacts dedupe across
crash recovery via `(task_id, attempt_id, kind, content_hash)`.
Deterministic retries (crash, no_progress, malformed_signal) schedule
pending budget-consuming attempts here — they do not increment
`attempts_consumed` until the next tick promotes them.

## Red tests (must exist with these names and must pass)

| Test name | Proves |
|---|---|
| `test_002_worker_blocker_transitions_to_awaiting_next_brief` | A dead worker with valid `.quay-blocked.md` produces a blocker artifact, deletes the worktree signal after durable ingest, and moves the task to `awaiting-next-brief` without scheduling a retry. |
| `test_003_dead_worker_without_pr_or_signal_schedules_crash_retry` | A dead worker with no blocker, no PR, no remote progress marks the attempt crashed, inserts a pending `crash` attempt with `consumed_budget = 1`, moves to `queued`, and does not increment `attempts_consumed` yet. |
| `test_043_blocker_crash_after_artifact_write_converges` | If tick crashes after blocker artifact write but before state/event update, the next tick reuses the existing artifact by `content_hash`, writes the missing state/event, and deletes the signal. |
| `test_073_retry_attempt_does_not_create_duplicate_pr` | A retry attempt that advances the remote branch for an existing PR transitions to `pr-open` without creating a duplicate PR. |
| `test_074_no_remote_progress_is_no_progress` | A dead retry attempt with an existing PR but unchanged remote SHA is classified `no_progress` and schedules a pending budget-consuming `crash` retry instead of transitioning to `pr-open`. |
| `test_074c_pr_created_during_attempt_counts_as_progress` | If no PR existed at spawn but one exists at exit, PR creation counts as progress even when remote SHA did not change during the attempt. |
| `test_malformed_blocker_schedules_malformed_signal_retry` | Malformed `.quay-blocked.md` is persisted as `malformed_signal`, deleted after durable ingest, and schedules a pending `malformed_signal` retry with `consumed_budget = 1` but no immediate budget increment. |
| `test_spawn_window_null_session_uses_same_classifier` | A `running` attempt with `spawned_at` set and `tmux_session = NULL` kills the canonical orphan session if present, then runs the same classifier instead of unconditionally `spawn_failed`. |

Place tests under `tests/classifier/` and adjacent paths as fits.

## Minimal implementation

- `TmuxPort.is_alive`.
- Session-log collection through artifact store.
- Signal-file validation + crash-safe ingestion (read → write
  artifact + state + event in one tick → delete signal file).
- Fake remote SHA + PR-existence reads (extend `GitHubPort` fake).
- Classifier shared between normal dead-session path and spawn-window
  recovery (`tmux_session IS NULL`).
- The exact failpoints listed in the plan
  (`after_blocker_artifact_write`, `after_blocker_state_commit`,
  `after_tmux_session_created`) live behind a test-only hook
  registry. They must be no-ops by default.

## Done criteria

- Classifier writes exactly one terminal transition per worker
  outcome.
- Blocker artifacts dedupe across crash recovery.
- Local-only commits do not count as PR progress.
- All eight tests pass; suite green; typecheck green.

## Hard rules

- Spec and plan are read-only.
- Do not implement deterministic retry composition (templates),
  claim, cancel, Slack, PR polling, or CLI.
- Use fakes only.
- Do not touch `src/cli/`.
- Do not modify `docs/ralph/` outside `blockers/`; do not modify
  `scripts/`.
- Test names must match the table exactly.

Spec gap → `docs/ralph/blockers/SPEC-GAP-slice-4-<slug>.md`, stop.

## Working loop

1. `bun test` → first failing assertion.
2. `bun run typecheck`.
3. Smallest change toward green.
4. Re-run.

Prior gate feedback (if any) appended below.
