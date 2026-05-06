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
retry_budget = 5
agent_invocation = "claude --permission-mode bypassPermissions < {prompt_file}"
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
```

## Keys

| Key | Default | Notes |
| --- | --- | --- |
| `data_dir` | `~/.quay` | Overridden by `QUAY_DATA_DIR` at runtime. |
| `repos_root` | `${data_dir}/repos` | Explicit paths must already exist. |
| `worktree_root` | `${data_dir}/worktrees` | Quay creates the derived default. |
| `max_concurrent` | `2` | Maximum running tasks promoted by tick. |
| `retry_budget` | `5` | Copied onto new tasks at enqueue time. |
| `agent_invocation` | `claude --permission-mode bypassPermissions < {prompt_file}` | Shell command used inside tmux. |
| `max_attempt_duration_seconds` | `3600` | Live worker wall-clock kill threshold. |
| `staleness_threshold_seconds` | `600` | Live worker no-fresh-log kill threshold. |
| `max_spawn_failures` | `3` | Repeated spawn failures before `worktree_error`. |
| `claim_timeout_seconds` | `1800` | Time before a stale orchestrator claim expires. |
| `max_claim_expirations` | `3` | Claim expirations before `orchestrator_loop`. |
| `max_non_budget_respawns` | `20` | Review/conflict respawns before `non_budget_loop`. |
| `tick_lock_path` | `${data_dir}/tick.lock` | Supervisor lock path. |
| `supervisor_lock_stale_seconds` | `30` | Stale lock grace window. |

## Agent Invocation

Quay writes the final prompt to `<worktree>/.quay-prompt.md` before spawning the
worker. If your command uses `{prompt_file}`, Quay replaces it with a
shell-quoted prompt path.

Examples:

```toml
agent_invocation = "claude --permission-mode bypassPermissions < {prompt_file}"
agent_invocation = "my-agent run --prompt {prompt_file}"
```

The command runs inside the task worktree.

## Repos Root Behavior

When `repos_root` is omitted, Quay creates `${data_dir}/repos`.

When `repos_root` is set explicitly, Quay does not create it. A missing explicit
path fails with `repos_root_missing`. This catches typos before enqueueing work.

## Environment Variables

| Variable | Purpose |
| --- | --- |
| `QUAY_DATA_DIR` | Runtime data directory override. |
| `QUAY_CONFIG_DIR` | Directory for `config.toml` and `ticket_schema.toml`. |
| `QUAY_CONFIG_FILE` | Direct config file path. |
| `LINEAR_API_KEY` | Default Linear bot token env var. |
| `SLACK_TOKEN` | Default Slack bot token env var. |
| `QUAY_LINEAR_TIMEOUT_MS` | Linear adapter HTTP timeout. |
| `QUAY_SLACK_TIMEOUT_MS` | Slack adapter HTTP timeout. |
| `QUAY_INTEGRATION_TESTS=1` | Enables network-backed adapter integration tests. |

## Ticket Schema Resolution

`quay validate-ticket` resolves the ticket schema in this order:

1. `--schema-file <path>`
2. `QUAY_CONFIG_DIR/ticket_schema.toml`
3. `$HOME/.quay/ticket_schema.toml`
4. The shipped default schema.

`validate-ticket` is stateless: it does not open the deployment config, DB, or
migrations.
