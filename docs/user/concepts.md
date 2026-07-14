# Concepts

Quay is a single-host CLI substrate for running coding tasks in isolated git
worktrees. It does not run a server or broker. An external scheduler runs
`quay tick` periodically, and each tick advances tasks by observing local
state, tmux sessions, git, GitHub, and Slack.

## Actors

- Operator: installs Quay, registers repos, runs tick scheduling, and recovers
  parked tasks.
- Orchestrator: calls Quay write commands, usually from another automation
  layer. It owns ticket policy and human escalation decisions.
- Quay: persists task state, creates worktrees, spawns workers, polls external
  state, stores artifacts, and enforces retry/capacity rules.
- Worker: the coding agent process spawned in tmux. It works inside one
  worktree and exits after opening/updating a PR, writing a blocker, or failing.

## Repositories

Quay stores repo metadata in SQLite, but it does not clone target repos for you.
Before enqueueing work, the operator must:

1. Register metadata with `quay repo add`.
2. Create a bare clone at `<repos_root>/<repo_id>.git`.

At enqueue time, Quay fetches the effective base branch, creates a local branch
named `quay/<slug>`, creates a worktree from `origin/<base_branch>`, runs the
repo `install_cmd`, stores the task-level `task_objective` artifact (the raw
initial brief) plus the first attempt's `brief` and `final_prompt` artifacts,
and creates the first pending attempt. `task resnapshot` can append a newer
task-level objective after the live ticket changes. The effective base branch is
the repo default unless a task-level override is supplied.

## Work Items, Runs, And Attempts

A work item is the durable external unit of work, usually a Linear issue in a
repository. A run is one execution lineage for that work item: branch,
worktree, PR, state machine, events, artifacts, and attempts. An attempt is one
worker process within a run.

For compatibility, Quay still calls runs "tasks" in existing commands and
database relationships. The legacy `task_id` remains a valid identifier, but it
now identifies a run. Attempts, events, artifacts, claims, outbox rows, and
Mission Control task cards continue to key off `task_id` so existing scripts
can inspect the same rows as before.

Run-aware read surfaces add these fields beside the existing task fields:

- `work_item_id`: stable Quay identity for the external work item.
- `run_number`: ordinal run number within that work item.
- `superseded_by_run`: successor `task_id` when a later run supersedes this
  run, otherwise `null`.

One work item can have many historical terminal runs, but only one active run
at a time. A rerun creates the next run under the same work item, sets
`supersedes_task_id` to the previous run, and uses a run-qualified branch such
as `quay/BRIX-123-r2`. Terminal states such as `closed_unmerged` are terminal
for that run, not for the work item.

Every attempt has:

- A reason, such as `initial`, `ci_fail`, `crash`, `review`, or
  `blocker_resolved`.
- A `brief` artifact: a structured composed prompt body with the current
  task objective (rendered from the newest task-level `task_objective` artifact),
  the current attempt's guidance, and any diagnostics for this attempt.
- A `final_prompt` artifact: for code-worker attempts, Quay's worker preamble
  followed by the composed `brief`; for review attempts, Quay's static
  reviewer protocol followed by reviewer guidance and the review `brief`.
- Optional artifacts captured during or after the worker run.

Budget-consuming attempts increment `attempts_consumed` when tick promotes the
attempt from `queued` to `running`. Review and conflict respawns do not consume
retry budget.

## Tick

`quay tick` is a one-shot supervisor pass. It:

- Finalizes pending cancels.
- Observes running workers.
- Polls PR, CI, review, conflict, claim, and Slack states.
- Promotes queued tasks to running up to `max_concurrent`.
- Emits newline-delimited JSON, one action per processed task.

A supervisor lock prevents overlapping ticks and serializes side effects with
`quay cancel`.

## Artifacts

Artifacts are snapshots of data that crosses a boundary, such as:

- `ticket_snapshot`
- `task_objective` (task-level; the canonical brief used by later prompt objective sections)
- `brief` (per-attempt composed body)
- `final_prompt` (worker preamble + `brief`, or reviewer protocol + guidance
  + review `brief`)
- `session_log`
- `blocker`
- `malformed_signal`
- `ci_failure_excerpt`
- `review_comments`
- `conflict_slice`
- `slack_escalation_post`
- `slack_reply`
- `last_failure`

Artifacts are stored under the data directory and indexed in SQLite.

## States

Common active states:

- `queued`: ready for a future tick to spawn.
- `waiting_dependencies`: prepared and known to Quay, but not spawnable until
  its persisted dependency rows are satisfied.
- `running`: worker session is active or recently active.
- `pr-open`: worker opened or updated a PR; Quay is polling PR/CI.
- `done`: CI passed, but the PR is still open. This is not terminal.
- `awaiting-next-brief`: Quay needs orchestrator input.
- `claimed-by-orchestrator`: an orchestrator has claimed the task.
- `waiting_human`: an orchestrator-owned human question is awaiting an answer.

Parked states:

- `worktree_error`: repeated spawn/worktree failures.
- `orchestrator_loop`: repeated claim expirations.
- `non_budget_loop`: too many review/conflict respawns.

Terminal states:

- `merged_to_feature_branch`
- `merged`
- `closed_unmerged`
- `cancelled`

## Dependencies

Linear-backed enqueue reads native Linear blocked-by relations at enqueue time.
Quay then persists source-agnostic dependency rows and uses only its own SQLite
rows during later ticks. It does not keep re-reading Linear to decide whether a
waiting task can run.

Complete Linear blockers do not block enqueue. Incomplete blockers must already
be tracked by Quay. If the blocker task is tracked, the dependent task is
created in `waiting_dependencies` and is released to `queued` only after the
blocker work item reaches `merged` through its latest run. If the incomplete
blocker is not tracked, enqueue fails with `dependency_not_tracked` before
creating the dependent task.

Dependency satisfaction is monotonic. Once a dependency row has `satisfied_at`,
later failed reruns of the blocker do not revoke that fact or re-block the
dependent. New dependents created after a blocker rerun are evaluated against
the blocker's latest run.

Failed blockers do not auto-unblock or auto-cancel dependents. Operators must
inspect the blocker and decide whether to rerun the blocker work item, cancel,
retarget, or otherwise recover the blocked workflow. Dependency-failure
delivery payloads include the failed blocker run number and rerun command when
the blocker is a Linear work item.

## Umbrella Workflows

One-repo umbrella workflows use a shared feature branch. For Linear-backed
umbrellas, Linear's native parent/child hierarchy is the membership source of
truth. Enqueueing the parent issue creates the umbrella workflow, derives the
feature branch, and snapshots the expected Linear child set. Tick never polls
Linear to discover changed membership later.

Each umbrella child target uses the shared feature branch as its effective PR
base. Parent enqueue materializes each incomplete child as a concrete Quay task
and links it to an expected child row. If a child was already complete in
Linear when discovered, Quay marks that expected row `complete_without_quay`;
it then counts toward final readiness without requiring a Quay task. Direct
enqueue of a child issue is not part of the umbrella flow and fails unless the
operator passes `--as-normal-task`.

Linear blocked-by relations define ordering. Same-umbrella dependency rows use
`scope: "umbrella"` and wait for blockers to reach
`merged_to_feature_branch`; blockers outside the umbrella keep normal
`merged` semantics.

Quay may auto-merge only approved and green umbrella subtask PRs into the
umbrella feature branch. It must never auto-merge normal task PRs or the final
umbrella PR into the repository base branch.

When every expected child is either linked to a task in
`merged_to_feature_branch` or marked `complete_without_quay`, tick creates or
reuses the final umbrella PR and a final Quay-owned task already in `pr-open`.
For Linear-backed umbrellas, Quay uses the parent Linear issue title and URL
captured at umbrella enqueue time when rendering that final PR; older workflows
without captured metadata fall back to generic deterministic wording.
That final task follows the normal Quay-owned PR lifecycle: CI polling,
review, review feedback, worker fixes, and merge observation. Quay observes
that final PR merge, but never performs it. After the final PR merges, Quay
marks the umbrella workflow `completed`; closing the final PR without merging
leaves the workflow active for operator repair.
