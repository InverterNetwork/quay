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
  --slack-thread-ref C123456:1712345678.901234
```

Required:

- `--repo <id>`
- `--brief-file <path>`

Optional:

- `--external-ref <ref>`: stored on the task and used to derive branch/tmux
  names. If omitted, Quay uses the task id.
- `--ticket-snapshot-file <path>`: stored as a `ticket_snapshot` artifact.
- `--slack-thread-ref <channel:ts>`: used later for human escalation.

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
  --tag backend \
  --tag auth
```

This path requires `[adapters.linear].enabled = true` and a configured Linear
token. It fetches the Linear ticket, parses the `quay-config` block, optionally
fetches Slack thread context, validates the assembled ticket payload, and then
enters the same enqueue path as manual briefs.

`--linear-issue` is mutually exclusive with:

- `--brief-file`
- `--external-ref`
- `--slack-thread-ref`

The adapter derives those from the ticket.

Calling the same Linear issue twice for the same repo returns the existing task
instead of creating a duplicate.

## What Enqueue Does

1. Validates repo registration and archived status.
2. Verifies the bare clone exists.
3. Fetches the configured base branch.
4. Resolves a `quay/<slug>` branch name.
5. Creates a worktree from `origin/<base_branch>`.
6. Runs the repo `install_cmd` in the worktree.
7. Inserts the task and attempt rows.
8. Writes artifacts.

If any step fails, Quay rolls back worktree, branch, SQL, and artifact side
effects as far as possible.

## Branch Names

When `external_ref` is present, Quay derives a git-safe slug and stores the full
branch name as `quay/<slug>`. On collision, it appends the short task id. If no
safe unique branch can be found, enqueue fails with
`branch_collision_unresolvable`.

## Retry Budget

The task's `retry_budget` is copied from deployment config at enqueue time. The
default is `5`. Changing config later does not rewrite existing tasks.
