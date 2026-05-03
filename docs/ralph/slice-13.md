# Slice 13: `quay-config` fenced-block parser

## Required reading

1. `docs/quay-spec-deployment-adapters.md` §10 — **the authority for
   this slice**. Describes the fenced-block contract end-to-end: format,
   fields table, parsing rule (steps 1-6), block-strip rule.
2. `docs/quay-spec-deployment-adapters.md` §6 — composition rules
   that consume the parser output (`TicketContext.tags`, `.authors`,
   `.slack_thread_ref`).
3. `docs/ralph/RUNBOOK.md`.

## Goal

Ship the pure parser that turns a Linear ticket body into a
structured `QuayConfigBlock | null`. After this slice:

- Given a body string, the parser locates **exactly one**
  `quay-config` fence (rejecting zero or multiple fences appropriately
  — see §10 step 1).
- Parses the YAML inside.
- Validates field types (`tags: string[]`, `slack_thread: string?`,
  `authors: {name, slack_id}[]`).
- Converts `slack_thread` URL → `<channel>:<ts>` per the regex in
  §10 step 4.
- Validates each `authors[i].slack_id` matches the bare-`U...` regex
  per §10 step 5.
- Returns a typed result; throws `QuayError("ticket_block_invalid",
  ..., { detail })` on any failure mode.

The parser is **purely textual**: no Linear API calls, no Slack API
calls, no I/O. It's a function over a string.

This slice does **not** implement `ticketContext.fetch`, the Linear
adapter, or the Slack `fetchThreadContext` extension. Those land in
slices 14–17.

## Red tests (must exist with these names and must pass)

Place tests under `tests/quay_config_block/`. Test names match this
table exactly.

| Test name | Proves |
|---|---|
| `test_quay_config_block_parses_tags_and_slack_thread` | Well-formed block returns parsed `tags` list and converted `slack_thread_ref`. |
| `test_quay_config_block_returns_null_when_block_missing` | Ticket body without a `quay-config` fence → parser returns `null` (no error; downstream layer treats absence as a validator-level concern). |
| `test_quay_config_block_errors_on_malformed_yaml` | Block fence present but YAML inside is invalid → `ticket_block_invalid` with `detail` containing parse hint. |
| `test_quay_config_block_errors_on_unknown_required_field_type` | `tags` not a list, `slack_thread` not a string → `ticket_block_invalid`. |
| `test_quay_config_block_ignores_unknown_keys` | Extra keys (`preamble_override: ...` before that field exists) don't fail parsing — forward-compat. |
| `test_quay_config_block_decodes_slack_p_format_correctly` | `p1700000123000001` → `1700000123.000001`, encoded as `<channel>:<ts>`. |
| `test_quay_config_block_errors_on_malformed_slack_url` | `slack_thread` present but not matching the expected URL pattern → `ticket_block_invalid` with `detail: "slack_thread URL malformed"`. |
| `test_quay_config_block_rejects_duplicate_blocks` | Two `quay-config` fences in the body → `ticket_block_invalid` with `detail` mentioning "multiple quay-config blocks". |
| `test_quay_config_block_strips_from_brief` | A separate helper (or part of the parser API) returns the body with the fenced block removed; original body retained for archival callers. |
| `test_quay_config_block_parses_authors_in_order` | Block with `authors: [{name: A, slack_id: U001}, {name: B, slack_id: U002}]` → result preserves declaration order exactly. |
| `test_quay_config_block_errors_on_empty_authors` | `authors: []` → `ticket_block_invalid` (min one entry required). |
| `test_quay_config_block_errors_on_malformed_slack_id` | `authors[0].slack_id = "@fabian"` (not bare `U...` format) → `ticket_block_invalid` with `detail` referencing `authors[0].slack_id`. |
| `test_quay_config_block_errors_on_missing_authors` | Block missing the `authors:` key entirely → `ticket_block_invalid` (required field). |

## Minimal implementation

- `src/core/quay_config_block.ts` exports:
  - `parseQuayConfigBlock(body: string): QuayConfigBlock | null` —
    primary entry. `null` when no fence found; throws on malformed
    block.
  - `stripQuayConfigBlock(body: string): string` — returns body with
    the fence removed.
  - Types `QuayConfigBlock`, `QuayConfigAuthor` per the structures in
    §10's fields table.
- A YAML parser dependency (or a tiny hand-roll if the block's YAML
  surface is small enough — implementer's choice; YAML library is
  fine).
- Slack URL → `<channel>:<ts>` conversion logic per §10 step 4.
- Slack-ID regex per §10 step 5.
- Errors thrown as `QuayError("ticket_block_invalid", ..., { detail })`
  matching the existing `QuayError` shape (`src/core/errors.ts`).

## Done criteria

- All 13 red tests pass.
- The parser is pure (no I/O, no Linear or Slack calls).
- `bun test` is green (full suite).
- `bun run typecheck` is green.
- No other layer (ticketContext.fetch, Linear adapter, enqueue CLI)
  has been touched in this slice.

## Hard rules

- Do not modify the spec docs. Spec gap →
  `docs/ralph/blockers/SPEC-GAP-slice-13-<slug>.md`, stop.
- Do not modify `docs/ralph/` outside `blockers/`.
- Do not modify `scripts/`.
- Do not implement `ticketContext.fetch`, the Linear adapter,
  the Slack extension, or any CLI changes.
- Do not validate tag charset at the parser layer (per §17 resolution:
  validator owns tag-shape rules, parser stays thin).
- Test names must match the table exactly.

## Working loop

1. `bun test` → first failing assertion.
2. `bun run typecheck`.
3. Smallest change toward green.
4. Re-run.

Prior gate feedback (if any) appended below.
