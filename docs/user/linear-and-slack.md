# Linear And Slack

Linear and Slack integrations are opt-in deployment adapters.

For complete token, scope, channel membership, and scheduler environment setup,
see [External Services Setup](external-services.md).

## Configuration

```toml
[adapters.linear]
enabled = true
api_key_env = "LINEAR_API_KEY"
default_issue_team_key = "BRIX"

[adapters.slack]
enabled = true
bot_token_env = "SLACK_TOKEN"
max_thread_messages = 200
```

Default env vars:

```bash
export LINEAR_API_KEY=...
export SLACK_TOKEN=...
```

You can rename those env vars with `api_key_env` and `bot_token_env`.

## Linear Enqueue Flow

```bash
quay enqueue --repo myrepo --linear-issue ENG-1234
```

The flow is:

1. Resolve the Linear issue.
2. Reject draft tickets.
3. Parse the ticket's `quay-config` block.
4. Fetch Slack thread context if the block has `slack_thread` and Slack is
   enabled.
5. Compose a canonical brief and ticket snapshot.
6. Run `quay validate-ticket`.
7. Read native Linear blocked-by relations.
8. Read native Linear parent/child hierarchy metadata.
9. Enqueue through the normal substrate path, or create umbrella coordination
   state when the issue is an umbrella parent.

If Linear is disabled, the command fails with `adapter_not_enabled`. If the
token env var is missing, it fails with `adapter_not_configured`.

## Slack To GitHub Identity Mapping

Tasks can list Linear `quay-config` authors by Slack user ID:

```yaml
authors:
  - name: Ada Lovelace
    slack_id: U06TDC56VJB
```

Quay stores a deployment-level Slack user ID to GitHub login mapping in the
Admin UI global configuration view. The Admin API exposes persisted mappings as
`identity_mappings` and recent unmapped task authors as
`identity_discovery.unmapped_contributors`; apply updates with the
`identity_mappings.replace` change type.

When a Quay-owned task reaches an open PR, tick looks up the first valid task
author Slack ID and calls GitHub to add the mapped login as an assignee. A
successful assignment marks the mapping `verified`, records the last task and
PR number on the mapping, and stores the selected login on the task.

Unmapped authors and mappings already marked `conflict` are skipped. GitHub
errors that show the login cannot be resolved or assigned mark the mapping
`conflict` so operators can correct it. Transient GitHub failures, such as
network errors, rate limits, or 5xx responses, only update `last_error`; the
mapping remains eligible and tick retries assignment on a later pass.

## Linear Blocked-By Dependencies

At enqueue time, Quay reads Linear's native blocked-by relations for the issue.
After enqueue, Quay schedules from its own `task_dependencies` rows only; it
does not use future Linear state changes as the scheduler source of truth.

Complete Linear blockers are recorded in the ticket snapshot but do not block
enqueue. Incomplete blockers must already be tracked by Quay. If an incomplete
blocker has a Quay task, the new task is created in `waiting_dependencies` and
waits until that blocker work item reaches `merged` through its latest run. If
an incomplete blocker is not tracked, enqueue fails with
`dependency_not_tracked` and does not create the dependent task. If a blocker
rerun fails after a dependency was already satisfied, Quay keeps the dependent
satisfied; satisfaction is not retroactively revoked.

The ticket snapshot artifact includes `linear_blocked_by_relations`, including
whether each relation was complete in Linear, whether Quay persisted a
dependency row, and the tracked blocker task id when available.

Slack thread refs belong to the work item conversation. Rerun notifications
should continue in the same human thread by default and identify the concrete
run number, for example `run 2`, when discussing a branch, PR, or terminal run
state.

## Umbrella Tickets

Linear-backed umbrella workflows use Linear's native hierarchy, not
`quay-config` umbrella metadata.

The parent Linear issue is the umbrella. Enqueue it first:

```bash
quay enqueue --repo myrepo --linear-issue ENG-200
```

If the issue has native Linear child issues, Quay creates or verifies a shared
feature branch derived from the parent external ref, persists an umbrella
workflow row, records every child in `umbrella_expected_tasks`, and
materializes every incomplete child as a Quay task targeting the umbrella
feature branch. Children that are already complete in Linear are recorded as
`complete_without_quay` and do not get Quay tasks. No worker is spawned for the
umbrella parent in the current flow.

Child tickets use ordinary `quay-config` execution metadata:

```yaml
repo: myrepo
tags:
  - backend
authors:
  - name: Ada Lovelace
    slack_id: U06TDC56VJB
```

Do not enqueue child tickets individually for the umbrella flow. Direct enqueue
of a Linear child issue fails with `umbrella_child_direct_enqueue`, even if the
parent umbrella was already enqueued and the child task already exists.

Pass `--as-normal-task` only on a child issue when you intentionally want to
ignore its native Linear parent membership for this enqueue. The flag does not
turn an umbrella parent with children into a normal task. It also does not
disable Linear blocked-by handling: Quay still reads native blocked-by
relations and persists them as normal dependency rows.

Linear blocked-by relations define ordering inside the umbrella. Same-umbrella
blockers wait for `merged_to_feature_branch`; non-umbrella blockers keep normal
`merged` semantics.

Quay may auto-merge only approved and green umbrella subtask PRs into the
shared feature branch. It never auto-merges normal task PRs or the final
umbrella PR into the repository base branch.

When every expected child is either linked to a task in
`merged_to_feature_branch` or marked `complete_without_quay`, tick creates or
reuses the final umbrella PR and records a final Quay-owned task at `pr-open`.
The final PR title and managed body use the parent Linear issue title and URL
captured when the umbrella parent was enqueued, with generic fallback wording
for historical workflows that do not have those fields.
The final task then follows the ordinary Quay PR lifecycle. When that final PR
merges, Quay marks the umbrella workflow `completed`; closing it without merge
does not mark the workflow delivered.

## Slack Context At Enqueue

The `quay-config` block can include a Slack permalink:

```yaml
slack_thread: https://example.slack.com/archives/C123456/p1712345678901234
```

The parser converts that URL to Quay's internal thread ref:

```text
C123456:1712345678.901234
```

When Slack is enabled, Quay fetches the parent message and replies and includes
them in the brief. Long threads are capped by `max_thread_messages` and
truncated with a marker.

When Slack is disabled, enqueue can still proceed, but Slack thread context is
not fetched.

## Human Escalation

`quay escalate-human` persists a `slack_escalation_post` artifact, records a
nonce, and transitions the task to `waiting_human` while preserving the
orchestrator claim. Quay does not post to Slack for this new flow. The
orchestrator chooses the Slack route, posts the question, waits for the answer,
then calls `quay record-human-reply` followed by
`quay submit-brief --reason advice_answered`.

Claimless legacy `waiting_human` rows still use the old tick-owned Slack
posting/reply ingestion path when they already have a `slack_thread_ref`. Legacy
rows without a thread are requeued to `awaiting-next-brief` so the orchestrator
can apply deployment-owned fallback routing.

If the task has authors from a Linear `quay-config` block, Quay prefixes valid
Slack user mentions on the escalation post.

## Timeouts

Network calls are synchronous from Quay's perspective and have deployment
timeouts:

```bash
export QUAY_LINEAR_TIMEOUT_MS=30000
export QUAY_SLACK_TIMEOUT_MS=30000
```

Invalid or missing timeout values fall back to the implementation defaults.
