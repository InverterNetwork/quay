# Enqueueing Tasks

Enqueue creates a task, a worktree, a branch, and attempt 1. It also writes the
initial `brief` and `final_prompt` artifacts.

## Manual Brief

```bash
quay enqueue \
  --repo myrepo \
  --brief-file ./brief.md \
  --external-ref ENG-1234 \
  --ticket-snapshot-file ./ticket.md \
  --slack-thread-ref C123456:1712345678.901234 \
  --worker-execution oneshot \
  --request-pr-screenshots
```

Required:

- `--repo <id>`
- `--brief-file <path>`

Optional:

- `--external-ref <ref>`: stored on the task and used to derive branch/tmux
  names. If omitted, Quay uses the task id.
- `--ticket-snapshot-file <path>`: stored as a `ticket_snapshot` artifact.
- `--slack-thread-ref <channel:ts>`: used later for human escalation.
- `--worker-execution <oneshot|goal>`: defaults to `oneshot`. Use `goal` for
  long-running tasks that should continue across worker attempts until the
  worker reports active, blocked, or complete goal status.
- `--request-pr-screenshots`: persist a soft request that code workers include
  screenshots in the PR when the task affects UI and their runtime can capture
  and attach or link them.
- `--require-pr-screenshots`: hard mode for UI work where screenshots are
  mandatory. Enqueue fails before task creation unless the resolved worker
  agent advertises the `screenshots` capability.

Output:

```json
{
  "task_id": "...",
  "state": "queued",
  "branch_name": "quay/ENG-1234",
  "tmux_id": "ENG-1234-...",
  "worktree_path": "...",
  "attempt_id": 1
}
```

## Linear Issue

```bash
quay enqueue \
  --repo myrepo \
  --linear-issue ENG-1234 \
  --require-pr-screenshots \
  --tag backend \
  --tag auth
```

This path requires `[adapters.linear].enabled = true` and a configured Linear
token. It fetches the Linear ticket, parses the `quay-config` block, optionally
fetches Slack thread context, validates the assembled ticket payload, reads
Linear blocked-by relations, and then enters the same enqueue path as manual
briefs.

`--linear-issue` is mutually exclusive with:

- `--brief-file`
- `--external-ref`
- `--slack-thread-ref`

The adapter derives those from the ticket. Goal mode for Linear-backed tasks is
selected inside the ticket's `quay-config` block with `worker_execution: goal`.
`--request-pr-screenshots` and `--require-pr-screenshots` are accepted on this
path too and are forwarded to the same task-level prompt modes used by manual
briefs.

Calling the same Linear issue twice for the same repo returns the existing task
instead of creating a duplicate.

Linear blocked-by relations are resolved only at enqueue time. Complete Linear
blockers do not block enqueue. Incomplete tracked blockers create dependency
rows and place the dependent task in `waiting_dependencies` until the blocker
reaches `merged`. Incomplete untracked blockers fail enqueue with
`dependency_not_tracked` before any task, worktree, or artifact is created.

Umbrella subtasks are also configured in `quay-config`. A subtask targets the
umbrella feature branch as its effective base, and `umbrella.depends_on`
creates dependency rows that wait for blockers to reach
`merged_to_feature_branch`.

## Goal Worker Mode

Goal mode is task-level and opt-in:

```bash
quay enqueue --repo myrepo --brief-file ./brief.md --worker-execution goal
```

Linear tickets can request the same mode in their `quay-config` block:

```yaml
worker_execution: goal
```

In goal mode, Quay stores the initial brief as a durable task goal, renders a
bounded `<goal_context>` into each code-worker prompt, and keeps scheduling
normal worker attempts until the worker reports one of three statuses through
`.quay-goal-report.json` in the worktree root:

```json
{
  "status": "active",
  "summary": "What changed or was learned in this attempt.",
  "evidence": [
    {
      "kind": "file",
      "path": "test-output.txt",
      "summary": "Command output showing the relevant verification passed."
    },
    {
      "kind": "url",
      "url": "https://github.com/owner/repo/pull/123",
      "summary": "Reviewable PR URL."
    }
  ],
  "blocker": null,
  "next_steps": ["Concrete next step for the next worker attempt."]
}
```

`status` must be `active`, `blocked`, or `complete`.

- `active`: Quay records usage/time and schedules a `goal_continue` attempt.
  This is productive continuation and does not consume regular retry budget.
- `blocked`: Quay creates a blocker artifact and an orchestrator handoff.
- `complete`: Quay first moves the task to `goal-completion-pending`, captures
  cited evidence artifacts, and audits the completion claim. Only an accepted
  audit enters normal `pr-open` flow. Draft PRs, missing evidence, notes-only
  evidence, invalid file paths, or evidence saying required verification could
  not run are returned to the worker with a non-budget correction attempt.

Evidence entries use one of four shapes:

- `file`: a path inside the worktree. Quay captures the file as an attempt
  artifact.
- `url`: an HTTP(S) URL that remains queryable from task history.
- `artifact`: a prior Quay artifact id from the same task.
- `note`: context only. Notes are useful for active/blocked reports, but notes
  alone are not enough for `complete`.

Malformed goal reports are protocol errors. Quay preserves the malformed bytes
as `malformed_goal_report`, schedules bounded repair attempts with
`consumed_budget = 0`, and only parks for human input after those protocol
repairs are exhausted.

If a goal hits its token budget, Quay moves the task to `awaiting-next-brief`
with a `budget_exhausted` handoff. Resuming a budget-limited goal requires an
explicit budget change:

```bash
quay submit-brief <task_id> \
  --claim-id <claim_id> \
  --brief-file ./resume.md \
  --reason blocker_resolved \
  --goal-token-budget 200000

quay submit-brief <task_id> ... --goal-token-budget none
```

The first form raises the lifetime goal token budget. The `none` form clears
the goal token budget and makes the resumed goal unbounded. Tokens already used
remain lifetime accounting and are not reset.

## What Enqueue Does

1. Validates repo registration and archived status.
2. Verifies the bare clone exists.
3. Fetches the effective base branch.
4. Resolves a `quay/<slug>` branch name.
5. Creates a worktree from `origin/<base_branch>`.
6. Runs the repo `install_cmd` in the worktree.
7. Inserts the task and attempt rows.
8. Writes artifacts.

When dependencies are present and unsatisfied, the inserted task starts in
`waiting_dependencies`; it is prepared and queryable, but tick will not spawn a
worker until all dependency rows are satisfied.

If any step fails, Quay rolls back worktree, branch, SQL, and artifact side
effects as far as possible.

By default, the effective base branch is the repo's configured `base_branch`.
For one task, pass `quay enqueue --base-branch <branch>` or set
`base_branch:` in the Linear ticket's `quay-config` block. Quay stores that
effective branch on the task, branches from `origin/<base_branch>`, and tells
the worker to open the PR into the same branch without changing the repo
default.

## Branch Names

When `external_ref` is present, Quay derives a git-safe slug and stores the full
branch name as `quay/<slug>`. On collision, it appends the short task id. If no
safe unique branch can be found, enqueue fails with
`branch_collision_unresolvable`.

## Retry Budget

The task's `retry_budget` is copied from deployment config at enqueue time. The
default is `5`. Changing config later does not rewrite existing tasks.
