# Ticket Authoring

`quay enqueue --linear-issue` expects the Linear ticket body to contain one
fenced `quay-config` block. The block gives Quay the metadata it cannot infer
from ordinary prose.

## Example

````markdown
Implement the requested API validation.

```quay-config
tags:
  - backend
  - validation
slack_thread: https://example.slack.com/archives/C123456/p1712345678901234
authors:
  - name: Ada Lovelace
    slack_id: U06TDC56VJB
```
````

`slack_thread` is optional. `authors` is required and must contain at least one
entry.

## Block Rules

- The fence must be exactly `quay-config`.
- Exactly one block is allowed.
- Tabs are rejected in the block indentation.
- `tags` must be a list of strings.
- `authors` must be a non-empty list of objects with `name` and `slack_id`.
- `slack_id` must be a bare Slack user id like `U06TDC56VJB`.
- `slack_thread`, when present, must be a Slack permalink that can be converted
  to `<channel>:<ts>`.

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

Override the schema with `--schema-file` or by placing `ticket_schema.toml` in
`QUAY_CONFIG_DIR` or `$HOME/.quay`.
