# Installation

Quay is a Bun + TypeScript CLI. It can be run from source during development or
compiled into a single Bun binary for deployment.

## Build From Source

```bash
bun install
bun test
bun run typecheck
bun run build
./dist/quay --version
```

`bun run build` regenerates the embedded migrations, ticket schema, and version
stamp before compiling `dist/quay`.

## Run From Source

For development:

```bash
bun run quay -- --version
bun run quay -- task list
```

The extra `--` separates Bun script arguments from Quay arguments.

## Runtime Dependencies

The compiled binary does not require Bun on the target host, but Quay shells out
to external tools depending on the workflow:

- `git`: required for repo fetches, branches, and worktrees.
- `tmux`: required by `quay tick` when spawning workers.
- `gh`: required for PR/CI polling and PR cleanup paths.
- The configured worker command: default is `claude --permission-mode bypassPermissions < {prompt_file}`.
- Any command used by a repo's `install_cmd`.

For GitHub, Slack, Linear, worker credential, and scheduler environment setup,
see [External Services Setup](external-services.md).

`quay --version` and `quay validate-ticket` short-circuit before database,
config, and migration setup.

## Data Directory

By default Quay stores data in `~/.quay`. Override it at runtime with:

```bash
export QUAY_DATA_DIR=/var/lib/quay
```

The data directory contains:

- `quay.db`
- `repos/` by default, unless `repos_root` is configured.
- `worktrees/` by default, unless `worktree_root` is configured.
- `artifacts/`
- `tick.lock` by default, unless `tick_lock_path` is configured.

First use creates Quay-owned directories and applies embedded migrations.
Migrations are idempotent.

## Releases

The README includes a placeholder release-download path for `v0.1.0`. Until a
release is tagged and binaries are published, use the build-from-source path.

## CLI Help

The current main command dispatcher does not provide a full `quay --help`
surface. Use [CLI Reference](cli-reference.md) for the current command
inventory.
