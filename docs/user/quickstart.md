# Quickstart

This walkthrough creates a local demo repo, registers it with Quay, enqueues a
brief, and runs enough ticks to see Quay spawn a worker and ingest a blocker.
It does not require Linear, Slack, GitHub, or a real coding agent.

## Prerequisites

- Bun 1.1 or newer to build from source.
- `git`.
- `tmux`.

## Build Quay

From this repo:

```bash
bun install
bun run build
./dist/quay --version
```

For source-mode development, replace `./dist/quay` below with:

```bash
bun run quay --
```

## Create A Demo Data Directory

```bash
export QUAY_DATA_DIR=/tmp/quay-demo/data
rm -rf /tmp/quay-demo
mkdir -p "$QUAY_DATA_DIR"
```

Create a config file with a fake worker. The fake worker reads the prompt file,
writes a blocker signal, and exits. The second tick ingests that blocker.

```bash
cat > "$QUAY_DATA_DIR/config.toml" <<'TOML'
max_concurrent = 1
agent_invocation = "cat {prompt_file} > .quay-demo-prompt.md; printf 'Need a real coding agent for this task.\n' > .quay-blocked.md"
TOML
```

## Create A Local Repo And Bare Clone

```bash
mkdir -p /tmp/quay-demo/source
git init -b main /tmp/quay-demo/source
cd /tmp/quay-demo/source
printf 'hello\n' > README.md
git add README.md
git -c user.name='Quay Demo' -c user.email='quay-demo@example.com' commit -m init

mkdir -p "$QUAY_DATA_DIR/repos"
git clone --bare /tmp/quay-demo/source "$QUAY_DATA_DIR/repos/demo.git"
```

## Register The Repo

```bash
cd /path/to/quay

./dist/quay repo add \
  --id demo \
  --url /tmp/quay-demo/source \
  --base-branch main \
  --package-manager demo \
  --install-cmd true
```

The command emits a JSON repo row.

## Enqueue A Task

```bash
cat > /tmp/quay-demo/brief.md <<'MD'
Add a short sentence to README.md.
MD

./dist/quay enqueue \
  --repo demo \
  --brief-file /tmp/quay-demo/brief.md \
  --external-ref DEMO-1
```

The command emits JSON containing `task_id`, `state`, `branch_name`,
`tmux_id`, `worktree_path`, and `attempt_id`.

Copy the `task_id` from the enqueue output:

```bash
export TASK_ID=<task_id_from_enqueue_output>
```

## Run Ticks

First tick: promotes `queued` to `running` and starts the tmux worker.

```bash
./dist/quay tick
```

Second tick: observes that the fake worker exited and ingests
`.quay-blocked.md`.

```bash
./dist/quay tick
```

Inspect the task:

```bash
./dist/quay task get "$TASK_ID"
./dist/quay task events "$TASK_ID"
./dist/quay artifact get "$TASK_ID" blocker
```

Expected end state for this demo is `awaiting-next-brief`, because the fake
worker deliberately blocked instead of opening a PR.

## Clean Up

```bash
rm -rf /tmp/quay-demo
```
