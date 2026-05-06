# Slice 16: `quay enqueue --linear-issue` CLI + atomicity

## Required reading

1. `docs/quay-spec-deployment-adapters.md` §3 — atomicity invariant.
2. `docs/quay-spec-deployment-adapters.md` §8 — `quay enqueue
   --linear-issue` behavior steps. **The authority for this slice.**
3. `docs/quay-spec-deployment-adapters.md` §11 — validator
   integration shape (child-process invocation; explicit payload
   mapping).
4. `docs/quay-spec-deployment-adapters.md` §12 — failure modes table
   (every error code that can surface from this CLI).
5. `docs/quay-spec-deployment-adapters.md` §13 — worked example
   (Step 1 → Step 3 are the contract for this slice).
6. `src/core/enqueue.ts` and `src/cli/dispatch.ts` — the existing
   substrate this slice extends.
7. `docs/ralph/RUNBOOK.md`.

## Goal

Wire the new CLI surface and integrate `fetchTicketContext` (slice
15) with the existing `enqueue` core function. After this slice:

- `quay enqueue --linear-issue ENG-1234 --repo iTRY-monorepo`
  works end-to-end against the test fakes.
- The atomicity invariant is enforced in code: `fetchTicketContext
  → validate-ticket (child process) → enter existing enqueue`.
  Substrate side-effects (worktree, branch, DB writes, artifacts)
  start only on `valid: true`.
- `task_tags` rows + `tasks.authors_json` are populated **inside the
  same transaction** as the existing enqueue's writes.
- Mutually-exclusive flag handling: `--linear-issue` rejects
  `--brief-file`, `--external-ref`, `--slack-thread-ref` as usage
  errors before any adapter call.
- `--tag <name>` (existing) unions with the block's `tags:` list,
  deduped.
- The validator payload mapping per §11 is explicit: `body` from
  the raw Linear ticket body (block intact), `tags` / `authors` /
  `external_ref` straight pass-through, `slack_thread` conditionally
  included.

## Red tests (must exist with these names and must pass)

Place tests under `tests/cli/` (matching slice-10's location pattern)
and `tests/enqueue/`. Test names match this table exactly.

| Test name | Proves |
|---|---|
| `test_enqueue_linear_issue_end_to_end` | Full flow against fake Linear + Slack: ticket fetched, thread fetched, validator runs, task inserted, two `task_tags` rows inserted, `tasks.authors_json` populated, `slack_thread_ref` populated. Returns the standard enqueue JSON shape. |
| `test_enqueue_linear_issue_validation_failure_writes_no_db_state` | Validator returns `{valid: false}` → no rows in `tasks`, `task_tags`, or `artifacts`. CLI exits non-zero with the validator's `errors[]` on stdout. |
| `test_enqueue_linear_issue_combines_with_cli_tags` | `--linear-issue ENG-1276 --tag urgent` → `task_tags` rows are union of `quay-config.tags` + `urgent`, deduped. |
| `test_enqueue_linear_issue_idempotent_on_external_ref` | Second call with same `--linear-issue` returns the same `task_id` (substrate enqueue's idempotency on `(repo_id, external_ref)`). |
| `test_enqueue_linear_issue_mutually_exclusive_with_brief_file` | `--linear-issue ENG-1276 --brief-file foo.md` → usage error before any adapter call (no network, no DB). |
| `test_enqueue_linear_issue_mutually_exclusive_with_external_ref` | `--linear-issue ENG-1276 --external-ref FOO-99` → usage error before any adapter call. |
| `test_enqueue_linear_issue_mutually_exclusive_with_slack_thread_ref` | `--linear-issue ENG-1276 --slack-thread-ref C111:222.333` → usage error before any adapter call. |
| `test_enqueue_brief_file_form_unchanged_when_adapters_disabled` | The existing `--brief-file` form behaves identically with both adapters off (no regression). |
| `test_enqueue_linear_issue_atomicity_failure_before_substrate` | Linear fetch fails after the dispatch parses flags → no worktree directory created, no git branch, no DB rows. Confirms the §3 invariant. |
| `test_enqueue_linear_issue_validator_payload_passes_authors_through` | The validator payload built from `TicketContext` has `authors` exactly equal to `TicketContext.authors` (no field-shape munging). Per §11. |
| `test_enqueue_linear_issue_validator_payload_omits_slack_thread_when_null` | When `slack_thread_ref` is `null`, the validator payload does not include the `slack_thread` field at all (rather than passing `null`). |
| `test_enqueue_linear_issue_invokes_validator_as_child_process` | The validator runs as a child process (`spawn`), not as an in-process library call. Confirm via the CLI integration test pattern from slice 11. |
| `test_enqueue_linear_issue_fails_when_ticket_has_no_quay_config_block` | Ticket body lacks a `quay-config` fence → CLI returns `ticket_block_invalid` error, no DB writes, validator is not invoked. |

## Minimal implementation

- `src/cli/dispatch.ts` — extend the `enqueue` subcommand:
  - Detect `--linear-issue` and route to a new path.
  - Reject conflicting flags (`--brief-file`, `--external-ref`,
    `--slack-thread-ref`) with `usage_error`.
  - Allow `--tag` (existing) to layer on top.
- New file (e.g., `src/cli/enqueue_linear_issue.ts`) that orchestrates:
  1. Resolve repo config (existing).
  2. `fetchTicketContext({linear, slack, config}, identifier)` — slice 15.
  3. Build validator payload per §11 mapping.
  4. Spawn `quay validate-ticket` child process; pipe payload to stdin;
     parse exit code + stdout.
  5. On `valid: false` → emit error JSON to stdout, exit non-zero.
  6. On `valid: true` → call existing `enqueue` core function with
     `brief = TicketContext.brief`, `ticket_snapshot =
     TicketContext.ticket_snapshot`, `slack_thread_ref =
     TicketContext.slack_thread_ref`, `external_ref =
     TicketContext.external_ref`.
  7. Inside the same transaction as the substrate enqueue's writes,
     insert `task_tags` rows for `TicketContext.tags ∪ --tag <name>`
     (deduped) and populate `tasks.authors_json` with
     `JSON.stringify(TicketContext.authors)`.
- Extend `enqueue` core function (`src/core/enqueue.ts`) to accept
  `tags: string[]` and `authors_json: string | null` parameters
  (back-compat: both default to empty / null on the legacy
  `--brief-file` path).
- Wire the in-process Linear + Slack fakes (slice 14) into the test
  harness for end-to-end testing without real APIs.

## Done criteria

- All 13 red tests pass.
- The existing slice-1 `--brief-file` enqueue tests still green.
- `bun test` is green (full suite).
- `bun run typecheck` is green.
- The atomicity invariant is enforceable: a failing test simulating
  Linear fetch failure proves no substrate side-effects start.

## Hard rules

- Do not modify the spec docs. Spec gap →
  `docs/ralph/blockers/SPEC-GAP-slice-16-<slug>.md`, stop.
- Do not modify `docs/ralph/` outside `blockers/`.
- Do not modify `scripts/`.
- Do not implement the real Linear adapter (slice 17) or the real
  Slack `fetchThreadContext` (slice 18). Use the slice-14 fakes.
- Do not implement the escalation @-mention behavior (slice 19).
- Do not promote the validator from CLI to library (it stays a
  child process per §17 / §11).
- Test names must match the table exactly.

## Working loop

1. `bun test` → first failing assertion.
2. `bun run typecheck`.
3. Smallest change toward green.
4. Re-run.

Prior gate feedback (if any) appended below.
