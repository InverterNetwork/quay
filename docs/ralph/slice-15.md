# Slice 15: `ticketContext.fetch` + canonical brief composer

## Required reading

1. `docs/quay-spec-deployment-adapters.md` §6 — `TicketContext`
   primitive (interface, composition rules, failure modes).
2. `docs/quay-spec-deployment-adapters.md` §6.1 — **canonical brief
   format** (the contract surface for the worker preamble).
3. `docs/quay-spec-deployment-adapters.md` §3 — atomicity invariant
   (`fetchTicketContext → validate → enter enqueue`).
4. `docs/quay-spec-deployment-adapters.md` §17 — resolved open
   questions, in particular field-set, atomicity, and brief
   composer location (private helper inside `fetchTicketContext`).
5. `docs/ralph/RUNBOOK.md`.

## Goal

Land the composition layer that turns a Linear identifier into a
`TicketContext`. After this slice:

- `src/core/ticket_context.ts` exports
  `fetchTicketContext(deps, identifier) → TicketContext`.
- The function uses the `LinearPort` and `SlackPort` (from slice 14
  fakes) and the `quay-config` block parser (from slice 13).
- Brief composition lives as a **private helper inside the same
  file** (per §17 resolution: no separate brief-composer module).
- The brief output matches the canonical §6.1 format exactly:
  fixed section order (`# title`, `## Contributors`, `## Ticket
  Context`, `## Ticket Comments`, `## Slack Context`); omitted
  sections close ranks; the `quay-config` block is stripped from
  Ticket Context; bot-authored Linear comments are filtered.
- All failure modes from §6 surface as the documented `QuayError`
  shapes.

This slice does **not** include the `quay enqueue --linear-issue`
CLI surface (slice 16) or the validator subprocess invocation
(slice 16).

## Red tests (must exist with these names and must pass)

Place tests under `tests/ticket_context/`. Test names match this
table exactly.

| Test name | Proves |
|---|---|
| `test_fetch_ticket_context_assembles_full_brief_when_both_adapters_enabled` | Linear ticket + Slack thread → composed brief contains both, in canonical section order. |
| `test_fetch_ticket_context_omits_slack_section_when_no_thread_ref_parsed` | Block has no `slack_thread:` → brief has no `## Slack Context` heading at all (no placeholder). |
| `test_fetch_ticket_context_degrades_when_slack_disabled_but_link_parsed` | Block carries a Slack link but `[adapters.slack].enabled = false` → `slack_thread_ref = null`, brief has no Slack Context section, no error raised. |
| `test_fetch_ticket_context_fails_closed_when_linear_disabled` | `[adapters.linear].enabled = false` → throws `adapter_not_enabled`. |
| `test_fetch_ticket_context_fails_closed_on_linear_api_error` | Linear adapter throws 5xx → `adapter_error{adapter:"linear"}` propagates. |
| `test_fetch_ticket_context_fails_closed_on_slack_fetch_error_when_enabled` | Block has Slack thread, Slack adapter enabled, Slack fetch throws → `adapter_error{adapter:"slack"}` propagates. |
| `test_fetch_ticket_context_returns_tags_in_block_order` | The block's `tags:` list preserves order through to `TicketContext.tags`. |
| `test_fetch_ticket_context_returns_authors_in_block_order` | `TicketContext.authors` preserves block declaration order (most-involved first). |
| `test_fetch_ticket_context_includes_user_comments_in_brief` | Linear ticket with two non-bot comments → brief contains a `## Ticket Comments` section with both, in chronological order, with author names + ISO timestamps. |
| `test_fetch_ticket_context_omits_comments_section_when_no_user_comments` | Linear ticket with zero user comments (or only bot comments) → brief has no `## Ticket Comments` heading. |
| `test_fetch_ticket_context_filters_bot_comments_from_brief` | Linear ticket with a bot-authored integration comment + one user comment → brief shows only the user comment; `ticket_snapshot` archives both. |
| `test_fetch_ticket_context_brief_section_order_is_canonical` | Sections appear in the order: Contributors → Ticket Context → Ticket Comments → Slack Context. Omitted sections close ranks. |
| `test_fetch_ticket_context_strips_quay_config_block_from_brief` | The `## Ticket Context` section omits the `quay-config` fenced block; the original body (block intact) is preserved in `ticket_snapshot`. |
| `test_fetch_ticket_context_404_surfaces_as_ticket_not_found` | Linear adapter returns `null` (404) → throws `ticket_not_found`. |
| `test_fetch_ticket_context_block_invalid_propagates` | Linear ticket body has malformed `quay-config` → throws `ticket_block_invalid` with `detail`. |
| `test_fetch_ticket_context_block_missing_returns_error` | Linear ticket body has no `quay-config` fence → throws `ticket_block_invalid` with `detail: "no quay-config block found in ticket body"`. |

## Minimal implementation

- `src/ports/ticket_context.ts` — `TicketContext` and `TicketAuthor`
  types per spec §6.
- `src/core/ticket_context.ts`:
  - Public: `fetchTicketContext(deps, identifier) → TicketContext`.
  - Private helper: `composeBrief(...) → string` (the §6.1 contract).
  - Private helper: `composeTicketSnapshot(...) → string` (full
    archival JSON: `LinearIssue` + parsed block + Slack thread).
- Wire to existing `LinearPort` (slice 14), `SlackPort.fetchThreadContext`
  (slice 14), and `parseQuayConfigBlock` (slice 13).
- Failure modes per §6 — including the explicit "block missing →
  `ticket_block_invalid`" rule (slice 13's parser returns `null` for
  missing; this slice promotes that to an error since the adapter
  path requires a block).

## Done criteria

- All 16 red tests pass.
- `bun test` is green (full suite).
- `bun run typecheck` is green.
- No CLI changes yet.
- The brief output is byte-for-byte stable and matches §6.1.

## Hard rules

- Do not modify the spec docs. Spec gap →
  `docs/ralph/blockers/SPEC-GAP-slice-15-<slug>.md`, stop.
- Do not modify `docs/ralph/` outside `blockers/`.
- Do not modify `scripts/`.
- Do not implement the `quay enqueue --linear-issue` CLI (slice 16)
  or the real Linear/Slack adapters (slices 17/18).
- Do not invoke the validator from inside `fetchTicketContext`. The
  validator runs *after* `fetchTicketContext` returns, in the CLI
  layer (slice 16 wires that).
- Brief composer must live as a private helper in
  `src/core/ticket_context.ts`, not as a separate module.
- Test names must match the table exactly.

## Working loop

1. `bun test` → first failing assertion.
2. `bun run typecheck`.
3. Smallest change toward green.
4. Re-run.

Prior gate feedback (if any) appended below.
