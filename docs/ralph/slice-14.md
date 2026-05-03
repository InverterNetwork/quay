# Slice 14: `LinearPort` + `SlackPort.fetchThreadContext` (interfaces + fakes)

## Required reading

1. `docs/quay-spec-deployment-adapters.md` §7 — **the authority for
   this slice**. Defines `LinearPort`, the lean `LinearIssue` field
   set, `SlackThread` / `SlackThreadMessage`, and the
   `fetchThreadContext` semantics (including pagination cap +
   truncation marker).
2. `docs/quay-spec-deployment-adapters.md` §4 —
   `[adapters.slack].max_thread_messages` config knob.
3. `src/ports/slack.ts` and `src/adapters/slack.ts` — existing
   port + real adapter to extend.
4. `docs/ralph/RUNBOOK.md`.

## Goal

Land the **port interfaces and in-process test fakes** for the
Linear and Slack adapters. After this slice:

- `src/ports/linear.ts` defines `LinearPort` with `getIssue`, plus
  `LinearIssue` and `LinearComment` types matching adapters spec §7.
- `src/ports/slack.ts` is **extended** with `fetchThreadContext`,
  `SlackThread`, and `SlackThreadMessage`. Existing methods (`post`,
  `fenceTs`, `searchByNonce`, `listReplies`) are unchanged.
- In-process fakes exist in `tests/support/fakes/linear.ts` and the
  existing Slack fake gains a `fetchThreadContext` implementation.
- The Slack fake implements the **truncation cap** (default 200,
  configurable per-instance) so consumers can exercise both the
  under-cap and over-cap code paths.
- No real adapter implementations are written. Real `LinearAdapter`
  lands in slice 17; real `SlackAdapter.fetchThreadContext` lands in
  slice 18.

## Red tests (must exist with these names and must pass)

Place tests under `tests/adapters/`. Test names match this table
exactly.

| Test name | Proves |
|---|---|
| `test_linear_port_fake_get_issue_returns_structured_payload` | Fake `LinearPort.getIssue("ENG-1234")` returns a `LinearIssue` with all v1 required fields (`identifier, url, title, body, comments`). |
| `test_linear_port_fake_get_issue_returns_null_on_404` | Fake configured for "issue not found" → `getIssue` returns `null`, not an exception. |
| `test_linear_port_fake_throws_on_draft_issue` | Fake configured to mark an issue as draft → `getIssue` throws `ticket_not_actionable`. |
| `test_linear_port_fake_throws_on_5xx_with_retryable_false` | Fake configured for 5xx → throws `adapter_error{adapter:"linear", retryable: false}`. |
| `test_linear_port_fake_throws_on_429_with_retryable_true_and_retry_after` | Fake configured for 429 → throws `adapter_error{adapter:"linear", retryable: true, retry_after: <seconds>}`. |
| `test_slack_port_fake_fetch_thread_context_returns_parent_and_replies` | Fake `fetchThreadContext("C123:1700.001")` returns the parent message + ordered replies. |
| `test_slack_port_fake_fetch_thread_context_truncates_above_cap` | Fake configured with 500 replies and `max_thread_messages = 200` → returned shape is first 100 + truncation-marker message + last 100. Marker text is `<!-- thread truncated: K intermediate messages omitted -->` with literal `K` substituted. |
| `test_slack_port_fake_fetch_thread_context_respects_config_override` | `max_thread_messages = 50` → cap takes effect; 60-message thread returned as first 25 + marker + last 25. |
| `test_slack_port_fake_fetch_thread_context_returns_full_thread_under_cap` | Thread with 50 replies + cap of 200 → all 50 replies returned in order; no truncation marker. |
| `test_slack_port_fake_fetch_thread_context_throws_on_thread_not_found` | Fake configured with no thread for the given ref → throws (caller wraps as `adapter_error{adapter:"slack"}`). |
| `test_slack_port_existing_methods_unchanged` | Existing fake methods (`post`, `fenceTs`, `searchByNonce`, `listReplies`) still pass their slice-6/8 tests after the port extension. |

## Minimal implementation

- `src/ports/linear.ts` — `LinearPort`, `LinearIssue`,
  `LinearComment` types per adapters spec §7. Lean field set
  only; no `state`, `labels`, `attachments`, `createdBy`,
  `assignee`, `createdAt`, `updatedAt`.
- `src/ports/slack.ts` — extend with `fetchThreadContext`,
  `SlackThread`, `SlackThreadMessage`. Touch existing types only
  to add the new method to the `SlackPort` interface.
- `tests/support/fakes/linear.ts` — `FakeLinearAdapter` that lets
  tests configure: per-identifier response (issue / 404 / draft /
  5xx / 429), with the truncation marker rendering deferred to the
  Slack fake.
- `tests/support/fakes/slack.ts` (extend existing) — add
  `fetchThreadContext` with configurable thread + cap. Marker text
  matches the canonical form in adapters spec §7 / §17.
- `src/adapters/slack.ts` (real) — add a placeholder
  `fetchThreadContext` method that throws `"not implemented; landed
  in slice 18"`. This satisfies TypeScript so the rest of the
  codebase compiles. Slice 18 replaces the throw with the real
  Slack API call.

## Done criteria

- All 11 red tests pass.
- Existing slice-6/8 Slack tests still green (no regression on the
  existing `SlackPort` methods).
- `bun test` is green (full suite).
- `bun run typecheck` is green.
- No real Linear adapter is written.
- No `ticketContext.fetch` exists yet (slice 15).

## Hard rules

- Do not modify the spec docs. Spec gap →
  `docs/ralph/blockers/SPEC-GAP-slice-14-<slug>.md`, stop.
- Do not modify `docs/ralph/` outside `blockers/`.
- Do not modify `scripts/`.
- Do not implement `ticketContext.fetch`, the brief composer, the
  CLI, or any real adapter.
- Do not add v1-out-of-scope fields to `LinearIssue` (per spec §7
  exclusion list).
- Test names must match the table exactly.

## Working loop

1. `bun test` → first failing assertion.
2. `bun run typecheck`.
3. Smallest change toward green.
4. Re-run.

Prior gate feedback (if any) appended below.
