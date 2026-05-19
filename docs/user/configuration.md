# Configuration

Production configuration is TOML.

## Config File Resolution

Quay looks for the deployment config in this order:

1. `QUAY_CONFIG_FILE`
2. `QUAY_CONFIG_DIR/config.toml`
3. `QUAY_DATA_DIR/config.toml`
4. `~/.quay/config.toml`

A missing config file is allowed. An invalid TOML file or unknown config key is
a hard error.

## Example

```toml
data_dir = "/var/lib/quay"
repos_root = "/var/lib/quay/repos"
worktree_root = "/var/lib/quay/worktrees"
max_concurrent = 2
max_concurrent_reviewers = 2
retry_budget = 5
max_attempt_duration_seconds = 3600
staleness_threshold_seconds = 600
max_spawn_failures = 3
claim_timeout_seconds = 1800
max_claim_expirations = 3
max_non_budget_respawns = 20
tick_lock_path = "/var/lib/quay/tick.lock"
supervisor_lock_stale_seconds = 30

[adapters.linear]
enabled = true
api_key_env = "LINEAR_API_KEY"

[adapters.slack]
enabled = true
bot_token_env = "SLACK_TOKEN"
max_thread_messages = 200

[context]
reference_repos_root = "/home/hermes/.hermes/code"

[reviewer]
enabled = false
gate_quay_owned_done = false
# Preferred reviewer token source: QUAY_REVIEWER_GH_TOKEN in tick env.
# gh_token_file = "/run/hermes/reviewer-gh-token" # fallback during migration

[agents]
worker = "claude"
reviewer = "claude"
# worker_model = "claude-opus-4-1"
# reviewer_model = "claude-opus-4-1"

[agents.invocations.claude]
worker = "claude --permission-mode bypassPermissions --output-format json --debug --debug-file .quay-tool-trace.log < {prompt_file} > .quay-usage.json"
reviewer = "claude --permission-mode bypassPermissions --output-format json < {prompt_file} > .quay-usage.json"
```

## Keys

| Key | Default | Notes |
| --- | --- | --- |
| `data_dir` | `~/.quay` | Overridden by `QUAY_DATA_DIR` at runtime. |
| `repos_root` | `${data_dir}/repos` | Explicit paths must already exist. |
| `worktree_root` | `${data_dir}/worktrees` | Quay creates the derived default. |
| `max_concurrent` | `2` | Maximum running tasks promoted by tick. |
| `max_concurrent_reviewers` | `2` | Maximum running reviewer workers. Independent of `max_concurrent`. |
| `retry_budget` | `5` | Copied onto new tasks at enqueue time. |
| `agent_invocation` | unset | Legacy shorthand for `[agents.invocations.claude].worker` and `.reviewer`. Prefer `[agents]` for new deployments. |
| `[agents].worker` / `[agents].reviewer` | `claude` | Global role defaults. Each value names an entry under `[agents.invocations]`. |
| `[agents].worker_model` / `[agents].reviewer_model` | unset | Optional global role model defaults. Quay injects these as `--model <value>` for supported runtimes (`claude`, `codex`). For `hermes_*` runtimes the model is selected through Hermes' own YAML config; Quay records the value on the attempt row but does not append `--model`. |
| `max_attempt_duration_seconds` | `3600` | Live worker wall-clock kill threshold. |
| `staleness_threshold_seconds` | `600` | Live worker no-fresh-log kill threshold. |
| `max_spawn_failures` | `3` | Repeated spawn failures before `worktree_error`. |
| `claim_timeout_seconds` | `1800` | Time before a stale orchestrator claim expires. |
| `max_claim_expirations` | `3` | Claim expirations before `orchestrator_loop`. |
| `max_non_budget_respawns` | `20` | Review/conflict respawns before `non_budget_loop`. |
| `tick_lock_path` | `${data_dir}/tick.lock` | Supervisor lock path. |
| `supervisor_lock_stale_seconds` | `30` | Stale lock grace window. |
| `[context].reference_repos_root` | unset | Optional root containing read-only working-tree mirrors. Immediate child repos are listed in worker and reviewer prompts. |

## Reviewer

```toml
[reviewer]
enabled = true
gate_quay_owned_done = false
# login = "quay-bot"
# gh_token_file = "/run/hermes/reviewer-gh-token" # fallback during migration
```

`enabled` turns on the reviewer subsystem, including `quay review-pr` and the
reviewer spawn pass in `quay tick`. `gate_quay_owned_done` changes Quay-owned
PRs from the legacy `pr-open -> done` CI-green transition to `pr-open ->
pr-review -> done`, where the final transition requires an approved Quay
review. Synthetic PR reviews still work when the gate is false.

`login` is the gh login tick matches posted reviews against when it ingests a
finished reviewer attempt. Defaults to whatever `gh api user --jq .login`
returns in the tick process. Set it explicitly when the reviewer worker
authenticates as a different gh identity than tick (for example, when tick
runs as the deployment service account and the worker posts under a dedicated
bot account); leaving it unset in that setup will silently never match the
posted review and park the task in `non_budget_loop` after the infra-failure
retry budget runs out.

Both regular user accounts and GitHub App identities are supported. Use the
form that matches the reviewer's actual GitHub identity:

- `login = "<slug>"` (bare) for a regular user account.
- `login = "app/<slug>"` for a GitHub App identity (e.g. an installation
  token used by a bot account).

Tick distinguishes the two via the review author's account type as reported
by the GitHub API (`user.type` of `Bot` for App authors, `User` for regular
accounts) — not just the login string. This means a same-named regular user
*cannot* satisfy a gate configured against `app/<slug>`, and vice versa.

Reviewer panes must authenticate to GitHub as a different identity than the
worker that opened the PR. GitHub refuses self-review, so Quay fails reviewer
spawns before promotion unless it has a reviewer-specific token source.

Preferred deployment shape:

```bash
export GH_TOKEN="<worker-runtime-app-token>"
export QUAY_REVIEWER_GH_TOKEN="<reviewer-app-token>"
exec quay tick
```

Worker panes keep using `GH_TOKEN`. When only `GITHUB_TOKEN` is set, Quay
promotes that value to pane-local `GH_TOKEN` and clears `GITHUB_TOKEN` so
GitHub CLI calls have one canonical token source. Quay also places a per-spawn
`gh` wrapper first on `PATH`; the wrapper lives outside the git checkout, reads
Quay's fresh token source from an outside-worktree file, and runs the real `gh`
with `GH_TOKEN` set and `GITHUB_TOKEN` cleared. Stale token variables sourced
later inside an agent shell cannot poison `gh pr list/create`, and `git add .`
from the worker cannot stage the generated credential file.

Reviewer panes receive `QUAY_REVIEWER_GH_TOKEN` as their pane-local
`GH_TOKEN`, and Quay removes the source variable from the pane environment
before launching the agent. The reviewer token is probed against the target
repository before the review attempt is promoted. Invalid, expired, empty,
missing, or repo-inaccessible tokens fail as `spawn_substrate_failed` and stay
out of the reviewer `review_infra_failed` retry accounting.

`gh_token_file` is a migration fallback used only when
`QUAY_REVIEWER_GH_TOKEN` is unset. The file is expected mode `0600`, read fresh
on every reviewer spawn, `cat`'d inside the pane, and exported as `GH_TOKEN`.
The path lands in the pane wrapper script, but token bytes themselves never
appear in any process argv. Rotation is transparent: write the new token to the
file and the next reviewer attempt picks it up.

## Agent Invocation

Quay resolves agent/model selection in this order:

```text
task override > repo role default > global role default
```

Task overrides come from `quay enqueue --worker-agent`, `--worker-model`,
`--reviewer-agent`, and `--reviewer-model`. Synthetic review tasks scheduled by
`quay review-pr` support `--reviewer-agent` and `--reviewer-model`. Repo role
defaults are set with `quay repo add/update --agent-worker`,
`--agent-reviewer`, `--model-worker`, and `--model-reviewer`.

Quay snapshots the resolved worker and reviewer agent/model on the task row at
enqueue or synthetic review scheduling time. Later config changes do not alter
already-queued tasks. Successful spawns record the resolved `agent_name` and
`agent_model` on the attempt row.

Quay writes the final prompt to `<worktree>/.quay-prompt.md` before spawning an
agent. If your command uses `{prompt_file}`, Quay replaces it with a
shell-quoted prompt path.

For Codex-backed agents (`codex` and `hermes_codex*`), Quay sets `CODEX_HOME`
to an outside-worktree per-task directory next to the checkout root. Quay seeds
that isolated home from the operator's configured Codex home (`$CODEX_HOME`, or
`$HOME/.codex` when unset) but deliberately skips `shell_snapshots`. Existing
Codex auth/config stays available while stale shell snapshots are scoped away
from future tasks.

Examples:

```toml
agent_invocation = "claude --permission-mode bypassPermissions --output-format json --debug --debug-file .quay-tool-trace.log < {prompt_file} > .quay-usage.json"

[agents]
worker = "codex"
worker_model = "gpt-5.5"
reviewer = "claude"
reviewer_model = "claude-opus-4-1"

[agents.invocations.codex]
worker = "codex exec --json --dangerously-bypass-approvals-and-sandbox < {prompt_file} > .quay-tool-trace.log"
reviewer = "codex exec --json --dangerously-bypass-approvals-and-sandbox < {prompt_file} > .quay-tool-trace.log"

[agents.invocations.claude]
worker = "claude --permission-mode bypassPermissions --output-format json --debug --debug-file .quay-tool-trace.log < {prompt_file} > .quay-usage.json"
reviewer = "claude --permission-mode bypassPermissions --output-format json < {prompt_file} > .quay-usage.json"
```

The command runs inside the task worktree.

The default invocation writes two worktree-local files which Quay captures as
per-attempt artifacts:

- `.quay-usage.json` — the JSON envelope claude prints under `--output-format
  json`. Captured as the `usage` artifact (`quay artifact get <task_id> usage`).
- `.quay-tool-trace.log` — the debug stream from `--debug --debug-file`.
  Captured as the `tool_trace` artifact (`quay artifact get <task_id> tool_trace`).
  When the file contains Codex `--json` JSONL events, Quay also synthesizes a
  normalized `usage` artifact from any model/token totals in that stream.

If you replace the default with a different agent runtime, write the same two
filenames (or omit the redirects to skip those captures). Quay reads the files
by name, not by runtime. A valid `.quay-usage.json` remains authoritative; the
Codex JSONL normalizer only runs when that direct usage envelope is absent.

### Hermes-Backed Codex

Quay can run Codex through Hermes' app-server runtime instead of invoking
`codex exec` directly. The advantage is that Hermes owns the Codex runtime
plumbing (JSONL parsing, noninteractive behaviour, future Codex changes) and
can expose extra tools — including a browser toolset — back into Codex via
MCP. Quay still owns task lifecycle, prompt composition, and artifact capture.

```toml
[agents]
worker = "hermes_codex"
reviewer = "hermes_codex"

[agents.invocations.hermes_codex]
worker = "hermes chat --quiet --query-file {prompt_file} --toolsets file,terminal"
reviewer = "hermes chat --quiet --query-file {prompt_file} --toolsets file,terminal"

[agents.invocations.hermes_codex_browser]
worker = "hermes chat --quiet --query-file {prompt_file} --toolsets file,terminal,browser,vision"
```

Hermes' stdout under `--quiet` lands in `.quay-session.log` via tmux
pipe-pane and is available as the `pane_log` artifact. If your Hermes
build can emit Codex's structured JSONL stream to a worktree file,
redirect or tee it to `.quay-tool-trace.log` and Quay will normalize
model + token totals into the `usage` artifact via the same code path used
for direct `codex exec`. Without that redirect, the final response and tool
flow are still recoverable from the pane log; only the normalized usage
envelope is missing.

The browser variant is registered as a separate invocation so an operator can
opt repos or individual tasks into browser tooling without flipping it on
globally. Select it per-repo with `quay repo update --agent-worker
hermes_codex_browser` or per-task with `quay enqueue --worker-agent
hermes_codex_browser`.

Hermes selects the Codex model through its own YAML (`model.openai_runtime:
codex_app_server` plus the chosen `model:` entry), so `worker_model` /
`reviewer_model` on the `[agents]` block are recorded on the attempt row for
attribution but never appended to the invocation as `--model`. The runtime
model the agent actually used is also backfilled from the Codex JSONL trace
into `attempts.agent_model` when not set explicitly.

**Tradeoff: direct `codex exec` vs `hermes_codex`.** Direct `codex exec`
keeps Quay's substrate minimal and avoids the Hermes dependency; pick it
when Hermes is not deployed alongside Quay or when you want to debug Codex
behaviour without an extra runtime in the loop. `hermes_codex` is preferred
when you want browser tooling, Hermes' MCP tool exposure, or a single
upgrade path as Codex's runtime evolves. Both invocation types can coexist:
register both blocks and select per-repo or per-task.

**Failure modes.** Hermes is treated as an external prerequisite — Quay does
not bootstrap it. A missing `hermes` binary, an unreadable Hermes config, or
a misconfigured app-server runtime surfaces in the pane log
(`.quay-session.log`) and on `.quay-exit-code`; the dead-worker classifier
records the exit and the operator follows up with `hermes config show` or
similar. Browser-toolset configuration (local Chromium, Browser Use,
Browserbase credentials) lives on the Hermes side; Quay does not validate it.

## Repos Root Behavior

When `repos_root` is omitted, Quay creates `${data_dir}/repos`.

When `repos_root` is set explicitly, Quay does not create it. A missing explicit
path fails with `repos_root_missing`. This catches typos before enqueueing work.

## Reference Repos Context

When `[context].reference_repos_root` is set, Quay looks for immediate child
directories that contain `.git` and adds them to generated worker and reviewer
prompts as read-only context. Missing, unreadable, or empty roots do not block
enqueue or review; empty roots render an explicit `(none discovered)` list.

## Environment Variables

| Variable | Purpose |
| --- | --- |
| `QUAY_DATA_DIR` | Runtime data directory override. |
| `QUAY_CONFIG_DIR` | Directory for `config.toml` and `ticket_schema.toml`. |
| `QUAY_CONFIG_FILE` | Direct config file path. |
| `LINEAR_API_KEY` | Default Linear bot token env var. |
| `SLACK_TOKEN` | Default Slack bot token env var. |
| `QUAY_REVIEWER_GH_TOKEN` | Reviewer-specific GitHub token exported as `GH_TOKEN` only for reviewer panes. |
| `QUAY_LINEAR_TIMEOUT_MS` | Linear adapter HTTP timeout. |
| `QUAY_SLACK_TIMEOUT_MS` | Slack adapter HTTP timeout. |
| `QUAY_INTEGRATION_TESTS=1` | Enables network-backed adapter integration tests. |

## Ticket Schema Resolution

`quay validate-ticket` resolves the ticket schema in this order:

1. `--schema-file <path>`
2. `QUAY_CONFIG_DIR/ticket_schema.toml`
3. `$HOME/.quay/ticket_schema.toml`
4. The shipped default schema.

`validate-ticket` skips the dispatcher's adapter wiring for fast spawns. It
opens the Quay DB lazily — only when the ticket payload's `repo` is
registered and has per-repo tag vocab configured — to enforce the layered
deployment + per-repo namespaces. The deployment config IS read in that
case so `data_dir` from `~/.quay/config.toml` is honored. A missing data
dir or unconfigured repo degrades cleanly to "no enforcement".
