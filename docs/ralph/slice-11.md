# Slice 11: Ticket Validator (core + CLI + default schema)

You are working on Quay, a Bun + TypeScript task lifecycle service.
This prompt is the unattended driver's input for one slice attempt.
Read the referenced files at the start of every attempt — your context
starts fresh each time.

## Required reading (every attempt)

1. `docs/quay-spec-ticket-validation.md` — **the authority for this
   slice**. Read end-to-end. Sections most load-bearing: §3
   (architecture), §4 (CLI), §5 (library), §6 (schema config + default
   schema), §7 (validation rules), §9 (test plan).
2. `docs/quay-spec.md` §3 (substrate boundary).
3. `docs/ralph/RUNBOOK.md` — operating rules.

If this prompt and the spec disagree, the spec wins.

## Goal

Ship `quay validate-ticket` — the deterministic, pure validator
described in the validator spec. After this slice:

- A `validateTicket(payload, schema)` library function returns
  `{ valid, errors[] }`.
- `loadSchema(path)` parses a TOML schema file into the in-memory
  `TicketSchema` shape.
- The CLI `quay validate-ticket` accepts JSON on stdin or via
  `--ticket-json <path>`, reads the schema from
  `${QUAY_CONFIG_DIR:-$HOME/.quay}/ticket_schema.toml` (or via
  `--schema-file`), and prints the structured result with stable exit
  codes 0 / 1 / 2 / 3.
- The shipped default schema (`config/ticket_schema.toml` or
  similar — implementation choice) matches §6 of the validator spec
  exactly.

No Linear adapter. No Slack adapter. No `quay-config` block parsing
(that's slice 13). The validator never touches the network or the
filesystem outside the schema-file read.

## Red tests (must exist with these names and must pass)

Place tests under `tests/validator/`. Test names match the validator
spec §9 exactly.

| Test name | Proves |
|---|---|
| `test_validate_ticket_passes_well_formed_input` | Valid input + default schema → `{valid: true}`, exit 0. |
| `test_validate_ticket_fails_on_missing_required_field` | Missing required field → `MISSING` error, exit 1. |
| `test_validate_ticket_fails_on_type_mismatch` | Wrong JSON type for a field → `TYPE` error, exit 1. |
| `test_validate_ticket_fails_on_pattern_mismatch` | String fails its regex → `PATTERN` error, exit 1. |
| `test_validate_ticket_fails_on_charset_violation` | String fails charset → `CHARSET` error, exit 1. |
| `test_validate_ticket_fails_on_min_count` | Empty list where min_count > 0 → `MIN_COUNT` error, exit 1. |
| `test_validate_ticket_fails_on_duplicate_when_unique` | Duplicate items in unique list → `DUPLICATE` error, exit 1. |
| `test_validate_ticket_fails_on_enum_invalid_value` | Value outside enum → `ENUM` error, exit 1. |
| `test_validate_ticket_reports_multiple_errors_simultaneously` | Three independent field violations → all three errors in one response, exit 1. |
| `test_validate_ticket_emits_dotted_field_paths_for_nested_errors` | Nested object/list error → field path includes `.` and `[i]` correctly. |
| `test_validate_ticket_optional_field_absent_does_not_error` | Optional field omitted → no error. |
| `test_validate_ticket_optional_field_present_is_validated` | Optional field present but malformed → error, exit 1. |
| `test_validate_ticket_unknown_field_is_silently_ignored` | Input contains a field not in the schema → no error (default mode). |
| `test_validate_ticket_loads_schema_from_default_path` | No `--schema-file` flag → reads `${QUAY_CONFIG_DIR}/ticket_schema.toml`. |
| `test_validate_ticket_accepts_schema_file_override` | `--schema-file <path>` → loads from override path. |
| `test_validate_ticket_supports_ticket_json_stdin` | `--ticket-json -` (or no flag) → reads stdin. |
| `test_validate_ticket_supports_ticket_json_file` | `--ticket-json <path>` → reads file. |
| `test_validate_ticket_exits_2_on_missing_schema_file` | Schema file does not exist → exit 2, error JSON on stderr. |
| `test_validate_ticket_exits_2_on_malformed_schema_toml` | Schema TOML is unparseable → exit 2, error JSON on stderr. |
| `test_validate_ticket_exits_3_on_malformed_input_json` | Input is not valid JSON → exit 3, error JSON on stderr. |
| `test_validate_ticket_quiet_flag_suppresses_stdout` | `--quiet` set → no stdout output, exit code unchanged. |
| `test_validate_ticket_library_pure_for_same_inputs` | Library function returns identical results for identical inputs (no mutation, no I/O). |
| `test_validate_ticket_hermes_first_draft_missing_tags_fails` | The validator-spec §8.1 first-draft input → exactly one `tags(MIN_COUNT)` error, then the corrected draft passes. Asserts the primary-use-case loop end-to-end. |

## Minimal implementation

- `src/validator/types.ts` — `ValidationError`, `ValidationResult`,
  `TicketSchema`, `FieldSchema` types per validator spec §5.
- `src/validator/load_schema.ts` — `loadSchema(path) → TicketSchema`.
  Parses TOML, compiles regex patterns once.
- `src/validator/validate.ts` — `validateTicket(payload, schema) →
  ValidationResult`. Pure function. Implements §7 evaluation order:
  presence → type → type-specific checks → recursive checks. Collects
  all errors; never fail-fast.
- `src/validator/charsets.ts` — `any` / `lowercase_alphanum_dash` /
  `ascii_printable` per §6.
- `src/cli/validate_ticket.ts` (or extend `src/cli/dispatch.ts`) —
  CLI wrapper.
- Default schema shipped at e.g. `config/ticket_schema.toml`,
  resolved by the runtime as `${QUAY_CONFIG_DIR:-$HOME/.quay}/`-rooted
  override or fallback to the shipped default.

The default schema **must match validator spec §6 exactly**: required
fields `body`, `tags`, `authors` (list of `{name, slack_id}` with
bare `^U[A-Z0-9]+$` pattern); optional `slack_thread`, `external_ref`.
No `quay_marker`.

## Done criteria

- The CLI is invokable: `echo '{...}' | quay validate-ticket` returns
  the right exit code and JSON output.
- All 23 red tests pass with the names listed.
- `bun test` is green (full suite, no regressions).
- `bun run typecheck` is green.
- The default schema is shipped in the repo and used as the fallback
  when no override is configured.

## Hard rules

- Do not modify the spec docs. Spec gap → write
  `docs/ralph/blockers/SPEC-GAP-slice-11-<slug>.md`, stop.
- Do not modify `docs/ralph/` outside `blockers/`.
- Do not modify `scripts/`.
- Do not implement the Linear adapter, Slack `fetchThreadContext`
  extension, the `quay-config` block parser, or the
  `quay enqueue --linear-issue` CLI. Those are slices 13, 14, and 16.
- The validator function must remain pure: no clock, no random, no
  network, no filesystem reads inside `validateTicket()`. The CLI
  wrapper is the only place that does I/O.
- Test names must match the table exactly.

## Working loop

1. `bun test` → first failing assertion.
2. `bun run typecheck`.
3. Smallest change toward green.
4. Re-run.

Prior gate feedback (if any) appended below.
