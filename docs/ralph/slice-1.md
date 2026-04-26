# Slice 1: Repo Registration

You are working on Quay. This prompt is one slice attempt. Read context
fresh every time.

## Required reading

1. `docs/quay-spec.md` — read-only. Sections: §3 (actors), §13
   (configuration), §10 (CLI surface for `quay repo *`).
2. `docs/quay-tdd-implementation-plan.md` — Slice 1 section is the
   authority for what this attempt must accomplish.
3. `docs/ralph/RUNBOOK.md` — operating rules.

If this prompt and either document disagree, the documents win.

## Goal

Registering and removing repositories is a pure SQL operation: no
clones, fetches, or installs run during `repo add`. Archived repos
reject new enqueues. After this slice, enqueue (Slice 2) can rely on
real `repos` rows instead of a fixture-only shortcut.

## Red tests (must exist with these names and must pass)

| Test name | Proves |
|---|---|
| `test_repo_add_persists_required_repo_config` | A repo is registered with `repo_id`, `repo_url`, `base_branch`, `package_manager`, `install_cmd`. |
| `test_repo_add_persists_optional_repo_config` | Optional fields (`test_cmd`, `ci_workflow_name`, `contribution_guide_path`) are stored when supplied but not required. |
| `test_repo_add_rejects_duplicate_id` | Adding the same `repo_id` twice errors instead of overwriting. |
| `test_repo_add_requires_minimum_fields` | Missing required fields are rejected before any row is inserted. |
| `test_repo_remove_soft_deletes_repo` | Repo removal sets `archived_at`; the row is preserved for foreign keys. |
| `test_enqueue_rejects_archived_repo` | A repo with `archived_at` set cannot accept new tasks. |

Place tests under `tests/repo/`. The slice may also touch
`tests/support/` and `migrations/` if needed; do not modify other
slices' tests.

## Minimal implementation

- Repo config service (suggested `src/core/repos/`) with `add`,
  `update`, `remove` functions.
- Validation for required fields. Use `zod` at the input boundary; do
  not validate inside SQL or callers.
- Duplicate-id rejection via SQL constraint + caller-friendly error.
- Soft-delete via `repos.archived_at`.
- Enqueue-side archived-repo guard. The full `enqueue(...)` body is
  Slice 2; here you just need the guard so
  `test_enqueue_rejects_archived_repo` can be written. A minimal stub
  that performs only the archived-repo check and returns a typed
  error is acceptable.

If schema changes are needed beyond what Slice 0 created, add a new
migration `migrations/0002_*.sql`. Do not edit existing migrations.

## Done criteria

- Repo setup is purely SQL: no clone, fetch, install, or network
  validation.
- CI workflow name remains optional; its absence is not an error.
- All six tests pass; full `bun test` is green; `bun run typecheck`
  is green.

## Hard rules

- Do not modify `docs/quay-spec.md` or the implementation plan.
- Do not implement enqueue bootstrap (clone/fetch/install/worktree),
  tick, claim, or any Slice 2+ behavior.
- Do not add real adapters (tmux/git/GitHub/Slack).
- Do not touch `src/cli/`. The CLI is Slice 10.
- Do not modify `docs/ralph/` outside `blockers/`. Do not modify
  `scripts/`.
- Test names must match the table exactly. The gate checks them by
  grep.

If you discover a spec gap, write
`docs/ralph/blockers/SPEC-GAP-slice-1-<slug>.md` and stop without
emitting the completion promise.

## Working loop

1. `bun test` → first failing assertion is the next target.
2. `bun run typecheck`.
3. Smallest change that moves a red test toward green.
4. Re-run; confirm no regression in earlier slices' tests.
5. Repeat until all listed tests pass and suite is green.

Prior gate feedback (if any) is appended below — treat it as
authoritative diagnosis.
