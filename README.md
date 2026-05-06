# Quay

Bun + TypeScript implementation of the Quay task lifecycle service.

- Behavior contract: [`docs/quay-spec.md`](docs/quay-spec.md)
- Validator contract: [`docs/quay-spec-ticket-validation.md`](docs/quay-spec-ticket-validation.md)
- Linear/Slack adapters: [`docs/quay-spec-deployment-adapters.md`](docs/quay-spec-deployment-adapters.md)
- Build order: [`docs/quay-tdd-implementation-plan.md`](docs/quay-tdd-implementation-plan.md)

## Quick start

```bash
bun install
bun test
bun run typecheck
```

## CLI surface

```bash
quay tick                                  # one supervisor pass over the queue
quay enqueue --repo <id> --brief-file <p>  # legacy enqueue (operator-composed brief)
quay enqueue --repo <id> --linear-issue <ENG-1234>
                                           # Linear-adapter enqueue (fetch → validate → enqueue)
quay validate-ticket [--ticket-json <p|->] [--schema-file <p>] [--quiet]
                                           # standalone validator: JSON in, JSON out
quay task get <task_id> | task list        # read commands (deterministic JSON)
quay submit-brief | escalate-human | cancel
quay artifact get <artifact_id>            # raw bytes to stdout
```

`quay validate-ticket` runs stateless — it does not open the DB or apply
migrations, so a malformed `~/.quay/config.toml` cannot break validation.

## Configuration

### Deployment config — `~/.quay/config.toml`

Resolution order (first match wins): `$QUAY_CONFIG_FILE`, `$QUAY_CONFIG_DIR/config.toml`,
`$QUAY_DATA_DIR/config.toml`, `~/.quay/config.toml`. A missing file is OK
(defaults apply); an unparseable or schema-invalid file is a hard error.

```toml
# Tick / supervisor knobs (see docs/quay-spec.md §13 for the full set)
data_dir = "/var/lib/quay"
max_concurrent = 4
retry_budget = 5
agent_invocation = "claude < {prompt_file}"

# Linear/Slack adapters (see docs/quay-spec-deployment-adapters.md §4)
[adapters.linear]
enabled = true
api_key_env = "LINEAR_API_KEY"          # name of the env var holding the bot token

[adapters.slack]
enabled = true
bot_token_env = "SLACK_TOKEN"
# max_thread_messages = 200             # fetchThreadContext cap; default 200
```

`[adapters.linear].enabled` gates `quay enqueue --linear-issue`. Without it
the dispatcher returns `adapter_not_enabled`. A configured-but-missing
token (e.g. `LINEAR_API_KEY` unset) surfaces as `adapter_not_configured`.

### Validator schema — `ticket_schema.toml`

Resolution order (first match wins): `--schema-file <path>`,
`$QUAY_CONFIG_DIR/ticket_schema.toml`, `$HOME/.quay/ticket_schema.toml`,
shipped default at [`config/ticket_schema.toml`](config/ticket_schema.toml).
The default mirrors the `quay-config` block 1:1 — one source of truth for
tag/author shape across the validator and the adapter.

### Environment variables

| Var | Purpose |
|---|---|
| `LINEAR_API_KEY` | Linear bot token (rename via `[adapters.linear].api_key_env`) |
| `SLACK_TOKEN` | Slack bot token (rename via `[adapters.slack].bot_token_env`) |
| `QUAY_DATA_DIR` | Override `~/.quay` data root (DB, worktrees, artifacts, lock) |
| `QUAY_CONFIG_DIR` | Override config + schema lookup directory |
| `QUAY_CONFIG_FILE` | Direct path to a config TOML; bypasses dir resolution |
| `QUAY_INTEGRATION_TESTS=1` | Opt in to network-backed adapter tests |

## Layout

```
migrations/       SQL migration files (read at runtime, applied in lex order)
config/           shipped defaults (ticket_schema.toml)
src/
  cli/            entry point + dispatch; production wiring lives in cli/index.ts
  core/           service API: enqueue, tick_once, claim_task, ticket_context, ...
  adapters/       LinearAdapter, SlackAdapter, GitHub CLI, tmux, local git
  validator/      pure validateTicket library + TOML schema loader
  db/             sqlite connection + migration runner
  artifacts/      artifact-store helper
  ports/          interfaces: TmuxPort, GitPort, GitHubPort, SlackPort, LinearPort, Clock, ...
tests/
  support/        harness, fakes, fixtures (test-only)
  schema/ enqueue/ tick/ claim/ cancel/ slack/ pr/ cli/ adapters/ validator/ ticket_context/ quay_config_block/
```

Tests are organized by domain. The full suite runs without network access;
the two adapter integration tests (`linear_adapter_integration.test.ts`,
`slack_adapter_fetch_thread_context.test.ts`) skip unless
`QUAY_INTEGRATION_TESTS=1` is set.
