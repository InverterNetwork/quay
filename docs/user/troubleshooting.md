# Troubleshooting

Quay write-command errors are JSON objects on stderr:

```json
{"error":"bare_clone_missing","message":"...","repo_id":"myrepo"}
```

Read the `error` field first. The `message` is intended for humans and may
include the concrete recovery command or path.

## `repos_root_missing`

You configured an explicit `repos_root`, but that directory does not exist.
Quay creates the derived default `${data_dir}/repos`, but it does not create
operator-configured paths.

Fix:

```bash
mkdir -p /configured/repos_root
```

Then retry the command.

## `bare_clone_missing`

The repo is registered, but the expected bare clone is missing.

Fix:

```bash
git clone --bare <repo_url> <repos_root>/<repo_id>.git
```

Use `quay repo list` to inspect registered repo URLs and ids.

## `bootstrap_failed`

The repo's `install_cmd` exited non-zero during enqueue. Quay rolls back the new
task and worktree.

Fix the repo registration or dependency installation, then enqueue again:

```bash
quay repo update myrepo --install-cmd "bun install --frozen-lockfile"
```

## `adapter_not_enabled`

You called an adapter-backed path, usually `quay enqueue --linear-issue`, but
the adapter is not enabled in `config.toml`.

Fix:

```toml
[adapters.linear]
enabled = true
```

## `adapter_not_configured`

An enabled adapter tried to make an API call, but its token env var was empty.

Fix:

```bash
export LINEAR_API_KEY=...
export SLACK_TOKEN=...
```

Or update `api_key_env` / `bot_token_env` in config.

## `ticket_block_invalid`

The Linear ticket body is missing a valid `quay-config` block, has multiple
blocks, or has malformed block content.

Fix the ticket body and retry `quay enqueue --linear-issue`.

## `ticket_not_actionable`

The Linear issue exists but is a draft. Quay rejects draft tickets.

## `dependency_not_tracked`

`quay enqueue --linear-issue` found an incomplete Linear blocked-by issue that
does not have a matching Quay task. Quay stops before creating the dependent
task because it cannot later observe that blocker reaching `merged`.

Inspect the error payload:

```json
{
  "error": "dependency_not_tracked",
  "dependencies": [{ "external_ref": "BRIX-1505", "repo_id": "myrepo" }]
}
```

Fix one of:

- Enqueue the blocker issue first, then enqueue the dependent issue again.
- Mark the blocker complete in Linear if it is already done; complete Linear
  blockers do not block enqueue.
- Remove the Linear blocked-by relation if it is not a real dependency.

## `umbrella_not_enqueued`

`quay enqueue --linear-issue` found that the Linear issue is a child of an
umbrella parent, but Quay has no persisted umbrella workflow for that parent.
Quay stops before creating the child task because it would not know the shared
feature branch or expected child set.

Fix one of:

- Enqueue the Linear parent issue first, then enqueue the child again.
- Pass `--as-normal-task` if this child should intentionally run outside the
  umbrella workflow. This ignores the child's Linear parent membership only;
  Linear blocked-by relations are still processed as normal dependencies.

## `umbrella_subtask_not_expected`

The Linear child has a parent umbrella workflow, but its external ref is not in
the expected child set that Quay persisted when the parent was enqueued.

Fix one of:

- Confirm the child is attached to the correct Linear parent.
- Recreate or manually repair the umbrella workflow if the Linear child set was
  changed after parent enqueue. Automatic resync is not part of the current
  tick loop.
- Pass `--as-normal-task` only if this child issue should run outside the
  umbrella.

## `umbrella_feature_branch_missing`

Quay found an existing umbrella workflow row, but the persisted feature branch
no longer exists on the remote repository. Quay refuses to recreate existing
umbrella branches from the base branch because that could hide deleted
integrated work.

Fix one of:

- Restore the missing feature branch to the expected remote ref.
- Cancel or repair the umbrella workflow before enqueueing more subtasks.
- If the child should intentionally run outside the umbrella, enqueue it with
  `--as-normal-task`.

## `dependency_cycle`

The requested dependency edge would make tasks wait on each other. Remove or
correct the Linear blocked-by relation, then enqueue again.

## `branch_collision_unresolvable`

Quay could not find an unused `quay/<slug>` branch for the task. Check local
branches, remote branches, and open PRs for the generated branch name.

## `repo_has_active_tasks`

`quay repo remove` refuses to archive a repo while active tasks still reference
it.

Finish, cancel, or park those tasks first. `repo remove` allows terminal and
parked tasks to keep their repo reference.

## `budget_exhausted`

The task has consumed its retry budget. `submit-brief --reason blocker_resolved`
is rejected in this state.

Use one of:

```bash
quay escalate-human <task_id> --claim-id <claim_id> --question-file ./question.md
quay cancel <task_id>
```

After asking a human, use `record-human-reply` to persist the answer, then
`submit-brief --reason advice_answered`; that reason is allowed because it does
not consume retry budget.

## `worktree_error`

Repeated spawn failures parked the task. Inspect:

```bash
quay task get <task_id>
quay task events <task_id>
quay artifact get <task_id> session_log --path
```

Manual recovery is currently cancellation:

```bash
quay cancel <task_id> --keep-worktree
```

## `orchestrator_loop`

The task was claimed repeatedly and the claims expired repeatedly. Inspect the
orchestrator process that owns `task claim` / `submit-brief` /
`escalate-human` / `record-human-reply`.

Manual recovery is cancellation.

## Stale `waiting_human` Claim

Human waits can legitimately outlive the normal claim timeout, so tick does not
auto-release `waiting_human` rows that still have a `claim_id`.

Inspect claimed handoffs:

```bash
quay handoff list --status claimed
quay task get <task_id>
```

If the owning orchestrator is known dead, use the `claim_id` from the handoff
row to reopen the handoff:

```bash
quay task release-claim <task_id> --claim-id <claim_id>
```

The task returns to `awaiting-next-brief`, and another orchestrator can claim it.

## `non_budget_loop`

The task exceeded the configured cap for review/conflict respawns. Inspect the
latest `review_comments` or `conflict_slice` artifact and decide whether to
cancel or recover manually.

For PR review tasks, a `tick_error` containing `reviewer identity mismatch`
means Quay found a review at the PR head SHA, but it was authored by a
different GitHub identity than `[reviewer].login`. Check the actual review
authors with:

```bash
gh api repos/{owner}/{repo}/pulls/{pr_number}/reviews \
  --jq '.[] | select(.commit_id == "{head_sha}") | {state, login: .user.login, type: .user.type, node_id}'
```

Then update `[reviewer].login` to the identity that posts reviews. Use
`login = "app/<slug>"` for GitHub App bot reviews whose API type is `Bot`
and `login = "<slug>"` for regular user reviews whose API type is `User`.
Restart or tick the Quay process after deploying the corrected config.

## Tick Shows `tick_error`

Tick isolates errors per task and continues. Inspect:

```bash
quay task get <task_id>
quay task events <task_id>
```

Many tick errors clear automatically after the next successful observation.
Persistent tick errors usually point to adapter auth, GitHub CLI setup, missing
tmux, or repo/worktree state.

If the error contains `umbrella auto-merge guard failed`, Quay refused to
auto-merge an umbrella subtask PR because the live PR no longer matched the
guarded shape. Common causes are a changed PR base, a missing or stale PR
snapshot, an unapproved review state, or failing checks.

Inspect:

```bash
quay task get <task_id>
gh pr view <pr_number> --repo <owner/repo> --json baseRefName,headRefName,reviewDecision,mergeStateStatus,statusCheckRollup
```

For an auto-mergeable umbrella subtask, the PR base must exactly match
`umbrella_status.feature_branch`, the PR must be approved, and required checks
must be green. Correct the PR base or review/CI state, then run `quay tick`
again. If the task is the final umbrella PR, Quay will not auto-merge it; merge
observation follows the normal final PR lifecycle.

## Failed Blockers With Waiting Dependents

Failed or cancelled blockers do not auto-unblock and do not auto-cancel their
dependents. Waiting dependents remain in `waiting_dependencies` with
unsatisfied rows.

Inspect the dependent and blocker:

```bash
quay task get <dependent_task_id>
quay task get <blocker_task_id>
```

Then decide whether to retry or recover the blocker, cancel the dependent, or
create replacement work and retarget manually. Quay releases the dependent only
when the persisted dependency row is satisfied by the required blocker state.

## Tick Shows `github_backoff_skipped`

`github_backoff_skipped` means Quay has paused background GitHub GraphQL polling
after seeing a GitHub rate-limit exhaustion error. This is a global circuit
breaker for the tick process's GitHub identity, so tasks can skip PR polling
without recording a per-task `tick_error`.

Inspect the current pause window directly:

```bash
sqlite3 "$QUAY_DATA_DIR/quay.db" \
  "SELECT scope, pause_until, reason, observed_at, repo_id FROM github_backoffs;"
```

Active workers are still supervised locally by tmux. PR status updates and
other GitHub-backed background observations resume after `pause_until`.
