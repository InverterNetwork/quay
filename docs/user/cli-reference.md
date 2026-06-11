# CLI Reference

The main command surface is implemented by
`packages/cli/src/cli/dispatch.ts`. The older spec docs may lag behind this
list.

## Output Conventions

- Successful read commands print JSON to stdout.
- Successful write commands print JSON to stdout.
- Write-command failures print JSON to stderr and exit non-zero.
- `quay tick` prints newline-delimited JSON, one action per line.
- `quay artifact get` streams raw artifact bytes unless `--path` is used.

## Help

Every command supports `--help`, `-h`, or a bare `help` subcommand to print
a plain-text usage block:

```bash
quay --help                # top-level command list
quay help                  # same as --help
quay help repo             # equivalent to `quay repo --help`
quay repo --help           # per-noun usage + subcommand list
quay repo add --help       # leaf-command usage with required flags
```

Help requested explicitly (`--help` / `-h` / `help`) goes to **stdout** and
exits 0. Misuse — bare `quay`, bare `quay <noun>`, an unknown command, or a
typo'd subcommand — still emits the structured `{error: "usage_error"}`
envelope on stderr (so machine consumers like `hermes-agent` keep parsing
it), and additionally appends the relevant usage block (or a one-line
`Run \`quay --help\` for usage.` hint for unknown top-level commands).
Misuse always exits non-zero.

## Global

```bash
quay --version
quay -v
```

`--version` short-circuits before config, DB, and migrations.

## Serve

```bash
quay serve [--host <host>] [--port <port>] [--ui-dir <path>]
```

Starts the Admin HTTP API and, for release binaries, the embedded Admin UI
using the same runtime wiring as CLI commands:
config loading, data directory resolution, migrations, and repo registry
services. Defaults to `127.0.0.1:9731`. The OpenAPI contract is checked in at
`docs/api/openapi.yaml`.

The API exposes read models plus a narrow structured write surface under
`POST /v1/changes/preview` and `POST /v1/changes/apply`. Apply requests are
guarded by the read-model revision returned by the API, so stale clients must
reload before retrying.

`--host` only accepts loopback addresses (`127.0.0.1`, `::1`, or `localhost`).
By default the API is unauthenticated on loopback for local standalone use, so
Quay refuses non-loopback binds. To protect `/v1/*`, set
`[admin].require_auth = true` and provide `QUAY_ADMIN_TOKEN`; API requests must
send `Authorization: Bearer <token>`.

Static Admin UI assets stay browser-loadable in protected mode. Quay injects a
same-origin `/v1/*` fetch wrapper into `index.html`; open the UI with
`/#quay_admin_token=<token>` once to store the token in browser
`sessionStorage`. Non-browser clients and reverse proxies can send the
`Authorization` header directly.

`--ui-dir` overrides embedded UI assets with a built Admin UI directory from
the same loopback server:

```bash
bun run admin-ui:build
quay serve --ui-dir packages/admin-ui/dist
```

The directory must contain `index.html`. When embedded UI assets or `--ui-dir`
are active, Quay serves `/v1/*` through the Admin API before checking static
files, serves existing assets with content-type and cache headers, injects
same-origin API runtime config into `index.html`, returns `index.html` for
non-API SPA routes, and returns 404 for missing asset-like paths.

## Preamble

```bash
quay preamble list [--kind <code|review>]
quay preamble show <preamble_id>
quay preamble create --kind <code|review> --body-file <path>
quay preamble create --kind <code|review> --body-file -
quay preamble create --kind <code|review> --body <text>
```

`preamble list` prints a JSON array of catalog summaries with
`preamble_id`, `kind`, and `created_at`. `preamble show` prints one row,
including `body`. `preamble create` appends a new row and prints the created
record, including its `preamble_id`, so operators can register preambles
without direct SQL access.

Preambles are split by kind: `code` for worker attempts and `review` for
reviewer attempts. Use `--body-file -` to read the body from stdin. After
creating a preamble, assign it to a repo role with the existing override
flags:

```bash
worker_id=$(quay preamble create --kind code --body-file worker.md | jq -r .preamble_id)
quay repo update myrepo --preamble-worker "$worker_id"

reviewer_id=$(quay preamble create --kind review --body-file reviewer.md | jq -r .preamble_id)
quay repo update myrepo --preamble-reviewer "$reviewer_id"
```

## Repo

```bash
quay repo add \
  --id <repo_id> \
  --url <repo_url> \
  --base-branch <branch> \
  --package-manager <name> \
  --install-cmd <cmd> \
  [--test-cmd <cmd>] \
  [--ci-workflow-name <name>] \
  [--contribution-guide-path <path>] \
  [--agent-worker <name>] \
  [--agent-reviewer <name>] \
  [--model-worker <model>] \
  [--model-reviewer <model>] \
  [--preamble-worker <preamble_id>] \
  [--preamble-reviewer <preamble_id>]

quay repo update <repo_id> [flags]
quay repo update --id <repo_id> [flags]
quay repo remove <repo_id>
quay repo list [--active]
quay repo export [--out <path>] [--active]
quay repo import --in <path>

quay repo set-tags <repo_id> --namespace <name> --value <v>
quay repo unset-tags <repo_id> --namespace <name> [--value <v>]
quay repo get-tags <repo_id>
quay repo apply-tags <repo_id> --from <path>
```

`repo add` and `repo update` also accept `--input <json>` for structured
automation. Agent/model flags set per-repo worker and reviewer defaults.
Preamble flags pin that repo role to a specific `preambles.preamble_id`;
when omitted, attempts continue using the latest global preamble for their
role.
Use `repo update --agent-worker ""`, `--agent-reviewer ""`,
`--model-worker ""`, `--model-reviewer ""`, `--preamble-worker ""`, or
`--preamble-reviewer ""` to clear an override and fall back to deployment or
global defaults.

`repo list` and `repo export` default to returning every row, archived
included, so operators debugging "where did my repo go?" still see
soft-deleted entries (and `repo export` keeps full-fidelity backup
semantics). Pass `--active` to limit the output to rows with
`archived_at IS NULL` — the typical "which repos are in service?"
question that consumers like `setup-hermes.sh` ask.
When exported repos have preamble overrides, the dump includes companion
`preamble_worker_record` / `preamble_reviewer_record` objects so import can
restore the referenced prompt bodies and remap database-local IDs.

## Tags

Deployment-wide vocabulary management and per-repo merged-vocab inspection:

```bash
quay tags set-deployment --namespace <name> --value <v>
quay tags unset-deployment --namespace <name> [--value <v>]
quay tags get-deployment
quay tags apply-deployment --from <path>
quay tags import --from <path> [--force]
quay tags list --repo <repo_id>
```

`tags set-deployment` and `tags unset-deployment` operate on the deployment-scoped
vocabulary (no repo required). `tags apply-deployment` accepts `--from -` for stdin.
`tags import` reads a TOML file containing a `[tags.namespaces.*]` table; if the
deployment vocab is already non-empty and the desired state differs, it exits 1 with
`vocab_exists` unless `--force` is passed.

`tags list --repo <repo_id>` merges the deployment vocab with the per-repo vocab and
returns the result with an `enforced` boolean. `enforced` is true when the repo has
any per-repo vocabulary configured; deployment-only vocab never enforces.

## Enqueue

Manual brief:

```bash
quay enqueue \
  --repo <repo_id> \
  --brief-file <path> \
  [--base-branch <branch>] \
  [--request-pr-screenshots] \
  [--require-pr-screenshots] \
  [--ticket-snapshot-file <path>] \
  [--external-ref <ref>] \
  [--slack-thread-ref <channel:ts>] \
  [--worker-agent <name>] \
  [--worker-model <model>] \
  [--reviewer-agent <name>] \
  [--reviewer-model <model>] \
  [--tag <tag>]...
```

Linear:

```bash
quay enqueue \
  --repo <repo_id> \
  --linear-issue <identifier> \
  [--base-branch <branch>] \
  [--request-pr-screenshots] \
  [--require-pr-screenshots] \
  [--worker-agent <name>] \
  [--worker-model <model>] \
  [--reviewer-agent <name>] \
  [--reviewer-model <model>] \
  [--worker-execution <oneshot|goal>] \
  [--as-normal-task] \
  [--tag <tag>]...
```

Task-level agent/model overrides are snapshotted onto the queued task and take
precedence over repo and deployment role defaults. On the manual brief path,
`--worker-execution` defaults to `oneshot`; `goal` enables durable goal mode
and requires the worker to write `.quay-goal-report.json` before exit. Complete
goal reports are audited against captured evidence before Quay enters the PR
lifecycle. On the Linear path, set `worker_execution: goal` in the ticket's
`quay-config` block.
`--base-branch` overrides the repo default for one task on either enqueue path;
Linear tickets can also set `base_branch` in `quay-config`.
`--request-pr-screenshots` is a soft task-level request. When present, every
code-worker prompt asks the worker to capture UI screenshots when the task
affects UI, attach or link them in the PR when the runtime supports that, and
state the limitation in the PR if screenshots cannot be captured or attached.
`--require-pr-screenshots` is the hard mode. Enqueue resolves the effective
worker agent, requires it to advertise the `screenshots` capability, persists
the hard prompt mode, and fails before task creation if the capability is
missing.
`--linear-issue` is mutually exclusive with `--brief-file`, `--external-ref`,
and `--slack-thread-ref`.

Linear-backed enqueue reads native Linear blocked-by relations once, during
enqueue. Complete blockers do not block. Incomplete tracked blockers persist
dependency rows and create the dependent task in `waiting_dependencies`;
incomplete untracked blockers fail with `dependency_not_tracked`.

Linear-backed umbrella workflows use native Linear parent/child hierarchy. If
the issue has Linear children, enqueue creates the umbrella workflow, derives
the shared feature branch, records the expected child set, and materializes
incomplete children as Quay tasks targeted at that feature branch. Children
that are already complete in Linear are recorded as `complete_without_quay` and
do not get Quay tasks. If the issue has a Linear parent, direct enqueue fails
with `umbrella_child_direct_enqueue` unless `--as-normal-task` is passed.

Umbrella parent enqueue returns coordination JSON instead of the normal task
enqueue payload. The `expected_tasks` array exposes each persisted child row,
including state values such as `linked` and `complete_without_quay`; the
`child_tasks` array exposes materialized child task enqueue results.

`--as-normal-task` applies to Linear child issues only. It ignores the child's
native parent umbrella membership for this enqueue, but it does not turn a
parent issue with children into a normal task. It still processes native
Linear blocked-by relations as normal dependencies.

## Rerun

```bash
quay rerun --linear-issue <identifier> \
  [--repo <repo_id>] \
  [--base-branch <branch>] \
  [--tag <tag>]...
```

`rerun` is the explicit path for a Linear work item whose latest Quay run is
terminal. Plain `enqueue --linear-issue <identifier>` reuses an active run when
one exists; if the latest run is terminal, enqueue fails with
`{error: "work_item_terminal"}` and includes `last_task_id`,
`last_run_state`, `last_run_number`, and `rerun_command`.

`quay rerun --linear-issue <identifier>` uses the same Linear adapter and repo
resolution as enqueue, then creates the next run under the same work item. The
new run gets a fresh task/worktree lineage, sets `supersedes_task_id` to the
previous run, and uses run-number branch naming such as
`quay/BRIX-123-r2`. The success payload includes the normal enqueue fields plus
`created_new_run`, `run_number`, and `supersedes_task_id`; when enqueue reuses
an active run, `created_new_run` is `false`.

## PR Review

```bash
quay review-pr --pr <repo>:<num> \
  [--head-sha <sha>] \
  [--reviewer-agent <name>] \
  [--reviewer-model <model>] \
  [--tag <tag>]...
```

`review-pr` is the fire-and-forget enrollment/poke entry point for the Quay reviewer. The
repo portion may be the configured `repo_id` or the owner/name derived from the
registered repo URL. The command prints one JSON object with `scheduled`,
`pending_ci`, and `skipped_reason` so callers can distinguish newly scheduled
work, durable CI-gated enrollment, and idempotent no-ops.
Reviewer overrides are snapshotted on synthetic review tasks. After a synthetic
PR is enrolled once, tick polls it by PR number until merge/close and schedules
new-head reviews itself; repeated CI/webhook calls remain safe latency helpers.

```bash
quay adopt-pr --pr <repo>:<num>
```

`adopt-pr` is an explicit operator opt-in that lets a normal Quay code worker
update an existing human-authored PR. The PR must be open and its head branch
must live in the same repository; fork PR adoption is intentionally unsupported.
Quay reuses the synthetic review task for the PR when one exists, or creates it
first, then checks out the PR head branch as a mutable worktree and schedules a
pending code-worker attempt. The worker prompt tells the agent to push that
existing branch and update the existing PR rather than opening a duplicate PR.

Adopted PRs are marked as human-owned branch lifecycles. By default, cancel and
closed-unmerged cleanup preserve the remote branch instead of deleting the
human-created head ref; explicit close/delete options still apply where the
command supports them. Adoption does not run the repo `install_cmd` from the
adopted PR head before the worker is scheduled.

```bash
quay unadopt --pr <repo>:<num>
quay unadopt <task_id>
```

`unadopt` is the operator-friendly escape hatch for adopted PRs. It accepts a
PR reference, such as `owner/repo:47`, or the underlying adopted task id when
the operator already has it. The command verifies that the target is an adopted
external PR task, cancels Quay's task so worker/reviewer automation stops, and
prints explicit JSON showing the final `cancelled` state and `unadopted`
outcome. The human-owned remote branch is preserved by default so the PR can
continue outside Quay ownership.

## Tick

```bash
quay tick
```

No flags are currently accepted.

## Handoffs

```bash
quay handoff list [--status <pending|claimed|completed|cancelled>] [--task <task_id>] [--include-ineligible]
```

`handoff list` is the pull surface for orchestrator loops waiting to resume
tasks in `awaiting-next-brief`. It reads the durable handoff queue populated for
worker blockers, exhausted retry budgets, and ingested human replies. Without
`--status`, it lists only `pending` handoffs. Use `--status claimed`,
`--status completed`, or `--status cancelled` for recovery and forensics, and
`--task` to narrow the result to one task. Pending rows whose
`next_eligible_at` is still in the future are hidden by default so timed-out
human waits do not monopolize queue drains; use `--include-ineligible` to show
them during inspection.

Output is a deterministic JSON array ordered by creation time and handoff ID.
Each row includes `handoff_id`, `task_id`, `reason`, `state_event_id`,
`idempotency_key`, `payload_json`, `status`, `claim_id`, `claimed_at`,
`completed_at`, `next_eligible_at`, `created_at`, and `updated_at`.

## Outbox

```bash
quay outbox list [--status <pending|claimed|completed|cancelled>] [--task <task_id>] [--kind <kind>] [--handler-class <workflow_intervention|delivery>] [--include-ineligible]
quay outbox claim <outbox_item_id> [--claim-id <claim_id>]
quay outbox complete <outbox_item_id> --claim-id <claim_id>
quay outbox fail <outbox_item_id> --claim-id <claim_id> --error <message> [--next-eligible-at <iso>]
```

`outbox` is the shared durable side-effect surface for Hermes delivery loops.
Workflow/intervention items back the existing human-advice handoff flow and may
claim or resume a task through the task claim commands. `outbox list` defaults
to `--handler-class delivery`; pass `--handler-class workflow_intervention` only
for inspection. Delivery items are notification-only: claiming, completing, or
failing them does not change task state, and the generic outbox mutation
commands reject workflow/intervention items. `outbox fail` records `last_error`,
clears the claim, and reopens the item as `pending` so retry is driven by Quay's
idempotency key rather than by the downstream side effect. `--next-eligible-at`
must be an ISO-8601 instant and is stored in canonical UTC form.

`pr_ready_approved` is a delivery item for Slack notification loops. Quay emits
one when a Quay-owned task reaches `done` and the latest review-only attempt for
the current `head_sha` is approved. The payload fields are `task_id`,
`external_ref`, `repo_id`, `pr_number`, `pr_url`, optional `pr_title`,
`head_sha`, `review_id`, `review_attempt_id`, `branch_name`, and
`approval_status` (`approved` or `reapproved`). The route hint fields are
`slack_thread_ref` and `fallback`, where `fallback` is
`deployment_default_slack_channel`.

## Tasks

```bash
quay task list [--state <state>]... [--repo <repo_id>] [--external-ref <ref>]
quay task get <task_id>
quay task events <task_id>
quay task claim <task_id>
quay task release-claim <task_id> --claim-id <claim_id>
quay task retarget <task_id> --repo <target_repo> [--base-branch <branch>] --yes
```

`task claim` only succeeds for `awaiting-next-brief` tasks.
`task get` includes `slack_thread_ref`, which is the enqueue-time Slack
`channel:thread_ts` route an orchestrator should prefer for human questions.
It also includes `authors`, parsed from the ticket's `quay-config.authors`
block as `{name, slack_id}` objects. Legacy or malformed rows return
`authors: []`.

`task list`, `task get`, and `task events` accept legacy `task_id` values and
return the same task/run rows as before. JSON output now also includes
run-aware compatibility fields:

- `work_item_id`: stable Quay work-item identity, or `null` for older rows.
- `run_number`: run ordinal under the work item, or `null` for older rows.
- `superseded_by_run`: successor run `task_id` when this run has been rerun,
  otherwise `null`.

Deprecation note: in task-oriented commands, `task_id` remains the accepted
argument and JSON field name, but its meaning is now "run id". Work-item
identity is exposed separately as `work_item_id`; scripts that need stable
ticket identity should read `external_ref` or `work_item_id` instead of
treating `task_id` as the product work item.

`task list` and `task get` include dependency and umbrella read-model context.
A waiting task looks like:

```json
{
  "task_id": "task-dependent",
  "state": "waiting_dependencies",
  "dependency_status": {
    "total": 1,
    "satisfied": 0,
    "unsatisfied": 1,
    "dependencies": [
      {
        "dependency_source": "linear",
        "dependency_external_ref": "BRIX-1505",
        "dependency_task_id": "task-blocker",
        "kind": "blocked_by",
        "scope": "normal",
        "required_state": "merged",
        "satisfied_at": null
      }
    ]
  },
  "umbrella_status": null
}
```

An umbrella subtask includes its workflow:

```json
{
  "task_id": "task-umbrella-subtask",
  "base_branch": "quay/umbrella/BRIX-1500",
  "umbrella_status": {
    "role": "subtask",
    "umbrella_workflow_id": 12,
    "external_ref": "BRIX-1500",
    "repo_id": "myrepo",
    "base_branch": "dev",
    "feature_branch": "quay/umbrella/BRIX-1500",
    "state": "active",
    "task_external_ref": "BRIX-1512",
    "final_pr_task_id": null,
    "final_pr_number": null,
    "final_pr_url": null
  }
}
```

`task retarget` clones the original `task_objective`, ticket snapshot, tags,
author metadata, agent/model overrides, screenshot settings, worker execution
mode, and retry budget into a new `queued` task in the target repo. The new
task is linked with `retargeted_from_task_id`; the source task is moved to
`cancelled` with a `retargeted` audit event whose `event_data` names the new
task. `--yes` is required because the source task is mutated and any live
worker session is killed. If retarget crashes after creating the linked clone
but before the source reaches terminal state, the next `quay tick` recovers the
cancel intent and writes the same source-side `retargeted` audit context from
the linked clone.

## Submit Brief

```bash
quay submit-brief <task_id> \
  --claim-id <claim_id> \
  --brief-file <path> \
  --reason <blocker_resolved|advice_answered> \
  [--goal-token-budget <number|none>]
```

`blocker_resolved` consumes retry budget when promoted. `advice_answered` does
not. `--goal-token-budget` is only required when resuming a budget-limited goal
task; pass a number greater than the goal's `tokens_used`, or `none` to clear
the goal budget.

## Escalate Human

```bash
quay escalate-human <task_id> \
  --claim-id <claim_id> \
  --question-file <path> \
  [--thread-ref <channel:ts>]
```

This records the question and moves the task to `waiting_human` while
preserving the orchestrator claim. Quay does not post to Slack; the
orchestrator owns routing, posting, waiting, and fallback channels. If
`--thread-ref` is omitted, the recorded thread metadata can remain empty.

## Record Human Reply

```bash
quay record-human-reply <task_id> \
  --claim-id <claim_id> \
  --reply-file <path> \
  [--thread-ref <channel:ts>] \
  [--message-ts <ts>] \
  [--author <name>]
```

This persists the human answer as a `slack_reply` artifact and returns the task
to `claimed-by-orchestrator`, so the same orchestrator claim can call
`submit-brief --reason advice_answered`.

## Cancel

```bash
quay cancel <task_id> [--close-pr] [--keep-worktree]
```

Unknown cancel flags are rejected. Boolean cancel flags do not accept values.

## Artifacts

```bash
quay artifact get <task_id> <kind> [--attempt <n>] [--path]
```

Without `--path`, stdout is the artifact body as raw bytes. With `--path`,
stdout is the on-disk artifact path.

## Validate Ticket

```bash
quay validate-ticket [--ticket-json <path|->] [--schema-file <path>] [--quiet]
```

If `--ticket-json` is omitted or set to `-`, input is read from stdin.

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Valid ticket. |
| `1` | Ticket validation failed. |
| `2` | Usage or schema error. |
| `3` | Input read or JSON error. |
