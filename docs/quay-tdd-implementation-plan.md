# Quay TDD Implementation Plan

**Source of truth:** `quay-spec.md`

This document translates the frozen Quay specification into a test-first
implementation sequence. It does not redefine product behavior. If this
document conflicts with `quay-spec.md`, the spec wins.

## Relationship to the spec

`quay-spec.md` is the product behavior contract. Section 15 of that spec is the
canonical acceptance test inventory: it names the externally important behaviors
Quay must prove before v1 is credible.

This document is the execution plan. It maps those acceptance cases into a build
order, defines the test harness needed to exercise them, and adds lower-level
support tests where they are needed to implement the spec safely.

Use this distinction:

- **Spec tests:** behavior-level tests traceable to `quay-spec.md` Section 15.
- **Support tests:** lower-level tests for schema constraints, transitions,
  fakes, failpoints, normalization, hashing, and helper modules.
- **Gap findings:** if implementation exposes a missing product decision that
  affects task state loss, duplicate irreversible external side effects, unsafe
  cleanup, retry accounting, worker supervision, or crash recovery, update
  `quay-spec.md` first.

## Goals

- Turn the frozen spec into small implementation slices.
- Start every slice with failing tests.
- Keep persistence behavior real by testing against SQLite migrations.
- Fake external systems until the core state machine is proven.
- Preserve traceability from implementation tests back to `quay-spec.md`,
  especially Section 15 cases.
- Keep each slice shippable: red tests, minimal implementation, refactor.

## Non-goals

- Re-litigating Quay architecture.
- Adding new product behavior.
- Expanding the spec with nice-to-have cases.
- Implementing real tmux, GitHub, Slack, or git adapters before the core state
  machine is stable.
- Using this document as a substitute for failing tests.

## TDD Rules

1. Every implementation slice starts with one or more failing tests.
2. Tests use real SQLite migrations and constraints.
3. External systems start as deterministic fakes: tmux, git, GitHub, Slack,
   clock, ID generation, and command execution.
4. Dangerous crash windows are tested through named failpoints.
5. Test names reference `quay-spec.md` Section 15 case numbers when applicable.
   If Section 15 contains duplicate numbers, include a short domain slug in the
   test name, such as `slack` or `nonbudget`.
6. A slice is complete only when tests pass, the implementation is minimal, and
   no required behavior is only manually verified.
7. The CLI stays thin. State-machine behavior belongs in service modules that
   tests can call directly.

## Stack Decisions

Quay v1 is a Bun-native TypeScript CLI.

Chosen defaults:

- **Runtime and package manager:** Bun.
- **Language/module format:** TypeScript with ESM.
- **Test runner:** `bun test`.
- **SQLite:** `bun:sqlite`.
- **CLI parser:** `commander`, unless Slice 0 implementation shows a tiny
  hand-rolled parser is materially simpler for the first commands.
- **Input validation:** `zod` only at command/input boundaries.
- **Migrations:** hand-written SQL files plus a tiny migration runner.
- **Process execution:** Bun subprocess APIs for real adapters.
- **Formatting/linting:** keep lightweight; add Prettier/ESLint only when code
  volume makes it useful.

Implications:

- Quay requires Bun on the host in v1.
- Hermes, OpenClaw, or any other orchestrator integrates through the CLI/JSON
  boundary, so it does not need to share Quay's runtime.
- Keep Bun-specific APIs behind small modules where practical, especially DB
  and process execution, so a future Node-compatible distribution remains
  possible if needed.

## Repository Layout

Use `quay/` as the implementation root.

```text
quay/
  package.json
  bunfig.toml
  tsconfig.json
  migrations/
  src/
    cli/
    core/
    db/
    artifacts/
    ports/
    adapters/
  tests/
    support/
      fakes/
      failpoints/
    schema/
    enqueue/
    tick/
    claim/
    cancel/
    slack/
    pr/
    cli/
```

Layout rules:

- `migrations/` is top-level because SQL files are runtime inputs, not
  TypeScript modules.
- Tests are organized by domain, not by implementation slice. Slice and spec
  traceability live in test names, e.g. `test_055_...`, `test_029c_...`.
- Test fakes live under `tests/support/fakes/`, not `src/`, because they are
  test infrastructure and should not ship in the production CLI.
- `src/ports/` contains the interfaces the core service depends on.
- `src/adapters/` contains real implementations of those ports, added when the
  relevant slice requires them.
- `src/core/` owns the state-machine service API. CLI code should call core
  services rather than owning behavior directly.

## Test Taxonomy

### 1. Acceptance / State-Machine Tests

These are service-level integration tests that drive Quay through realistic
state transitions using real SQLite and fake ports. They should map directly to
Section 15 cases.

Example names:

- `test_001_enqueue_to_merged_happy_path`
- `test_029c_cancel_close_pr_crash_after_irreversible_side_effects`
- `test_048_slack_post_sql_failure_does_not_duplicate_post`
- `test_048_nonbudget_review_sticky_does_not_respawn`

### 2. Persistence / Constraint Tests

These test the database contract directly: migrations, indexes, constraints,
foreign keys, transaction predicates, and row shapes.

These are support tests, not new product behavior.

### 3. Port Fake Tests

These test the deterministic fakes used by acceptance tests. They should be
small and boring. A flaky fake creates false confidence or false failures in the
state-machine tests.

### 4. Adapter Contract Tests

These are added later, after the core behavior is stable. They verify that the
real tmux, git, GitHub, and Slack adapters obey the same port contracts as the
fakes.

### 5. CLI Smoke Tests

These verify command parsing, JSON stdout/stderr shape, exit codes, and service
wiring. They should not duplicate every state-machine acceptance test.

## Target Architecture Under Test

The implementation should expose a core service API before the CLI is wired:

- `enqueue(...)`
- `tick_once(...)`
- `claim_task(...)`
- `release_claim(...)`
- `submit_brief(...)`
- `escalate_human(...)`
- `cancel_task(...)`
- read APIs for `task get`, `task list`, `task events`, and `artifact get`

The core service depends on ports:

- `TmuxPort`
- `GitPort`
- `GitHubPort`
- `SlackPort`
- `Clock`
- `IdGenerator`
- `ArtifactStore`
- `CommandRunner` for operator-controlled shell commands

The tests should instantiate the real database and artifact store under a temp
`data_dir`, then inject fake external ports.

## Harness Strategy

Use real SQLite from Slice 0. Do not mock the database.

Reasons:

- The schema constraints are part of the product behavior.
- Transaction predicates are how Quay prevents stale claims, duplicate pending
  attempts, cancelled-task mutations, and retry-accounting drift.
- Crash recovery depends on partially completed durable state.

Use fakes for external systems at first.

Reasons:

- Crash windows must be deterministic.
- GitHub, Slack, tmux, and git are too slow and stateful for early red/green
  cycles.
- The same service tests should run locally without credentials or network.

## Failpoint Strategy

Failpoints are test-only injection points placed immediately after durable or
irreversible boundaries. They let tests simulate process death without relying
on timing.

Failpoints must:

- be disabled by default,
- be named after the boundary they interrupt,
- raise a test-only crash exception,
- leave already-committed SQL and already-performed fake side effects intact,
- never appear in product-facing CLI options.

Initial failpoints:

| Failpoint | Boundary |
|---|---|
| `after_blocker_artifact_write` | Artifact file and row written, event/state not yet committed. |
| `after_blocker_state_commit` | Blocker event/state committed, worktree signal file not yet deleted. |
| `after_spawn_promotion_commit` | `queued -> running` SQL committed, substrate spawn not started. |
| `after_tmux_session_created` | tmux session created, `attempts.tmux_session` not yet recorded. |
| `after_kill_intent_commit` | stale/wall-clock/cancel kill intent committed, tmux kill not yet issued. |
| `after_cancel_intent_commit` | `tasks.cancel_requested_at` committed, cancel finalizer not yet complete. |
| `after_github_pr_close` | `gh pr close` performed, terminal SQL transition not yet committed. |
| `after_slack_post` | Slack post accepted, `slack_post_ts` not yet persisted. |
| `after_slack_recovery_ts_commit` | recovered bot-post ts committed, reply not yet ingested. |

Add new failpoints only when a spec-required crash window cannot be tested with
the existing set.

## Slice Format

Each slice should be planned and implemented in this format:

### Slice N: Name

**Spec coverage**

- `quay-spec.md` sections:
- Section 15 cases:

**Red tests**

- Test names, the behavior each test proves, and expected initial failures.

**Minimal implementation**

- Files/modules likely touched.
- Smallest behavior needed to pass.

**Done criteria**

- Tests pass.
- Behavior is reachable through the core service API.
- No real external adapter is required unless the slice explicitly says so.

## Implementation Slices

### Slice 0: Project Skeleton, Migrations, and Test Harness

**Spec coverage**

- Persistence layer.
- Schema constraints and transaction predicates.
- Artifact store layout.
- Section 15 support for all later tests.

**Red tests**

| Test | Proves |
|---|---|
| `test_schema_creates_required_tables` | Migrations create the core tables required by `quay-spec.md`: `repos`, `preambles`, `retry_templates`, `tasks`, `attempts`, `artifacts`, and `events`. |
| `test_schema_enforces_one_pending_attempt_per_task` | SQLite rejects a second `attempts` row for the same task where `spawned_at IS NULL`, enforcing the single pending-attempt invariant. |
| `test_schema_enforces_recovery_artifact_idempotency` | SQLite rejects duplicate recovery artifacts with the same `(task_id, attempt_id, kind, content_hash)` when `content_hash` and `attempt_id` are present. |
| `test_schema_rejects_orphan_attempts_artifacts_and_events` | Foreign keys are enabled and reject rows pointing at missing tasks, attempts, or artifacts. |
| `test_test_harness_provides_temp_data_dir_db_and_clock` | Each test gets an isolated data dir, initialized DB, artifact directory, deterministic clock, and deterministic ID generator. |
| `test_artifact_store_writes_file_and_db_row` | The generic artifact helper writes content outside the worktree and inserts a matching DB row with task, attempt, kind, path, and timestamp metadata. |

**Minimal implementation**

- Migration runner.
- SQLite connection setup with foreign keys enabled.
- Temp test data directory helper.
- Deterministic `Clock` and `IdGenerator` fakes.
- Minimal artifact-store helper that writes files under temp `artifacts/`.

**Done criteria**

- A test can create an isolated Quay DB and data dir.
- All schema constraints required by the spec are enforced by SQLite, not only
  by application code.
- No task lifecycle behavior is implemented yet.

### Slice 1: Repo Registration

**Spec coverage**

- Per-repo config.
- `quay repo add`, `quay repo update`, and `quay repo remove` basics.
- Archived repos reject new enqueues.
- Section 15 support for enqueue and CI polling cases.

**Red tests**

| Test | Proves |
|---|---|
| `test_repo_add_persists_required_repo_config` | A repo can be registered with the minimum required fields: `repo_id`, `repo_url`, `base_branch`, `package_manager`, and `install_cmd`. |
| `test_repo_add_persists_optional_repo_config` | Optional fields such as `test_cmd`, `ci_workflow_name`, and `contribution_guide_path` are stored when supplied but are not required. |
| `test_repo_add_rejects_duplicate_id` | `repo_id` is stable identity; adding the same id twice errors instead of overwriting existing config. |
| `test_repo_add_requires_minimum_fields` | Missing required fields are rejected before a row is inserted. |
| `test_repo_remove_soft_deletes_repo` | Repo removal sets `archived_at` instead of hard-deleting the row, preserving task foreign keys and history. |
| `test_enqueue_rejects_archived_repo` | A repo marked archived cannot accept new tasks. |

**Minimal implementation**

- Repo config service functions for add/update/remove.
- Validation for required fields.
- Duplicate-id handling.
- Soft-delete via `repos.archived_at`.
- Enqueue-side archived-repo guard, without full enqueue behavior yet.

**Done criteria**

- Repo setup is a lightweight SQL operation: no clone, fetch, install, or
  network validation happens during `repo add`.
- Enqueue can rely on a real repo row instead of a fixture-only shortcut.
- CI workflow name remains optional; required-check mode is the default when it
  is unset.

### Slice 2: Enqueue Schedules Attempt 1

**Spec coverage**

- Enqueue does not spawn.
- Bootstrap is synchronous at enqueue.
- Every attempt has one `brief` and one `final_prompt` artifact.
- Section 15 cases: 33, 36, 39, 41, 42, 55, 56, 57, 65.

**Red tests**

| Test | Proves |
|---|---|
| `test_055_enqueue_fresh_repo_bootstraps_and_queues_task` | First enqueue for a repo clones the bare repo, fetches the base branch, creates the worktree, runs `install_cmd`, creates a `queued` task, and schedules attempt #1 without spawning tmux. |
| `test_056_enqueue_existing_repo_reuses_bare_clone_and_fetches` | Existing bare clones are reused, but enqueue still fetches the base branch, creates a fresh worktree, runs install, and queues a new task. |
| `test_057_enqueue_bootstrap_failure_leaves_no_task_row` | Clone, worktree, install, artifact, or DB failure aborts enqueue and leaves no committed task or pending attempt; cleanup runs for partial worktree/branch/artifacts. |
| `test_065_initial_attempt_has_brief_and_final_prompt` | Attempt #1 has exactly one `brief` and one `final_prompt`; `ticket_snapshot` is task-level; `final_prompt` content is preamble plus brief. |
| `test_039_branch_slug_examples` | Branch names follow the git-safe slug rules for normal, path-like, missing, and empty-normalized `external_ref` values while preserving the verbatim external ref in SQL. |
| `test_040_branch_collision_adds_task_suffix` | If the preferred branch is already taken locally, remotely, or by an open PR, enqueue appends `-<task_id_short>` and re-checks before proceeding. |
| `test_041_enqueue_rejects_unknown_or_archived_repo` | Unknown or archived repos reject enqueue before any git, install, artifact, or task-state side effects. |

**Minimal implementation**

- `enqueue(...)` service method.
- Fake `GitPort` for clone, fetch, branch checks, worktree add/remove, branch
  delete.
- Fake `CommandRunner` for `install_cmd`.
- Branch and tmux identifier normalization.
- Task row, attempt #1 row, ticket snapshot, brief, final prompt artifacts.

**Done criteria**

- Enqueue returns a queued task.
- No tmux session is created.
- Rollback removes worktree/branch/artifacts on bootstrap or DB failure.
- The first attempt is pending with `spawned_at = NULL`.

### Slice 3: Tick Promotion, Capacity, and Spawn Accounting

**Spec coverage**

- Single spawn point: `queued -> running`.
- Budget consumed at promotion.
- Capacity cap applies to initial spawns and respawns.
- Section 15 cases: 1 partial, 35, 59, 60.

**Red tests**

- `test_001_tick_promotes_queued_to_running`
- `test_035_capacity_cap_prevents_extra_spawn`
- `test_promotion_consumes_budget_once`
- `test_promotion_rowcount_zero_on_cancel_intent_skips_spawn`
- `test_spawn_failure_window_leaves_running_with_null_session_for_recovery`

**Minimal implementation**

- `tick_once(...)` reads active tasks under the supervisor lock abstraction.
- Pending-attempt lookup.
- Fake `TmuxPort.spawn`.
- Promotion transaction records `spawned_at`, `remote_sha_at_spawn`,
  `pr_existed_at_spawn`, `attempts_consumed`, and `spawned` event.
- Session recording after substrate spawn.

**Done criteria**

- All spawns go through tick promotion.
- A queued task never bypasses capacity.
- Budget is not consumed when capacity prevents promotion.

### Slice 4: Dead-Worker Classifier

**Spec coverage**

- Worker-alive check precedes PR check.
- Blocker, malformed signal, PR opened, no-progress, crash.
- Idempotent PR contract.
- Deterministic retry triggers schedule pending budget-consuming attempts but do
  not increment `attempts_consumed` until later promotion.
- Section 15 cases: 2, 3, 30, 43, 44, 64, 73, 74, 74b, 74c, 74d.

**Red tests**

| Test | Proves |
|---|---|
| `test_002_worker_blocker_transitions_to_awaiting_next_brief` | A dead worker with a valid `.quay-blocked.md` produces a blocker artifact, deletes the worktree signal after durable ingest, and moves the task to `awaiting-next-brief` without scheduling a retry. |
| `test_003_dead_worker_without_pr_or_signal_schedules_crash_retry` | A dead worker with no blocker, no PR, and no remote progress marks the attempt crashed, inserts a pending `crash` attempt with `consumed_budget = 1`, moves to `queued`, and does not increment `attempts_consumed` yet. |
| `test_043_blocker_crash_after_artifact_write_converges` | If tick crashes after blocker artifact write but before state/event update, the next tick reuses the existing artifact by `content_hash`, writes the missing state/event, and deletes the signal file. |
| `test_073_retry_attempt_does_not_create_duplicate_pr` | A retry attempt that advances the remote branch for an existing PR transitions to `pr-open` without assuming or creating a duplicate PR. |
| `test_074_no_remote_progress_is_no_progress` | A dead retry attempt with an existing PR but unchanged remote SHA is classified as `no_progress` and schedules a pending budget-consuming `crash` retry instead of transitioning to `pr-open`. |
| `test_074c_pr_created_during_attempt_counts_as_progress` | If no PR existed at spawn but one exists at exit, PR creation counts as progress even when the remote SHA did not change during that attempt. |
| `test_malformed_blocker_schedules_malformed_signal_retry` | A malformed `.quay-blocked.md` is persisted as `malformed_signal`, deleted after durable ingest, and schedules a pending `malformed_signal` retry with `consumed_budget = 1` but no immediate budget increment. |
| `test_spawn_window_null_session_uses_same_classifier` | A `running` attempt with `spawned_at` set and `tmux_session = NULL` kills the canonical orphan session if present, then uses the same evidence classifier instead of unconditionally marking `spawn_failed`. |

**Minimal implementation**

- `TmuxPort.is_alive`.
- Session-log collection through artifact store.
- Signal-file validation and crash-safe ingestion.
- Fake remote SHA and PR-existence reads.
- Dead-worker classifier shared by normal dead sessions and spawn-window
  recovery.

**Done criteria**

- The classifier writes exactly one terminal transition for the observed worker
  outcome.
- Blocker artifacts are deduped across crash recovery.
- Local-only commits do not count as PR progress.

### Slice 5: Deterministic Retries and Budget Exhaustion

**Spec coverage**

- Deterministic failure retry composition.
- Budget consumed at spawn, not trigger detection.
- Exhaustion parks in `awaiting-next-brief` with `budget_exhausted`.
- Spawn-failure no-evidence rollback and `worktree_error` parking.
- Section 15 cases: 5, 13, 21, 22, 23, 45, 46b, 60, 62, 63.

**Red tests**

| Test | Proves |
|---|---|
| `test_005_ci_fail_schedules_budget_consuming_retry` | A failed CI check in `pr-open` snapshots a `ci_failure_excerpt`, composes a Quay-owned retry brief from the `ci_fail` template plus latest brief, inserts a pending `ci_fail` attempt with `consumed_budget = 1`, and leaves budget spending to later promotion. |
| `test_013_final_attempt_blocker_sets_budget_exhausted` | A valid blocker on the final allowed attempt is ingested, sets `budget_exhausted = true`, writes `last_failure`, transitions to `awaiting-next-brief`, and schedules no `blocker_resolved` retry. |
| `test_021_retry_budget_exhaustion_creates_last_failure` | Any deterministic retry trigger at budget cap does not insert a pending attempt; it writes the would-have-been retry context as `last_failure`, sets `budget_exhausted`, and hands the task to the orchestrator. |
| `test_022_wall_clock_kill_schedules_retry` | A live worker past `max_attempt_duration_seconds` gets `kill_intent = wall_clock` before tmux kill; the finalizer marks `killed_wall_clock` and schedules a pending budget-consuming `wall_clock` retry. |
| `test_023_retry_brief_uses_most_recent_brief` | Quay-composed deterministic retry briefs wrap the latest spawned brief, including orchestrator-submitted follow-up briefs, rather than reverting to the initial enqueue brief. |
| `test_stale_kill_schedules_retry_once` | A stale live worker gets `kill_intent = stale` before tmux kill, and retry/finalizer re-entry schedules exactly one pending `stale` retry. |
| `test_045_spawn_failure_no_evidence_rolls_back_budget_and_requeues` | A spawn-window attempt with no worker evidence is classified as `spawn_failed`, rolls back the promotion budget increment, increments `spawn_failures_consecutive`, and schedules a clean retry of the same logical attempt. |
| `test_046b_spawn_window_push_without_pr_takes_spawn_failed_default` | A spawn-window worker push without a PR is not trackable as `pr-open`; with no signal file and no PR, the no-evidence default applies: `spawn_failed`, budget rollback, fresh queued attempt. |
| `test_062_max_spawn_failures_parks_worktree_error` | Consecutive no-evidence spawn failures increment `spawn_failures_consecutive`; once the cap is reached, the task parks in `worktree_error`. |
| `test_063_evidence_found_recovery_resets_spawn_failures` | Evidence-found spawn-window recovery outcomes reset `spawn_failures_consecutive` to 0 and preserve budget. |

**Minimal implementation**

- Retry-template lookup.
- Attempt scheduling helper.
- Budget-exhausted helper.
- Stale and wall-clock kill-intent finalizers.
- Spawn-failure rollback helper for no-evidence spawn-window recovery.

**Done criteria**

- Trigger detection never increments budget directly.
- Budget-consuming attempts increment only on later promotion.
- Exhausted tasks are handed back to the orchestrator, not terminal-failed.
- No-evidence substrate spawn failures never consume retry budget and park in
  `worktree_error` after the configured consecutive-failure cap.

### Slice 6: Claim Fencing and Orchestrator Loop Parking

**Spec coverage**

- Atomic claims.
- Claim ownership fence.
- Claim timeout and loop parking.
- Submit-brief schedules a pending attempt but never spawns directly.
- Escalate-human is a claim-scoped SQL/artifact transition; Slack posting is
  deferred to the waiting-human tick handler.
- Section 15 cases: 14, 15, 16, 17, 18, 19, 20, 20a, 20b, 20c, 20d, 34, 58.

**Red tests**

| Test | Proves |
|---|---|
| `test_015_concurrent_claims_only_one_wins` | Concurrent claims on the same `awaiting-next-brief` task arbitrate atomically: one caller gets a fresh `claim_id`, others fail, and the task is claimed exactly once. |
| `test_016_claim_timeout_auto_releases` | Tick auto-releases stale claims by clearing `claim_id`, moving the task back to `awaiting-next-brief`, logging `claim_expired`, and incrementing the expiration counter. |
| `test_020_claim_expiration_cap_parks_orchestrator_loop` | Repeated claim expirations park the task in `orchestrator_loop` after `max_claim_expirations`, preventing uncontrolled orchestrator crash loops. |
| `test_020a_stale_claimant_cannot_submit_brief` | A timed-out claimant cannot submit a brief after another claimant receives a fresh `claim_id`; Quay returns `claim_lost` and preserves the new claim. |
| `test_020b_cancel_in_flight_fences_claim_scoped_writes` | A claim-scoped write racing with cancellation returns `cancelled` and writes no new attempt, brief, or escalation artifact. |
| `test_020d_release_claim_mismatch_is_claim_lost` | `release-claim` with an old `claim_id` returns `claim_lost` when a newer claim exists, instead of clearing someone else's claim. |
| `test_058_submit_brief_schedules_queued_not_running` | `submit-brief` creates a pending attempt and artifacts, clears the claim, resets claim expirations, transitions to `queued`, and does not spawn or increment budget. |
| `test_escalate_human_claim_transition_is_sql_only` | `escalate-human` creates a `slack_escalation_post` artifact with sequence and nonce, moves to `waiting_human`, clears the claim, and performs no Slack API call. |

**Minimal implementation**

- `claim_task`, `release_claim`, `submit_brief`, and `escalate_human` SQL
  predicates.
- Claim timeout handling in tick.
- Error taxonomy: `claim_lost`, `cancelled`, `wrong_state`,
  `unknown_task`.

**Done criteria**

- A stale claimant cannot mutate a re-claimed task.
- Claim expirations are counted and reset exactly as specified.
- Claim-scoped writes distinguish cancellation from claim loss.

### Slice 7: Cancel Finalizer

**Spec coverage**

- Durable task-level cancel intent.
- Single canonical cancel finalizer.
- Cleanup matrix.
- Crash recovery after irreversible side effects.
- Section 15 cases: 24, 25, 26, 27, 28, 29, 29a, 29b, 29c, 29d, 29e, 29f,
  29g, 31a, 31c, 31d, 31e, 79, 80, 81, 82.

**Red tests**

| Test | Proves |
|---|---|
| `test_029a_cancel_crash_after_intent_recovers_from_running` | If cancel crashes after writing `cancel_requested_at`, setting `kill_intent = cancel`, and killing tmux, the next tick resumes from durable intent and drives the running task to `cancelled`. |
| `test_029c_cancel_close_pr_crash_after_irreversible_side_effects` | If `cancel --close-pr` closes the PR and deletes the remote branch but crashes before SQL terminal transition, recovery resumes cancellation and never misclassifies the task as `closed_unmerged`. |
| `test_029e_cancel_waiting_human_preserves_slack_artifact` | Cancelling a `waiting_human` task preserves the pending Slack escalation artifact, does not unpost Slack, and transitions the task to `cancelled`. |
| `test_031c_cancel_races_mid_spawn_converges` | If cancel races a tick that has promoted a queued task and is spawning tmux, the supervisor lock serializes side effects and the finalizer kills any newly spawned worker before marking `cancelled`. |
| `test_081_cancel_with_open_pr_retains_remote_branch` | Default cancel cleanup removes local branch/worktree but retains the remote branch when a PR is currently open. |
| `test_026_cancel_terminal_state_semantics` | Cancel on `cancelled` is an idempotent no-op success, while cancel on `merged` or `closed_unmerged` returns `wrong_state` without SQL writes or side effects. |
| `test_029f_cancel_parked_state_runs_cleanup` | Cancelling `worktree_error`, `orchestrator_loop`, or `non_budget_loop` writes durable intent, applies normal cancelled cleanup, and transitions to `cancelled`. |

**Minimal implementation**

- Supervisor lock abstraction.
- `cancel_task(...)` intent write.
- Shared cancel finalizer used by CLI path and tick recovery.
- Fake GitHub close PR and fake git branch cleanup.

**Done criteria**

- Cancellation from every non-terminal state converges to `cancelled`.
- Crash after external cleanup cannot be misclassified as `closed_unmerged`.
- Re-running cancel on `cancelled` is a no-op success.

### Slice 8: Slack Escalation and Reply Recovery

**Spec coverage**

- Tick-only Slack writer.
- Per-escalation nonce.
- No duplicate post on crash.
- Reply cursor uses recovered bot-post timestamp.
- Section 15 cases: 11, 11a, 11b, 12, 31b, 41, 42, 47, 48, 48a, 48b, 48c,
  64.

**Red tests**

| Test | Proves |
|---|---|
| `test_011_escalate_human_cli_does_not_call_slack` | The CLI-side escalation path creates the artifact/state transition only; fake Slack records zero API calls until tick handles `waiting_human`. |
| `test_011b_tick_recovers_posted_slack_message_by_nonce` | If tick posts to Slack and crashes before persisting the timestamp, the next tick finds the bot message by nonce, fills `slack_recovered_post_ts`, and does not repost. |
| `test_048_slack_post_sql_failure_does_not_duplicate_post` | A Slack post accepted before SQL timestamp persistence is recovered by nonce; a later human reply is ingested and exactly one Slack post exists. |
| `test_048a_second_escalation_same_body_is_distinct` | A legitimate second escalation with the same question body gets a new sequence, nonce, content hash, artifact, and Slack post rather than deduping against the first. |
| `test_048c_inter_window_chatter_excluded_after_recovery` | Once the actual bot-post timestamp is recovered, thread chatter between pre-post fence and bot post is excluded from reply ingestion. |
| `test_047_slack_post_failure_retries_without_looping` | If the Slack API fails before any post exists, the task remains `waiting_human`; the next tick retries, and no tight loop happens inside one tick. |
| `test_012_slack_reply_transitions_to_awaiting_next_brief` | A non-bot reply after the bot-post lower bound is stored as `slack_reply` and transitions the task to `awaiting-next-brief` without pushing to the orchestrator. |

**Minimal implementation**

- `SlackPort` fake with thread messages, bot messages, and replies.
- Escalation artifact creation with sequence, nonce, and content hash.
- Tick `waiting_human` handler: fence read, nonce recovery, post-if-needed,
  reply ingestion.

**Done criteria**

- Exactly one visible Slack post per escalation.
- Crash recovery uses read-before-write recovery before reposting.
- Reply ingestion transitions to `awaiting-next-brief` once.

### Slice 9: PR, CI, Review, and Conflict Polling

**Spec coverage**

- `pr-open` and `done` polling.
- CI source-of-truth rules.
- Review/conflict non-budget respawns and dedupe.
- Non-budget safety cap.
- Section 15 cases: 6, 7, 8, 9, 10, non-budget retry dedup cases 48-52,
  `pr-open` polling cases 53-54, 66, 67, 68, 69, 76, 77, 78, 83.

**Red tests**

| Test | Proves |
|---|---|
| `test_066_named_workflow_does_not_hide_other_failures` | `ci_workflow_name` is retained for compatibility but does not hide failures from other reported workflows. |
| `test_068_no_reported_checks_means_pass` | When GitHub reports no check rows at all, Quay preserves the no-CI pass behavior and moves `pr-open` to `done`. |
| `test_076_stale_check_sha_logs_tick_error_without_transition` | If PR head SHA and check-run SHA disagree, Quay logs `tick_error`, leaves state unchanged, and consumes no retry budget. |
| `test_048_nonbudget_review_dedupe_does_not_respawn_same_review` | Sticky `CHANGES_REQUESTED` with the same already-acted review id does not schedule another review respawn. |
| `test_052_non_budget_cap_parks_on_n_plus_one` | Review/conflict respawns increment the non-budget counter; the first N are allowed and the N+1 trigger parks in `non_budget_loop` without scheduling another attempt. |
| `test_083_advice_answered_does_not_increment_non_budget_counter` | Human-reply-driven `advice_answered` respawns do not increment `non_budget_respawns_consumed`; only review/conflict paths do. |
| `test_053_pr_open_merged_transitions_terminal` | A `pr-open` task whose PR was merged transitions to `merged` and runs terminal cleanup even if CI was still pending. |
| `test_054_pr_open_closed_transitions_closed_unmerged` | A `pr-open` task whose PR was closed without merge transitions to `closed_unmerged` and runs terminal cleanup. |
| `test_review_feedback_schedules_non_budget_respawn` | New `CHANGES_REQUESTED` feedback snapshots review comments, schedules a pending `review` attempt with `consumed_budget = 0`, and records `last_review_id_acted_on`. |
| `test_conflict_schedules_non_budget_respawn` | A new merge-conflict observation snapshots conflict context, schedules a pending `conflict` attempt with `consumed_budget = 0`, and records `last_conflict_observation`. |
| `test_conflict_review_combined_respawn` | A `done` task whose PR has both a fresh conflict and fresh `CHANGES_REQUESTED` review schedules exactly one non-budget conflict-priority respawn, writes both `conflict_slice` and `review_comments`, records both dedupe markers, and increments `non_budget_respawns_consumed` once. |

**Minimal implementation**

- Fake GitHub PR state, checks, reviews, mergeability, and SHAs.
- CI classifier.
- Review, conflict, and combined conflict+review scheduling helpers using the shared non-budget routine.

**Done criteria**

- Sticky GitHub signals cannot create uncontrolled respawn loops.
- CI failures consume budget only through scheduled retry promotion.
- Human merge/close transitions are detected from both `pr-open` and `done`.

### Slice 10: CLI and Real Adapter Contracts

**Spec coverage**

- CLI output shape.
- Read commands.
- Real tmux/git/GitHub/Slack adapter behavior.
- Section 15 cases: 31, 32, 70, 71, 72, 74e, 84, 85, 85a, 85b, 85c, 85d,
  86.

**Red tests**

| Test | Proves |
|---|---|
| `test_070_task_list_empty_returns_json_array` | `quay task list` emits a JSON array, and no matches emit literal `[]`. |
| `test_071_task_get_returns_object` | `quay task get <id>` emits a single JSON object containing task state, current attempt, and recent events, not an array. |
| `test_072_tick_outputs_ndjson` | `quay tick` emits one JSON object per touched task as NDJSON; each line parses independently. |
| `test_084_external_ref_is_slugged_before_use` | Adversarial `external_ref` input is normalized before use in branch/tmux identifiers while the verbatim value is preserved in SQL. |
| `test_086_install_cmd_runs_through_shell` | The real command adapter runs operator-controlled `install_cmd` through `/bin/sh -c`, preserving shell expansion and chaining semantics. |
| `test_tmux_adapter_session_exits_when_agent_exits` | The real tmux adapter uses `exec sh -c` so the tmux session disappears when the agent process exits, preserving liveness detection. |
| `test_git_adapter_branch_slug_final_check_ref_format` | The real git adapter enforces the final `git check-ref-format` gate and falls back to `task-<id>` if normalization ever produces an invalid ref. |
| `test_cli_write_errors_are_json_objects` | Failed write commands exit non-zero and emit a JSON object with an `error` field on stderr, not unstructured text. |

**Minimal implementation**

- CLI parser and command dispatch.
- JSON stdout/stderr/error shape.
- Adapter contract tests for real tmux and local git where feasible.
- GitHub and Slack adapter tests gated behind explicit integration-test
  configuration.

**Done criteria**

- Service behavior is reachable through documented commands.
- Read commands have stable JSON shape.
- Real adapters satisfy the same contracts proven by fakes.

## First PR Boundary

The first implementation PR should cover Slice 0 and only enough project
scaffolding to make the test harness useful.

Recommended first PR contents:

- project skeleton,
- migration runner,
- SQLite schema and constraints,
- temp data-dir test harness,
- deterministic clock and ID generator,
- artifact-store helper,
- tests listed in Slice 0.

Avoid tmux, GitHub, Slack, and full CLI wiring in the first PR. The purpose of
the first PR is to make Quay's persistence contract executable.

## Traceability Convention

When a test maps to a Section 15 case, include the case number in the test name.
When the spec has duplicate case numbers, include a domain slug after the number
to disambiguate. When a test is a support test, name the invariant instead.

Examples:

- `test_029c_cancel_close_pr_crash_after_irreversible_side_effects`
- `test_048_nonbudget_review_sticky_does_not_respawn`
- `test_schema_enforces_one_pending_attempt_per_task`
- `test_fake_slack_nonce_search_returns_first_bot_match`

PR descriptions should list covered spec cases:

```text
Covers quay-spec.md Section 15:
- 55: enqueue against fresh repo runs bootstrap
- 57: enqueue aborts cleanly on bootstrap failure
- 65: every attempt has one brief and one final_prompt artifact

Adds support coverage:
- one pending attempt per task
- recovery artifact idempotency index
```
