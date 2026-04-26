# Slice 7: Cancel Finalizer

## Required reading

1. `docs/quay-spec.md` — §4 (terminals: `cancelled`,
   `closed_unmerged`), §5 (cancel handling), §10 (`quay cancel`),
   §14 (invariants on durable intent + crash recovery).
2. `docs/quay-tdd-implementation-plan.md` — Slice 7 is the authority.
3. `docs/ralph/RUNBOOK.md`.

## Goal

Cancellation is a durable task-level intent (`tasks.cancel_requested_at`)
with a single canonical cancel finalizer used by both the CLI path
and tick recovery. The cleanup matrix per source state is honored
(local branch/worktree always; remote branch retained when an open PR
exists; PR closure on opt-in). Crash after irreversible side effects
(PR close + remote branch delete) cannot misclassify the task as
`closed_unmerged`.

## Red tests (must exist with these names and must pass)

| Test name | Proves |
|---|---|
| `test_029a_cancel_crash_after_intent_recovers_from_running` | After durable cancel intent + tmux kill, a crash before SQL terminal transition is resumed by the next tick to drive the running task to `cancelled`. |
| `test_029c_cancel_close_pr_crash_after_irreversible_side_effects` | If `cancel --close-pr` closes the PR and deletes the remote branch but crashes before SQL terminal transition, recovery resumes cancellation; never `closed_unmerged`. |
| `test_029e_cancel_waiting_human_preserves_slack_artifact` | Cancelling `waiting_human` preserves the pending Slack escalation artifact, does not unpost Slack, transitions to `cancelled`. |
| `test_031c_cancel_races_mid_spawn_converges` | Cancel racing a tick that promoted a queued task and is spawning tmux: the supervisor lock serializes side effects; the finalizer kills any newly spawned worker before marking `cancelled`. |
| `test_081_cancel_with_open_pr_retains_remote_branch` | Default cleanup removes local branch + worktree but retains the remote branch when a PR is currently open. |
| `test_026_cancel_terminal_state_semantics` | Cancel on `cancelled` is idempotent no-op success; cancel on `merged` or `closed_unmerged` returns `wrong_state` without SQL writes or side effects. |
| `test_029f_cancel_parked_state_runs_cleanup` | Cancelling `worktree_error`, `orchestrator_loop`, or `non_budget_loop` writes durable intent, applies normal cancelled cleanup, transitions to `cancelled`. |

Place tests under `tests/cancel/`.

## Minimal implementation

- Supervisor-lock abstraction shared between `tick_once` and cancel
  paths so promotion + cancel cannot both run side effects on the
  same task.
- `cancel_task(...)` that writes `cancel_requested_at` + appropriate
  `kill_intent` and returns; the finalizer is a separate function.
- Single canonical cancel finalizer used by both the synchronous CLI
  path (after intent commit) and tick recovery.
- Fake `GitHubPort.close_pr` and fake `GitPort.delete_remote_branch`.
- Honor failpoints: `after_cancel_intent_commit`,
  `after_github_pr_close`.

## Done criteria

- Cancellation from every non-terminal state converges to `cancelled`.
- Crash after external cleanup cannot be misclassified as
  `closed_unmerged`.
- Re-running cancel on `cancelled` is a no-op success.
- All seven tests pass; suite green; typecheck green.

## Hard rules

- Spec and plan are read-only.
- Do not implement Slack posting, PR polling, or CLI.
- Use fakes only.
- Do not touch `src/cli/`.
- Do not modify `docs/ralph/` outside `blockers/`; do not modify
  `scripts/`.
- Test names must match the table exactly.

Spec gap → `docs/ralph/blockers/SPEC-GAP-slice-7-<slug>.md`, stop.

## Working loop

1. `bun test` → first failing assertion.
2. `bun run typecheck`.
3. Smallest change toward green.
4. Re-run.

Prior gate feedback (if any) appended below.
