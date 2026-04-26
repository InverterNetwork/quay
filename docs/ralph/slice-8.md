# Slice 8: Slack Escalation and Reply Recovery

## Required reading

1. `docs/quay-spec.md` — §5 (waiting_human tick handler), §7/§8
   (escalation artifacts; sequence + nonce + content_hash), §13
   (Slack config), §14 (idempotency invariants).
2. `docs/quay-tdd-implementation-plan.md` — Slice 8 is the authority.
3. `docs/ralph/RUNBOOK.md`.

## Goal

Slack writes happen only inside the tick `waiting_human` handler.
Each escalation has a per-escalation `nonce`. Crash between Slack
post and timestamp persistence is recovered by searching for the
nonce in bot messages — not by reposting. Reply ingestion uses the
recovered timestamp as the lower-bound cursor so inter-window
chatter is excluded. Slack API failure leaves the task in
`waiting_human` for the next tick.

## Red tests (must exist with these names and must pass)

| Test name | Proves |
|---|---|
| `test_011_escalate_human_cli_does_not_call_slack` | CLI escalation creates artifact + state transition only; fake Slack records zero API calls until tick handles `waiting_human`. |
| `test_011b_tick_recovers_posted_slack_message_by_nonce` | Tick that posts then crashes before persisting the timestamp finds the bot message by nonce on the next tick, fills `slack_recovered_post_ts`, and does not repost. |
| `test_048_slack_post_sql_failure_does_not_duplicate_post` | Slack post accepted before SQL timestamp persistence is recovered by nonce; a later human reply is ingested; exactly one Slack post exists. |
| `test_048a_second_escalation_same_body_is_distinct` | A second escalation with same question body gets a new sequence, nonce, content_hash, artifact, Slack post (no dedupe against the first). |
| `test_048c_inter_window_chatter_excluded_after_recovery` | Once the recovered bot-post timestamp is known, thread chatter between pre-post fence and bot post is excluded from reply ingestion. |
| `test_047_slack_post_failure_retries_without_looping` | If Slack API fails before any post exists, the task remains `waiting_human`; the next tick retries; no tight loop within one tick. |
| `test_012_slack_reply_transitions_to_awaiting_next_brief` | A non-bot reply after the bot-post lower bound is stored as `slack_reply` and transitions the task to `awaiting-next-brief` without pushing to the orchestrator. |

Place tests under `tests/slack/`.

## Minimal implementation

- `SlackPort` fake with thread messages, bot messages, and replies;
  ability to simulate API failure modes.
- Per-escalation nonce generation (deterministic via `IdGenerator`).
- Escalation artifact with `sequence`, `nonce`, `content_hash`.
- `waiting_human` tick handler:
  1. Read fence (last seen reply ts).
  2. Search bot messages by nonce; if found, persist
     `slack_recovered_post_ts` and skip post.
  3. If not found and no `slack_post_ts`, post to Slack, then
     persist ts (failpoints `after_slack_post`,
     `after_slack_recovery_ts_commit`).
  4. Ingest replies after the lower bound; first non-bot reply →
     `awaiting-next-brief`.

## Done criteria

- Exactly one visible Slack post per escalation across crash windows.
- Crash recovery uses read-before-write; no double posts.
- Reply ingestion transitions to `awaiting-next-brief` once.
- All seven tests pass; suite green; typecheck green.

## Hard rules

- Spec and plan are read-only.
- No real Slack adapter; fake only.
- Do not touch `src/cli/`.
- Do not modify `docs/ralph/` outside `blockers/`; do not modify
  `scripts/`.
- Test names must match the table exactly.

Spec gap → `docs/ralph/blockers/SPEC-GAP-slice-8-<slug>.md`, stop.

## Working loop

1. `bun test` → first failing assertion.
2. `bun run typecheck`.
3. Smallest change toward green.
4. Re-run.

Prior gate feedback (if any) appended below.
