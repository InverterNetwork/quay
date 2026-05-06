# Slice 17: Real `LinearAdapter` (integration-test gated)

## Required reading

1. `docs/quay-spec-deployment-adapters.md` §7 — `LinearPort` contract;
   the lean `LinearIssue` field set this slice fetches over GraphQL.
2. `docs/quay-spec-deployment-adapters.md` §17 — resolved questions
   on Linear API permissions (`read:issue`, `read:comment`),
   draft-issue rejection, rate-limit handling.
3. `docs/quay-spec-deployment-adapters.md` §12 — failure modes table.
4. `docs/ralph/slice-10.md` — pattern for integration-test-gated
   adapter contract tests (`QUAY_INTEGRATION_TESTS=1`).
5. `https://developers.linear.app/` — Linear GraphQL API reference
   (read-only).
6. `docs/ralph/RUNBOOK.md`.

## Goal

Implement the real `LinearAdapter` against Linear's GraphQL API.
After this slice:

- `src/adapters/linear.ts` exports a `LinearAdapter` class
  implementing `LinearPort` (slice 14).
- `getIssue(identifier)` issues a single GraphQL query that returns
  the lean `LinearIssue` shape — `identifier, url, title, body,
  comments` plus pagination over comments — and only those fields.
  No `labels`, `attachments`, `state`, etc. (per §7 deliberate
  exclusion list).
- Bot token resolved lazily from `LINEAR_API_KEY` env var (matching
  `SlackAdapter`'s pattern, `src/adapters/slack.ts:54-63`).
- Draft issues rejected with `ticket_not_actionable`.
- 404 returns `null`.
- 5xx throws `adapter_error{adapter:"linear", retryable: false}`.
- 429 throws `adapter_error{adapter:"linear", retryable: true,
  retry_after}` with the `Retry-After` header value (or `null`).
- Comments paginated to completion, returned in chronological order
  with `authorIsBot` flagged correctly.
- Replaces the slice-14 placeholder if any.

Real-API contract tests are **gated behind
`QUAY_INTEGRATION_TESTS=1`** (matching slice 10's pattern). Default
`bun test` runs do not require `LINEAR_API_KEY` and do not hit the
network.

## Red tests (must exist with these names and must pass)

Place tests under `tests/adapters/`. Test names match this table
exactly.

| Test name | Proves |
|---|---|
| `test_linear_adapter_get_issue_returns_structured_payload` | Against a recorded fake server (or fake transport injected into the adapter), `getIssue("ENG-1234")` returns a `LinearIssue` with all v1 required fields. |
| `test_linear_adapter_get_issue_returns_null_on_404` | Fake transport configured for "issue not found" → `null`, not an exception. |
| `test_linear_adapter_throws_on_5xx_with_useful_message` | Fake transport for 5xx → throws `adapter_error{adapter:"linear", retryable: false}` with response body in the message for debugging. |
| `test_linear_adapter_throws_on_429_with_retry_after` | Fake transport for 429 with `Retry-After: 30` → throws `adapter_error{adapter:"linear", retryable: true, retry_after: 30}`. |
| `test_linear_adapter_paginates_comments_to_completion` | Mock issue with > 1 comments page → adapter walks pagination and returns the full list in chronological order. |
| `test_linear_adapter_marks_bot_authored_comments` | Mock comment authored by an integration → `authorIsBot: true`. |
| `test_linear_adapter_rejects_draft_issues` | If the Linear payload marks the issue as draft, adapter throws `ticket_not_actionable`. |
| `test_linear_adapter_does_not_fetch_labels_field` | The GraphQL query the adapter issues against `getIssue` does not select the `labels` field — verified by inspecting the query string. |
| `test_linear_adapter_resolves_token_from_env` | Construct the adapter with no token; first call reads `LINEAR_API_KEY` from `process.env`. Throws if missing. |
| `test_linear_adapter_contract_tests_skipped_without_integration_flag` | The real-API contract tests (against `https://api.linear.app/graphql`) are wrapped in `test.skipIf(!process.env.QUAY_INTEGRATION_TESTS)` and do not run by default. |

## Minimal implementation

- `src/adapters/linear.ts` — `LinearAdapter` class implementing
  `LinearPort`. Synchronous `fetch`-based pattern matching
  `SlackAdapter` (`src/adapters/slack.ts`). Per-call timeout
  (configurable; default 30s).
- GraphQL query: minimal field selection covering `identifier`, `url`,
  `title`, `description` (Linear's name for body), `comments` with
  full pagination (`first`, `after`).
- `LINEAR_API_KEY` env-var resolution lazy on first call (matches
  Slack adapter pattern).
- Draft detection: check Linear's `state.type` or equivalent flag; if
  draft, throw `ticket_not_actionable`.
- 4xx / 5xx / 429 mapping per failure-modes table.
- Optional integration-test file (e.g., `tests/adapters/linear_integration.test.ts`)
  with `test.skipIf(!process.env.QUAY_INTEGRATION_TESTS)` guard and
  manual sandbox tests against real Linear.

## Done criteria

- All 10 red tests pass.
- `bun test` is green by default (no `LINEAR_API_KEY` required, no
  network).
- `bun run typecheck` is green.
- The slice-14 placeholder (if any) is replaced by the real
  implementation.
- No regression on slice-14 fake tests; the fake remains the test
  default.

## Hard rules

- Do not modify the spec docs. Spec gap →
  `docs/ralph/blockers/SPEC-GAP-slice-17-<slug>.md`, stop.
- Do not modify `docs/ralph/` outside `blockers/`.
- Do not modify `scripts/`.
- Do not implement Slack `fetchThreadContext` real impl (slice 18)
  or escalation @-mentions (slice 19).
- Do not add fields beyond the v1 lean set to `LinearIssue` (per §7
  exclusion list).
- Real-API contract tests must skip by default. Default `bun test`
  must succeed without `LINEAR_API_KEY` set.
- Test names must match the table exactly.

## Working loop

1. `bun test` → first failing assertion.
2. `bun run typecheck`.
3. Smallest change toward green.
4. Re-run.

Prior gate feedback (if any) appended below.
