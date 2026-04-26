# Slice 10: CLI and Real Adapter Contracts

## Required reading

1. `docs/quay-spec.md` — §10 (CLI surface), §11 (Hermes seam), §12
   (worker spawning: tmux, agent process), §13 (configuration).
2. `docs/quay-tdd-implementation-plan.md` — Slice 10 is the authority.
3. `docs/ralph/RUNBOOK.md`.

## Goal

Wire the CLI as a thin layer over the core service API. Stable JSON
output shape for read commands. Real tmux + git adapter contracts
satisfy the same port contracts the fakes did. GitHub and Slack
adapter contract tests are gated behind explicit integration-test
configuration (do not require credentials by default).

## Red tests (must exist with these names and must pass)

| Test name | Proves |
|---|---|
| `test_070_task_list_empty_returns_json_array` | `quay task list` emits a JSON array; no matches emit literal `[]`. |
| `test_071_task_get_returns_object` | `quay task get <id>` emits a single JSON object containing task state, current attempt, recent events. |
| `test_072_tick_outputs_ndjson` | `quay tick` emits one JSON object per touched task as NDJSON; each line parses independently. |
| `test_084_external_ref_is_slugged_before_use` | Adversarial `external_ref` is normalized before use in branch/tmux identifiers; verbatim value preserved in SQL. |
| `test_086_install_cmd_runs_through_shell` | The real command adapter runs operator-controlled `install_cmd` through `/bin/sh -c`, preserving shell expansion + chaining. |
| `test_tmux_adapter_session_exits_when_agent_exits` | The real tmux adapter uses `exec sh -c` so the session disappears when the agent process exits, preserving liveness detection. |
| `test_git_adapter_branch_slug_final_check_ref_format` | The real git adapter enforces the final `git check-ref-format` gate and falls back to `task-<id>` if normalization produces an invalid ref. |
| `test_cli_write_errors_are_json_objects` | Failed write commands exit non-zero and emit a JSON object with an `error` field on stderr. |

Place tests under `tests/cli/` and `tests/adapters/`.

## Minimal implementation

- CLI parser + dispatch using `commander` (or a tiny hand-roll if
  cleaner).
- JSON output discipline: `task list` → array; `task get` → object;
  `tick` → NDJSON; write errors → `{ "error": "...", ... }` on stderr
  with non-zero exit.
- Real `TmuxPort` using Bun subprocess + `tmux new-session -d -s
  <session> 'exec sh -c "<cmd>"'`.
- Real `GitPort` for clone/fetch/worktree/branch operations on local
  repos. Final `git check-ref-format` gate before any branch op.
- Real `CommandRunner` that runs `install_cmd` through `/bin/sh -c`.
- GitHub + Slack adapters: stubs that compile and have contract
  tests skipped unless `QUAY_INTEGRATION_TESTS=1` (or similar) is
  set in the environment. The default `bun test` run must remain
  green without credentials.

## Done criteria

- Service behavior is reachable through documented commands.
- Read commands have stable JSON shape.
- Real tmux + git adapters satisfy the same contracts proven by
  fakes in earlier slices.
- All eight tests pass; suite green; typecheck green.
- Integration-only tests are gated and skipped by default.

## Hard rules

- Spec and plan are read-only.
- Do not modify `docs/ralph/` outside `blockers/`; do not modify
  `scripts/`.
- Real adapters must not run during the default test command. Use
  `test.skipIf` or environment-gated `describe` blocks.
- Test names must match the table exactly.

Spec gap → `docs/ralph/blockers/SPEC-GAP-slice-10-<slug>.md`, stop.

## Working loop

1. `bun test` → first failing assertion.
2. `bun run typecheck`.
3. Smallest change toward green.
4. Re-run.

Prior gate feedback (if any) appended below.
