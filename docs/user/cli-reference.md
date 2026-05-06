# CLI Reference

The main command surface is implemented by `src/cli/dispatch.ts`. The older
spec docs may lag behind this list.

## Output Conventions

- Successful read commands print JSON to stdout.
- Successful write commands print JSON to stdout.
- Write-command failures print JSON to stderr and exit non-zero.
- `quay tick` prints newline-delimited JSON, one action per line.
- `quay artifact get` streams raw artifact bytes unless `--path` is used.

## Global

```bash
quay --version
quay -v
```

`--version` short-circuits before config, DB, and migrations.

## Repo

```bash
quay repo add \
  --id <repo_id> \
  --url <repo_url> \
  --base-branch <branch> \
  --package-manager <name> \
  --install-cmd <cmd> \
  [--test-cmd <cmd>] \
  [--ci-workflow-name <name>] \
  [--contribution-guide-path <path>]

quay repo update <repo_id> [flags]
quay repo update --id <repo_id> [flags]
quay repo remove <repo_id>
quay repo list
quay repo export [--out <path>]
quay repo import --in <path>
```

`repo add` and `repo update` also accept `--input <json>` for structured
automation.

## Enqueue

Manual brief:

```bash
quay enqueue \
  --repo <repo_id> \
  --brief-file <path> \
  [--ticket-snapshot-file <path>] \
  [--external-ref <ref>] \
  [--slack-thread-ref <channel:ts>]
```

Linear:

```bash
quay enqueue \
  --repo <repo_id> \
  --linear-issue <identifier> \
  [--tag <tag>]...
```

`--linear-issue` is mutually exclusive with `--brief-file`, `--external-ref`,
and `--slack-thread-ref`.

## Tick

```bash
quay tick
```

No flags are currently accepted.

## Tasks

```bash
quay task list [--state <state>]... [--repo <repo_id>] [--external-ref <ref>]
quay task get <task_id>
quay task events <task_id>
quay task claim <task_id>
quay task release-claim <task_id> --claim-id <claim_id>
```

`task claim` only succeeds for `awaiting-next-brief` tasks.

## Submit Brief

```bash
quay submit-brief <task_id> \
  --claim-id <claim_id> \
  --brief-file <path> \
  --reason <blocker_resolved|advice_answered>
```

`blocker_resolved` consumes retry budget when promoted. `advice_answered` does
not.

## Escalate Human

```bash
quay escalate-human <task_id> \
  --claim-id <claim_id> \
  --question-file <path> \
  [--thread-ref <channel:ts>]
```

If `--thread-ref` is omitted, the task must already have `slack_thread_ref`.

## Cancel

```bash
quay cancel <task_id> [--close-pr] [--keep-worktree]
```

Unknown cancel flags are rejected. Boolean cancel flags do not accept values.

## Artifacts

```bash
quay artifact get <task_id> <kind> [--attempt <n>] [--path]
```

Without `--path`, stdout is the artifact body as raw bytes. With `--path`,
stdout is the on-disk artifact path.

## Validate Ticket

```bash
quay validate-ticket [--ticket-json <path|->] [--schema-file <path>] [--quiet]
```

If `--ticket-json` is omitted or set to `-`, input is read from stdin.

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Valid ticket. |
| `1` | Ticket validation failed. |
| `2` | Usage or schema error. |
| `3` | Input read or JSON error. |
