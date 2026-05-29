# Ticket Authoring

`quay enqueue --linear-issue` expects the Linear ticket body to contain one
fenced `quay-config` block. The block gives Quay the metadata it cannot infer
from ordinary prose.

## Example

````markdown
Implement the requested API validation.

```quay-config
repo: hermes-agent
base_branch: dev
tags:
  - backend
  - validation
slack_thread: https://example.slack.com/archives/C123456/p1712345678901234
authors:
  - name: Ada Lovelace
    slack_id: U06TDC56VJB
worker_execution: goal
umbrella:
  external_ref: BRIX-1500
  feature_branch: quay/umbrella/BRIX-1500
  depends_on:
    - BRIX-1498
```
````

`base_branch`, `slack_thread`, `worker_execution`, and `umbrella` are optional.
`base_branch` overrides the repo default for this task only; Quay branches from
`origin/<base_branch>` and instructs the worker to open the PR into that branch.
`worker_execution` defaults to `oneshot`; set it to `goal` when the task should
use durable goal mode and continue across worker attempts. `authors` is
required and must contain at least one entry.

`umbrella` enrolls the Linear issue as a subtask in a one-repo umbrella
workflow. `umbrella.external_ref` identifies the overall workflow. If
`umbrella.feature_branch` is omitted, Quay derives a deterministic
`quay/umbrella/<slug>` branch and creates it from the umbrella base branch.
Subtask PRs target the feature branch, not the repository base branch.
`umbrella.depends_on` lists other umbrella subtask external refs that must be
merged into the feature branch before this subtask can spawn.

## Block Rules

- The fence must be exactly `quay-config`.
- Exactly one block is allowed.
- Tabs are rejected in the block indentation.
- `tags` must be a list of strings.
- `base_branch`, when present, must be a git branch name, not a full ref.
- `authors` must be a non-empty list of objects with `name` and `slack_id`.
- `slack_id` must be a bare Slack user id like `U06TDC56VJB`.
- `slack_thread`, when present, must be a Slack permalink that can be converted
  to `<channel>:<ts>`.
- `worker_execution`, when present, must be `oneshot` or `goal`.
- `umbrella.external_ref` must be a non-empty string when `umbrella` is present.
- `umbrella.base_branch` and `umbrella.feature_branch`, when present, must be
  branch names, not full refs.
- `umbrella.depends_on`, when present, must be a list of non-empty strings.

## Validation

Validate a ticket-shaped JSON payload:

```bash
echo '{"body":"Implement...","tags":["backend"],"authors":[{"name":"Ada","slack_id":"U06TDC56VJB"}],"external_ref":"ENG-1234"}' \
  | quay validate-ticket
```

Validate from a file:

```bash
quay validate-ticket --ticket-json ./ticket.json
```

Use a custom schema:

```bash
quay validate-ticket --schema-file ./ticket_schema.toml --ticket-json ./ticket.json
```

Quiet mode uses exit codes without stdout:

```bash
quay validate-ticket --ticket-json ./ticket.json --quiet
```

## Validate-Ticket Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | Valid input. |
| `1` | Validation errors. |
| `2` | Schema or usage error. |
| `3` | Input file or JSON error. |

Invalid ticket content is printed on stdout as:

```json
{"valid":false,"errors":[...]}
```

Schema and input errors are printed on stderr as:

```json
{"error":"schema_error","message":"..."}
```

## Default Schema

The shipped default schema requires:

- `body`: string, 10 to 50000 chars.
- `tags`: unique lowercase alphanumeric/dash strings, at least one.
- `authors`: at least one object with `name` and `slack_id`.

Optional:

- `slack_thread`: `<channel>:<ts>`
- `external_ref`: string
- `worker_execution`: `oneshot` or `goal`
- `base_branch`: task-level PR base override

Override the schema with `--schema-file` or by placing `ticket_schema.toml` in
`QUAY_CONFIG_DIR` or `$HOME/.quay`.

## Per-Repo Tag Vocabulary (Opt-In)

When a ticket's target repo has any per-repo tag vocabulary configured (via
`quay repo set-tags` or `quay repo apply-tags` — see
[Repositories](repositories.md#tag-vocabulary)), the validator enforces an
extra layer on top of the schema's `tags` field:

- Each tag is parsed as `<namespace>-<value>`, splitting on the first `-`.
  Namespaces match `[a-z0-9]+` (no dashes); values may use `[a-z0-9-]+`.
- Each `(namespace, value)` pair must appear in the merged (deployment ∪
  per-repo) vocab.
- A namespace marked `required` (in either layer; deployment-required wins)
  must have at least one matching tag in the list.

Repos with no per-repo vocab keep the legacy charset/min/unique-only
behavior; deployment-level required namespaces only bind opted-in repos.
Use `quay tags list --repo <id>` to inspect the merged vocab and the
`enforced` flag for a given repo.

Additional error codes the validator may return when enforcement is on:

| Code | Meaning |
| --- | --- |
| `TAG_UNKNOWN_NAMESPACE` | Tag is unparseable, or its namespace prefix isn't in the merged vocab. |
| `TAG_UNKNOWN_VALUE` | Namespace is known but the value isn't in its permitted set. |
| `TAG_REQUIRED_MISSING` | A required namespace has no representative tag in the list. |
