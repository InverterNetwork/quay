# Slice 2: Enqueue Schedules Attempt 1

You are working on Quay. Read context fresh every attempt.

## Required reading

1. `docs/quay-spec.md` — read-only. Sections: §4 (lifecycle), §6
   (worker contract; brief/preamble structure), §7 (brief
   composition), §8 (artifacts), §9 (persistence). Branch slug rules
   are in §12 / §14.
2. `docs/quay-tdd-implementation-plan.md` — Slice 2 is the authority.
3. `docs/ralph/RUNBOOK.md`.

## Goal

`enqueue(...)` does not spawn. It performs synchronous bootstrap
(clone-or-reuse bare, fetch base branch, create worktree, run
`install_cmd`), creates a `queued` task with attempt #1 (pending,
`spawned_at = NULL`), and produces exactly one `brief` and one
`final_prompt` artifact for that attempt. Bootstrap failure aborts
cleanly with no committed task or partial side effects.

## Red tests (must exist with these names and must pass)

| Test name | Proves |
|---|---|
| `test_055_enqueue_fresh_repo_bootstraps_and_queues_task` | First enqueue clones bare, fetches base, creates worktree, runs install, creates queued task + attempt #1; tmux is not touched. |
| `test_056_enqueue_existing_repo_reuses_bare_clone_and_fetches` | Existing bare clone is reused; fetch + worktree + install still run; new task queued. |
| `test_057_enqueue_bootstrap_failure_leaves_no_task_row` | Clone/worktree/install/artifact/DB failure aborts enqueue and leaves no committed task or pending attempt; partial worktree/branch/artifacts are cleaned up. |
| `test_065_initial_attempt_has_brief_and_final_prompt` | Attempt #1 has exactly one `brief` and one `final_prompt`; `ticket_snapshot` is task-level; `final_prompt` content is preamble + brief. |
| `test_039_branch_slug_examples` | Branch names follow git-safe slug rules for normal/path-like/missing/empty-normalized `external_ref`; verbatim `external_ref` is preserved in SQL. |
| `test_040_branch_collision_adds_task_suffix` | If preferred branch is already taken locally/remotely/by an open PR, enqueue appends `-<task_id_short>` and re-checks. |
| `test_041_enqueue_rejects_unknown_or_archived_repo` | Unknown or archived repos reject enqueue before any git/install/artifact/task side effects. |

Place tests under `tests/enqueue/` and `tests/branches/` as fits.

## Minimal implementation

- `enqueue(...)` service entry point in `src/core/`.
- Fake `GitPort` for clone/fetch/branch checks/worktree add+remove/branch
  delete (under `tests/support/fakes/git.ts`).
- Fake `CommandRunner` for `install_cmd` (under
  `tests/support/fakes/command_runner.ts`).
- Branch slug normalization (git-safe) and tmux identifier
  normalization.
- Persist task row, attempt #1 (pending), `ticket_snapshot` artifact
  (task-level), `brief` and `final_prompt` artifacts (attempt-level).
- Rollback path that removes worktree, deletes branch, removes
  artifacts on bootstrap or DB failure.

Add migrations only if Slice 0/1 schema is insufficient. Number them
`0003_*.sql` and after.

## Done criteria

- Enqueue returns a queued task; no tmux session is created.
- Rollback is observable in the fake ports' state on failure paths.
- The first attempt is pending with `spawned_at = NULL`.
- All seven tests pass; full `bun test` green; `bun run typecheck`
  green.

## Hard rules

- Do not edit `docs/quay-spec.md` or the implementation plan.
- Do not implement tick promotion, capacity checks, claim, cancel,
  Slack, or any Slice 3+ behavior.
- Do not introduce real adapters; fakes only.
- Do not touch `src/cli/`.
- Do not modify `docs/ralph/` outside `blockers/`. Do not modify
  `scripts/`.
- Test names must match the table exactly.

If you discover a spec gap, write
`docs/ralph/blockers/SPEC-GAP-slice-2-<slug>.md` and stop without
emitting the completion promise.

## Working loop

1. `bun test` → first failing assertion is the next target.
2. `bun run typecheck`.
3. Smallest change toward green.
4. Re-run; confirm no regression.

Prior gate feedback (if any) is appended below — treat it as
authoritative diagnosis.
