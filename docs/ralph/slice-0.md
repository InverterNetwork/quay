# Slice 0: Project Skeleton, Migrations, and Test Harness

You are working on Quay, a Bun + TypeScript task lifecycle service. This
prompt is the unattended driver's input for one slice attempt. Read the
referenced files at the start of every attempt — your context starts
fresh each time.

## Required reading (every attempt)

1. `docs/quay-spec.md` — product behavior contract. **Read-only.**
   Sections most relevant to Slice 0: §8 (Artifact store), §9
   (Persistence layer), §13 (Configuration). Skim the rest for context.
2. `docs/quay-tdd-implementation-plan.md` — build order. **Read-only.**
   The authoritative description of this slice is the **Slice 0**
   section. Re-read its "Red tests", "Minimal implementation", and
   "Done criteria" subsections.
3. `docs/ralph/RUNBOOK.md` — operating rules.

If this prompt and either of those documents disagree, the documents win.

## Goal of this slice

Make Quay's persistence contract executable. After this slice:

- Migrations create the schema described in §9 of the spec.
- SQLite enforces the constraints listed below at the database level,
  not only in TypeScript.
- A reusable test harness gives every test an isolated data dir, fresh
  DB, artifact root, deterministic clock, and deterministic ID generator.
- A small artifact-store helper writes a file under the artifact root
  and inserts a matching `artifacts` row.

No task lifecycle behavior. No CLI. No external adapters. No fakes for
tmux/git/GitHub/Slack yet.

## Red tests (must exist with these names and must pass)

Place tests under `tests/schema/` unless noted. Test names match the plan.

| Test file (suggested) | Test name | Proves |
|---|---|---|
| `tests/schema/migrations.test.ts` | `test_schema_creates_required_tables` | Migrations create `repos`, `preambles`, `retry_templates`, `tasks`, `attempts`, `artifacts`, and `events` with the columns required by spec §9. |
| `tests/schema/attempts_invariants.test.ts` | `test_schema_enforces_one_pending_attempt_per_task` | A second `attempts` row for the same `task_id` with `spawned_at IS NULL` is rejected by SQLite. |
| `tests/schema/artifacts_invariants.test.ts` | `test_schema_enforces_recovery_artifact_idempotency` | Duplicate recovery artifacts with the same `(task_id, attempt_id, kind, content_hash)` are rejected when `content_hash` and `attempt_id` are present. |
| `tests/schema/foreign_keys.test.ts` | `test_schema_rejects_orphan_attempts_artifacts_and_events` | Foreign keys are enabled. Inserts referencing missing `tasks`, `attempts`, or `artifacts` are rejected. |
| `tests/support/harness.test.ts` | `test_test_harness_provides_temp_data_dir_db_and_clock` | Each test gets isolated data dir, initialized DB, artifact dir, deterministic `Clock`, deterministic `IdGenerator`. Two harness instances do not collide. |
| `tests/schema/artifact_store.test.ts` | `test_artifact_store_writes_file_and_db_row` | The artifact-store helper writes content to a file under the artifact root and inserts an `artifacts` row recording `task_id`, `attempt_id`, `kind`, `file_path`, `content_hash`, and `captured_at` (column names per spec §9). |

The existing `tests/schema/harness_smoke.test.ts` (a placeholder pinning
the entry point) **must be deleted** once `migrations/0001_init.sql`
exists. Do not keep it as dead weight.

## Minimal implementation

Only what's needed to pass the red tests.

- `migrations/0001_init.sql` — the full Slice-0 schema. Use SQLite
  syntax (`bun:sqlite`).
- `src/db/migrate.ts` — tiny migration runner: opens DB, enables
  foreign keys (`PRAGMA foreign_keys = ON`), records applied
  migrations in a `schema_migrations` table, applies any unapplied
  `migrations/*.sql` files in lexicographic order, idempotent on
  re-run.
- `src/db/connection.ts` — open a `bun:sqlite` Database, set pragmas,
  return a typed handle.
- `src/ports/clock.ts` — `Clock` interface + a real implementation.
- `src/ports/id_generator.ts` — `IdGenerator` interface + real
  implementation.
- `src/artifacts/store.ts` — minimal artifact-store helper:
  `writeArtifact({ taskId, attemptId, kind, content, ... }) -> { artifactId, filePath, contentHash }`.
  Computes `content_hash`, writes file under
  `<data_dir>/artifacts/<task_id>/<attempt_id>/<kind>/...`, inserts a
  row using spec §9 column names (`task_id`, `attempt_id`, `kind`,
  `file_path`, `content_hash`, `captured_at`).
- `tests/support/harness.ts` — `createHarness()` returning
  `{ dataDir, db, artifactRoot, clock, ids, cleanup }`. Each call uses
  a unique temp directory.
- `tests/support/fakes/clock.ts` — deterministic `FakeClock`.
- `tests/support/fakes/id_generator.ts` — deterministic
  `FakeIdGenerator` (e.g. monotonic `id-1`, `id-2`, ...).

Schema details — **the spec is canonical; copy column names from
spec §9 verbatim. Do not invent or rename.** Quick cross-reference:

- `tasks` (PK `task_id TEXT`): includes `attempts_consumed`,
  `retry_budget`, `budget_exhausted`, `cancel_requested_at`,
  `cancel_close_pr`, `cancel_keep_worktree`, `claim_id`,
  `claimed_at`, `claim_expirations_consecutive`,
  `last_review_id_acted_on`, `last_conflict_observation`,
  `non_budget_respawns_consumed`, `next_escalation_seq`,
  `spawn_failures_consecutive`, `created_at`, `updated_at`. Note
  `attempts_consumed` lives on `tasks`, not `attempts`.
- `attempts` (PK `attempt_id INTEGER AUTOINCREMENT`): includes
  `task_id`, `attempt_number`, `preamble_id`, `template_id`,
  `reason`, `consumed_budget`, `tmux_session`, `spawned_at`,
  `remote_sha_at_spawn`, `remote_sha_at_exit`, `pr_existed_at_spawn`,
  `ended_at`, `exit_kind`, `kill_intent`.
- `artifacts` (PK `artifact_id INTEGER AUTOINCREMENT`): includes
  `task_id`, `attempt_id` (nullable), `kind`, `file_path`,
  `content_hash` (nullable), `escalation_seq`, `escalation_nonce`,
  `slack_pre_post_fence_ts`, `slack_post_ts`,
  `slack_recovered_post_ts`, `captured_at`. The path column is
  `file_path` (not `path`); the timestamp is `captured_at` (not
  `created_at`).
- `events` (PK `event_id INTEGER AUTOINCREMENT`): includes `task_id`,
  `attempt_id` (nullable), `event_type`, `from_state`, `to_state`,
  `payload_artifact_id`, `occurred_at`. The timestamp is
  `occurred_at` (not `created_at`).

Constraints required by spec §9:

- `UNIQUE(task_id, attempt_number)` on `attempts`.
- Partial unique index on `attempts(task_id) WHERE spawned_at IS NULL`
  (single pending attempt per task).
- Partial unique index on
  `artifacts(task_id, attempt_id, kind, content_hash) WHERE content_hash IS NOT NULL AND attempt_id IS NOT NULL`
  (recovery-artifact idempotency).
- `CHECK(consumed_budget IN (0, 1))` on `attempts`.
- `CHECK(budget_exhausted IN (0, 1))` on `tasks`.
- Foreign keys on every cross-table reference; `PRAGMA foreign_keys = ON`.

If spec §9 lists a column not exercised by a Slice-0 red test, you
may add it now (cheaper than re-migrating later). Do not invent
columns the spec does not describe.

## Done criteria

- A test can create an isolated Quay DB and data dir.
- All schema constraints required by the spec are enforced by SQLite,
  not only by application code.
- No task lifecycle behavior is implemented yet.
- `bun test` passes (full suite).
- `bun run typecheck` passes.
- All six red tests above exist with the exact names listed.
- The placeholder `harness_smoke.test.ts` is deleted.

## Hard rules

- Do not edit `docs/quay-spec.md` or
  `docs/quay-tdd-implementation-plan.md`. If you find a spec gap,
  write `docs/ralph/blockers/SPEC-GAP-slice-0-<slug>.md` describing
  the gap and proposed resolution, leave the rest of your work intact,
  and stop without emitting the completion promise. The driver will
  surface the blocker.
- Do not implement enqueue, tick, claim, cancel, Slack, or any other
  Slice 1+ behavior.
- Do not add real tmux/git/GitHub/Slack adapters.
- Do not modify `docs/ralph/` outside `docs/ralph/blockers/`.
- Do not modify `scripts/`.
- Do not skip git hooks or force-push. The driver commits on your
  behalf between attempts; you may freely commit too.
- Test names must match the table above exactly. They are the
  contract the gate checks.

## Working loop (within one attempt)

1. Run `bun test` and read the output. The first failing assertion is
   the next thing to fix.
2. Run `bun run typecheck`. Fix type errors before adding behavior.
3. Make the smallest change that moves one red test toward green.
4. Re-run `bun test`. Confirm no previously green test regressed.
5. Repeat until all listed tests pass and the suite is green.

If a prior attempt's gate output is appended below this prompt, treat
it as authoritative diagnosis of what blocked the last attempt and
focus the current attempt on those specific issues.
