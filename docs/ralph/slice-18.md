# Slice 18: Real `SlackAdapter.fetchThreadContext` (integration-test gated)

## Required reading

1. `docs/quay-spec-deployment-adapters.md` §7 — `SlackPort`
   extension, including the **pagination cap + truncation marker
   contract**.
2. `docs/quay-spec-deployment-adapters.md` §17 — resolved questions
   on Slack pagination (200 default cap, configurable
   `[adapters.slack].max_thread_messages`), rate-limit handling.
3. `docs/quay-spec-deployment-adapters.md` §4 — config field for the
   cap.
4. `src/adapters/slack.ts` and `src/ports/slack.ts` — existing real
   adapter and port (slice 6/8 substrate; slice 14 added the
   placeholder).
5. `https://api.slack.com/methods/conversations.replies` — Slack API
   for the underlying call.
6. `docs/ralph/slice-10.md` — pattern for integration-test-gated
   adapter tests.
7. `docs/ralph/RUNBOOK.md`.

## Goal

Replace the slice-14 placeholder with a real implementation of
`SlackAdapter.fetchThreadContext`. After this slice:

- `src/adapters/slack.ts`'s `fetchThreadContext(threadRef)` calls
  Slack's `conversations.replies` API, paginating to completion (up
  to the configured cap).
- The truncation cap defaults to **200 messages**; configurable via
  `[adapters.slack].max_thread_messages`.
- Threads under the cap are returned in full (parent + all replies,
  chronological).
- Threads exceeding the cap are truncated to **first half + last
  half**, with a synthetic `SlackThreadMessage` between them
  carrying the canonical marker text:
  `<!-- thread truncated: K intermediate messages omitted -->` (K
  literal, replaced with the omitted count). `authorBot: true`,
  `authorName: null` on the marker message.
- Author name resolution: best-effort via `users.info` (or by name
  surfaced in the message payload); `null` if unresolvable.
- Bot-authored messages flagged `authorBot: true`.
- 4xx (thread not found) → throws.
- 5xx → throws `adapter_error{adapter:"slack", retryable: false}`.
- 429 → throws `adapter_error{adapter:"slack", retryable: true,
  retry_after}` with `Retry-After` header value.

Real-API contract tests are gated behind `QUAY_INTEGRATION_TESTS=1`
(matching slice 10's pattern).

## Red tests (must exist with these names and must pass)

Place tests under `tests/adapters/`. Test names match this table
exactly.

| Test name | Proves |
|---|---|
| `test_slack_adapter_fetch_thread_context_returns_parent_and_replies` | Against fake transport, `fetchThreadContext("C123:1700.001")` returns parent + ordered replies. |
| `test_slack_adapter_fetch_thread_context_paginates` | Threads spanning > 1 Slack API page are stitched in correct order. |
| `test_slack_adapter_fetch_thread_context_truncates_above_cap` | 500-reply thread + `max_thread_messages = 200` → returned shape is first 100 + truncation-marker message + last 100; `K = 300`. Marker text matches the canonical form exactly. |
| `test_slack_adapter_fetch_thread_context_respects_config_override` | `max_thread_messages = 50` → 60-message thread → first 25 + marker + last 25. |
| `test_slack_adapter_fetch_thread_context_returns_full_thread_under_cap` | 50-message thread + cap of 200 → all 50 messages returned, no truncation marker. |
| `test_slack_adapter_fetch_thread_context_marks_bot_messages` | Bot-authored messages → `authorBot: true`. |
| `test_slack_adapter_fetch_thread_context_resolves_author_names_when_available` | Authors resolved to display names when Slack surfaces them; `null` fallback otherwise. |
| `test_slack_adapter_fetch_thread_context_throws_on_thread_not_found` | Slack returns "thread not found" → throws (caller wraps as `adapter_error{adapter:"slack"}`). |
| `test_slack_adapter_fetch_thread_context_throws_on_429_with_retry_after` | Slack 429 with `Retry-After: 60` → throws `adapter_error{adapter:"slack", retryable: true, retry_after: 60}`. |
| `test_slack_adapter_fetch_thread_context_replaces_slice_14_placeholder` | After this slice, calling the method on the real adapter no longer throws "not implemented"; it issues a real API call (or its test stand-in). |
| `test_slack_adapter_fetch_thread_context_contract_tests_skipped_without_integration_flag` | Contract tests against `https://slack.com/api/conversations.replies` are wrapped in `test.skipIf(!process.env.QUAY_INTEGRATION_TESTS)`. |

## Minimal implementation

- Extend `src/adapters/slack.ts`:
  - Replace the placeholder `fetchThreadContext` with a real
    implementation using the existing `callSync` helper.
  - Pagination via `conversations.replies` with `cursor` /
    `next_cursor`, capped at `max_thread_messages`.
  - Truncation logic: if total messages exceed cap, take first
    `floor(cap/2)` + last `floor(cap/2)`, splice in a synthetic
    marker message.
  - Author resolution via the existing pattern (Slack message
    payload often surfaces `user` ID; resolve via `users.info` only
    if the deployment opts in — keep this lazy / minimal).
- Read `[adapters.slack].max_thread_messages` from config; default
  to `200`.
- Optional integration-test file with `test.skipIf(...)` guard.

## Done criteria

- All 11 red tests pass.
- `bun test` is green by default (no Slack credentials required).
- `bun run typecheck` is green.
- The slice-14 placeholder is replaced; `SlackAdapter` now satisfies
  `SlackPort` with a real implementation.
- No regression on existing `SlackPort` methods (`post`, `fenceTs`,
  `searchByNonce`, `listReplies`).

## Hard rules

- Do not modify the spec docs. Spec gap →
  `docs/ralph/blockers/SPEC-GAP-slice-18-<slug>.md`, stop.
- Do not modify `docs/ralph/` outside `blockers/`.
- Do not modify `scripts/`.
- Do not implement escalation @-mentions (slice 19).
- Do not change the existing `SlackPort` methods or their behavior;
  only the new method lands in this slice.
- Real-API contract tests must skip by default.
- Truncation marker text must match `<!-- thread truncated: K
  intermediate messages omitted -->` exactly (K literal substituted).
- Test names must match the table exactly.

## Working loop

1. `bun test` → first failing assertion.
2. `bun run typecheck`.
3. Smallest change toward green.
4. Re-run.

Prior gate feedback (if any) appended below.
