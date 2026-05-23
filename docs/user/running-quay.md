# Running Quay

Quay advances work through `quay tick`. The command is one-shot and should be
scheduled externally with cron, systemd, launchd, or another supervisor.

## Tick

```bash
quay tick
```

Output is newline-delimited JSON. Each line describes one task action:

```json
{"task_id":"...","action":"spawned"}
{"task_id":"...","action":"ci_pending"}
```

If another tick or cancel holds the supervisor lock, `quay tick` exits cleanly
without doing work.

## Admin API

```bash
quay serve
quay serve --host 127.0.0.1 --port 9731
quay serve --ui-dir ../quay-ui/dist
```

`quay serve` starts the local Admin HTTP API using the same config, data
directory, migrations, and repo registry as the rest of the CLI. The server
binds to `127.0.0.1:9731` by default and prints one JSON line with the bound
URL. `--host` only accepts loopback addresses (`127.0.0.1`, `::1`, or
`localhost`); non-loopback binds are rejected because the Admin API is
unauthenticated and exposes local repo registry data plus a narrow structured
write surface.

Release binaries include an embedded production Quay UI bundle. With those
binaries, `quay serve` hosts the Admin UI and injects same-origin API runtime
config before the UI app loads, so browser requests go to the serving Quay
process under `/v1/*`.

Pass `--ui-dir <path>` to override the embedded UI with a built Quay UI bundle
from disk:

```bash
cd ../quay-ui
bun run build

cd ../quay
quay serve --ui-dir ../quay-ui/dist
```

The UI directory must exist, be readable, and contain a readable `index.html`.
When embedded UI assets or `--ui-dir` are enabled, Quay serves static files and
returns `index.html` for non-API SPA routes such as `/repos/example`. Versioned
Admin API paths under `/v1/*` keep precedence over static files and are never
served from UI assets. Missing static asset paths such as `/assets/app.js`
return 404 instead of falling back to the SPA entrypoint.

Initial endpoints:

- `GET /v1/meta`
- `GET /v1/repos`
- `GET /v1/repos/<repo_id>`
- `GET /v1/global`
- `GET /v1/tags`
- `GET /v1/matrix`
- `POST /v1/changes/preview`
- `POST /v1/changes/apply`

Writes are limited to structured Admin UI change requests that Quay validates
and fences with the read-model revision returned by the API. Clients should
preview a change set before applying it, and must reload when the server returns
`stale_revision`.

The API returns JSON and uses a stable error envelope:

```json
{"error":"repo_not_found","message":"repo \"example\" not found"}
```

The versioned contract is owned in `docs/api/openapi.yaml`. UI clients should
target the `/v1/*` paths from that contract and should not call CLI commands or
depend on `hermes-agent`.

Browser clients are supported from these local development origins:

- `http://localhost:3000`
- `http://127.0.0.1:3000`
- `http://localhost:4173`
- `http://127.0.0.1:4173`
- `http://localhost:5173`
- `http://127.0.0.1:5173`

The IPv6 loopback form (`http://[::1]:<port>`) is also allowed for the same
ports. Other origins receive `cors_origin_not_allowed`.

## What Tick Processes

Each cycle:

1. Finalizes tasks with `cancel_requested_at`.
2. Sweeps `queued` / `running` tasks with a known Quay-owned PR: if the PR was
   closed unmerged (typically a human closing it mid-respawn), kills any live
   worker session and finalizes to `closed_unmerged` before promotion or
   dead-worker classification can spawn another attempt.
3. Observes `running` workers.
4. Polls `pr-open` tasks for PR state, conflicts, and CI.
5. Polls `done` tasks for PR state, conflicts, and review feedback.
6. Releases stale orchestrator claims.
7. Handles claimless legacy `waiting_human` rows, either through the old Slack
   path or by requeueing rows that have no thread.
8. Reaps and spawns `pr-review` reviewer attempts up to
   `max_concurrent_reviewers` when `[reviewer].enabled = true`.
9. Promotes `queued` tasks to `running` up to `max_concurrent`.

Tasks that become `queued` during a tick are not promoted until a later tick.

## Worker Contract

Quay writes the final prompt to `.quay-prompt.md` in the worktree, then starts a
tmux session. The worker should:

- Work inside the task worktree.
- Push the `quay/<slug>` branch.
- Open a PR if one does not already exist.
- Exit after opening/updating the PR.
- In goal mode, write `.quay-goal-report.json` instead of opening a PR when
  reporting `complete`, `active`, or `blocked`.
- If blocked, write a non-empty UTF-8 `.quay-blocked.md` and exit.
- Avoid interactive tools.

Quay reserves `.quay-*` files except for `.quay-blocked.md` and, in goal mode,
`.quay-goal-report.json`.

## Running State Outcomes

When the worker dies, tick collects the session log and checks:

- Valid `.quay-blocked.md`: stores `blocker`, transitions to
  `awaiting-next-brief`.
- Malformed `.quay-blocked.md`: stores `malformed_signal`, schedules a retry.
- Valid goal report with `status: "complete"`: captures cited evidence and
  transitions to `goal-completion-pending`; the next tick audits the report
  before allowing PR lifecycle states.
- Malformed goal report: stores `malformed_goal_report`, schedules a
  non-budget protocol repair retry, and blocks after repeated malformed
  reports.
- PR exists and progress was made: transitions to `pr-open`.
- Existing PR but no trackable progress: schedules a crash retry.
- No PR and no blocker: schedules a crash retry.

Live workers are killed and retried when they exceed
`max_attempt_duration_seconds` or stop producing fresh log output past
`staleness_threshold_seconds`.

## PR And CI Outcomes

For `pr-open`:

- Merged PR: terminal `merged`.
- Closed unmerged PR: terminal `closed_unmerged`.
- Merge conflict: schedules a non-budget `conflict` respawn.
- CI pending: remains `pr-open`.
- CI passed: transitions to `done`, unless the reviewer gate is enabled; then
  tick schedules a `review_only` attempt and transitions to `pr-review`.
- CI failed: schedules a budget-consuming `ci_fail` retry.

For `pr-review`:

- Reviewer approval: transitions to `done`.
- Reviewer changes requested on a Quay-owned PR: schedules a non-budget
  `review` respawn and returns to `queued`.
- Reviewer changes requested on a synthetic PR: transitions to
  `waiting_external_changes`; tick keeps polling the PR by number and schedules
  a fresh `review_only` attempt when the PR head SHA changes. CI/webhook/manual
  `quay review-pr` calls are safe idempotent pokes, not required re-entry.
- Reviewer infrastructure failures retry at the same SHA twice, then park in
  `non_budget_loop`.

For `done`:

- Merged PR: terminal `merged`.
- Closed unmerged PR: terminal `closed_unmerged`.
- Synthetic PR with a new head SHA: returns to `pr-review` with one fresh
  `review_only` attempt.
- Merge conflict: schedules a non-budget `conflict` respawn.
- Latest review decision `CHANGES_REQUESTED`: schedules a non-budget
  `review` respawn.

`done` means CI passed and Quay is waiting for human merge/review. It is not a
terminal state.

## Claims And Human Escalation

An orchestrator claims a task in `awaiting-next-brief`:

```bash
quay task claim <task_id>
```

Then it either submits a new brief:

```bash
quay submit-brief <task_id> \
  --claim-id <claim_id> \
  --brief-file ./next-brief.md \
  --reason blocker_resolved
```

Or escalates to a human:

```bash
quay escalate-human <task_id> \
  --claim-id <claim_id> \
  --question-file ./question.md \
  --thread-ref C123456:1712345678.901234
```

After the orchestrator receives the human answer:

```bash
quay record-human-reply <task_id> \
  --claim-id <claim_id> \
  --reply-file ./reply.md \
  --thread-ref C123456:1712345678.901234

quay submit-brief <task_id> \
  --claim-id <claim_id> \
  --brief-file ./next-brief.md \
  --reason advice_answered
```

`submit-brief --reason blocker_resolved` consumes retry budget when promoted.
`submit-brief --reason advice_answered` does not.

Stale claims return to `awaiting-next-brief`. Repeated stale claims park the
task in `orchestrator_loop`.

## Cancellation

```bash
quay cancel <task_id>
quay cancel <task_id> --close-pr
quay cancel <task_id> --keep-worktree
```

Cancel acquires the supervisor lock, writes durable cancel intent, kills a live
worker if needed, performs cleanup, and transitions the task to `cancelled`.

`--close-pr` asks GitHub to close the PR and deletes the remote branch.
Without `--close-pr`, Quay preserves the remote branch when it sees an open PR.

`--keep-worktree` detaches the worktree instead of removing it.
