# Slice 19: Slack escalation @-mentions for ticket authors

## Required reading

1. `docs/quay-spec-deployment-adapters.md` §15 — downstream feature
   3 (escalation @-mentions). **The authority for this slice.**
2. `docs/quay-spec-deployment-adapters.md` §5 — `tasks.authors_json`
   column (added in slice 12; populated in slice 16).
3. `docs/quay-spec.md` §5 — Slack escalation flow that this slice
   extends (the `waiting_human` post path).
4. `src/core/tick.ts` — existing `processWaitingHumanTask`
   (lines around 1015-1242) is the function this slice extends.
5. `docs/ralph/RUNBOOK.md`.

## Goal

Make Slack escalations notify the original ticket contributors. After
this slice:

- Tick reads `tasks.authors_json` when posting an escalation into a
  task's `slack_thread_ref`.
- For each author, prepends `<@U06TDC56VJB>` (Slack mention syntax)
  to the escalation post body.
- Existing escalation behavior is preserved when `authors_json IS
  NULL` (legacy tasks enqueued via `--brief-file` without the
  adapter): no mentions, just the original message body. No
  regression.
- The rest of the escalation flow (fence capture, recovery probe,
  reply ingestion) is unchanged.

This is the smallest of the new-feature slices: one read from the
DB, one string concatenation, one regression test.

## Red tests (must exist with these names and must pass)

Place tests under `tests/escalation/` (or `tests/slack/`, matching
the existing escalation-test location). Test names match this table
exactly.

| Test name | Proves |
|---|---|
| `test_slack_escalation_at_mentions_authors_when_authors_json_set` | A task with `tasks.authors_json = '[{"name":"Fabian","slack_id":"U06TDC56VJB"},{"name":"Marvin","slack_id":"U07ABCDE"}]'` triggers an escalation; the posted Slack message starts with `<@U06TDC56VJB> <@U07ABCDE>` (mentions in declaration order) followed by the original escalation body. |
| `test_slack_escalation_no_mentions_when_authors_json_null` | A task with `authors_json IS NULL` (legacy `--brief-file` path) → escalation posts the original body verbatim, no `<@...>` prefix. |
| `test_slack_escalation_no_mentions_when_authors_json_empty_array` | A task with `authors_json = '[]'` → no mention prefix; escalation body unchanged. (Defensive — block parser rejects empty `authors`, but DB-level data could be malformed; behavior should be safe.) |
| `test_slack_escalation_existing_fence_capture_unchanged` | The fence-capture step (`slack.fenceTs` → persist `slack_pre_post_fence_ts`) runs identically for both `authors_json IS NULL` and `authors_json` set tasks. No regression on slice-6/8 behavior. |
| `test_slack_escalation_existing_recovery_probe_unchanged` | The nonce-based recovery probe (`slack.searchByNonce`) runs identically for both cases. |
| `test_slack_escalation_existing_reply_ingestion_unchanged` | Reply ingestion (`slack.listReplies` → write `slack_reply` artifact → transition to `awaiting-next-brief`) runs identically. |
| `test_slack_escalation_mention_prefix_preserves_escalation_nonce` | The `escalation_nonce` (used by the recovery probe) is still present in the posted body alongside the mentions. |

## Minimal implementation

- In `src/core/tick.ts`'s `processWaitingHumanTask` (or its
  call-chain), before invoking `deps.slack.post(...)`:
  - Read `tasks.authors_json` for the task (extend the existing
    SQL query that already loads `slack_thread_ref`).
  - If non-null and non-empty, parse as `TicketAuthor[]` and build a
    mention prefix: `authors.map(a => '<@' + a.slack_id + '>').join(' ')`.
  - Concatenate prefix + space + existing escalation body.
  - If null or empty, fall through to existing body unchanged.
- No changes to the post-API call path, fence capture, recovery probe,
  or reply ingestion.

## Done criteria

- All 7 red tests pass.
- Existing escalation tests (slice 6 / slice 8) all still green
  (regression check).
- `bun test` is green (full suite).
- `bun run typecheck` is green.
- Tasks enqueued via `--linear-issue` (slice 16) automatically get
  the @-mention behavior; tasks enqueued via legacy `--brief-file`
  do not.

## Hard rules

- Do not modify the spec docs. Spec gap →
  `docs/ralph/blockers/SPEC-GAP-slice-19-<slug>.md`, stop.
- Do not modify `docs/ralph/` outside `blockers/`.
- Do not modify `scripts/`.
- Do not change the existing `SlackPort.post` signature or any other
  Slack adapter behavior.
- Do not extend the escalation body with anything other than the
  `<@U...>` prefix.
- Test names must match the table exactly.

## Working loop

1. `bun test` → first failing assertion.
2. `bun run typecheck`.
3. Smallest change toward green.
4. Re-run.

Prior gate feedback (if any) appended below.
