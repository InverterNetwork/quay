# Slice 12: `task_tags` table and `tasks.authors_json` column

## Required reading

1. `docs/quay-spec-deployment-adapters.md` §5 — schema additions. **The
   authority for this slice.**
2. `docs/quay-spec.md` §9 — substrate persistence layer (constraints,
   migration runner pattern).
3. `docs/ralph/RUNBOOK.md`.

## Goal

Land the schema additions the deployment-adapters spec owns:

- A new `task_tags` table.
- A new nullable `authors_json TEXT` column on the existing `tasks`
  table.

Both shipped in a single migration file. SQLite enforces the
constraints at the database level. No application code consumes these
yet — that comes in slices 14–16 (port fakes, `ticketContext.fetch`,
`quay enqueue --linear-issue`) and slice 19 (escalation @-mentions).

This slice is intentionally schema-only. The PR-review spec assumes
`task_tags` exists when its own implementation lands; landing the
table here is the substrate the adapter spec, the PR-review spec,
and the worker-self-serve `quay query-findings` CLI all build on.

## Red tests (must exist with these names and must pass)

Place tests under `tests/schema/`. Test names match this table exactly.

| Test name | Proves |
|---|---|
| `test_schema_creates_task_tags_table` | Migration creates `task_tags(task_id, tag, created_at)` with `PRIMARY KEY (task_id, tag)` and `FOREIGN KEY task_id REFERENCES tasks(task_id)`. |
| `test_schema_task_tags_index_by_tag_exists` | `CREATE INDEX task_tags_by_tag ON task_tags(tag)` is present and queryable. |
| `test_schema_task_tags_rejects_duplicate_pair` | Inserting two rows with the same `(task_id, tag)` is rejected by the primary key. |
| `test_schema_task_tags_rejects_orphan_task_id` | Inserting a `task_tags` row referencing a missing `task_id` is rejected by the foreign key. |
| `test_schema_task_tags_cascades_or_rejects_on_task_delete` | Deleting a task with associated `task_tags` rows is either rejected by FK or cascades — whichever the migration chooses, encode it in the test (the spec doesn't dictate; pick rejection for safety and document). |
| `test_schema_tasks_has_authors_json_column` | `tasks.authors_json` exists, is nullable, and stores arbitrary JSON-serialized text. |
| `test_schema_tasks_authors_json_defaults_null_for_existing_rows` | The migration ALTER does not require backfilling existing `tasks` rows; they stay with `authors_json IS NULL`. |
| `test_schema_migration_is_idempotent_on_rerun` | Re-running the migration runner against an already-migrated DB is a no-op (existing test pattern from `src/db/migrate.ts`). |

## Minimal implementation

- One new migration file (e.g., `migrations/0002_deployment_adapters.sql`)
  containing both DDLs verbatim from adapters spec §5:

  ```sql
  CREATE TABLE task_tags (
    task_id TEXT NOT NULL REFERENCES tasks(task_id),
    tag TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (task_id, tag)
  );
  CREATE INDEX task_tags_by_tag ON task_tags(tag);

  ALTER TABLE tasks ADD COLUMN authors_json TEXT;
  ```

- Migration ordering decision: this lands as `0002_*`, before any
  PR-review-related migrations.

- No changes to `src/db/migrate.ts` itself (the existing runner
  already handles new SQL files in lex order).

- No application code that reads or writes these columns. Slices
  14–19 add that.

## Done criteria

- The migration runs cleanly against a fresh DB and against an
  existing slice-10 DB.
- All 8 red tests pass.
- `bun test` is green (full suite).
- `bun run typecheck` is green.
- No application logic reads `task_tags` or `tasks.authors_json` yet.

## Hard rules

- Do not modify the spec docs. Spec gap →
  `docs/ralph/blockers/SPEC-GAP-slice-12-<slug>.md`, stop.
- Do not modify `docs/ralph/` outside `blockers/`.
- Do not modify `scripts/`.
- Do not implement `quay-config` block parsing, the Linear adapter,
  the Slack adapter extension, or `quay enqueue --linear-issue`.
- Do not extend the existing `enqueue` core function to populate
  `authors_json` yet — that's slice 16.
- Test names must match the table exactly.

## Working loop

1. `bun test` → first failing assertion.
2. `bun run typecheck`.
3. Smallest change toward green.
4. Re-run.

Prior gate feedback (if any) appended below.
