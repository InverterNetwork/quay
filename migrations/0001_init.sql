-- Slice 0 schema: persistence contract for Quay (per quay-spec.md §9).
-- Foreign keys must be enabled at the connection level (PRAGMA foreign_keys = ON).

CREATE TABLE repos (
  repo_id TEXT PRIMARY KEY,
  repo_url TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  package_manager TEXT NOT NULL,
  install_cmd TEXT NOT NULL,
  test_cmd TEXT,
  ci_workflow_name TEXT,
  contribution_guide_path TEXT,
  archived_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE preambles (
  preamble_id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE retry_templates (
  template_id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(repo_id),
  external_ref TEXT,
  state TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  tmux_id TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  pr_number INTEGER,
  pr_url TEXT,
  head_sha TEXT,
  base_sha TEXT,
  attempts_consumed INTEGER NOT NULL DEFAULT 0,
  retry_budget INTEGER NOT NULL,
  budget_exhausted INTEGER NOT NULL DEFAULT 0 CHECK (budget_exhausted IN (0, 1)),
  tick_error TEXT,
  slack_thread_ref TEXT,
  claimed_at TEXT,
  claim_id TEXT,
  claim_expirations_consecutive INTEGER NOT NULL DEFAULT 0,
  last_review_id_acted_on TEXT,
  last_conflict_observation TEXT,
  non_budget_respawns_consumed INTEGER NOT NULL DEFAULT 0,
  next_escalation_seq INTEGER NOT NULL DEFAULT 1,
  cancel_requested_at TEXT,
  cancel_close_pr INTEGER NOT NULL DEFAULT 0 CHECK (cancel_close_pr IN (0, 1)),
  cancel_keep_worktree INTEGER NOT NULL DEFAULT 0 CHECK (cancel_keep_worktree IN (0, 1)),
  spawn_failures_consecutive INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX tasks_state_idx ON tasks(state);

CREATE TABLE attempts (
  attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_number INTEGER NOT NULL,
  preamble_id INTEGER NOT NULL REFERENCES preambles(preamble_id),
  template_id INTEGER REFERENCES retry_templates(template_id),
  reason TEXT NOT NULL,
  consumed_budget INTEGER NOT NULL CHECK (consumed_budget IN (0, 1)),
  tmux_session TEXT,
  spawned_at TEXT,
  remote_sha_at_spawn TEXT,
  remote_sha_at_exit TEXT,
  pr_existed_at_spawn INTEGER NOT NULL DEFAULT 0 CHECK (pr_existed_at_spawn IN (0, 1)),
  ended_at TEXT,
  exit_kind TEXT,
  kill_intent TEXT,
  UNIQUE (task_id, attempt_number)
);

CREATE UNIQUE INDEX one_pending_attempt_per_task
  ON attempts(task_id)
  WHERE spawned_at IS NULL;

CREATE TABLE artifacts (
  artifact_id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_id INTEGER REFERENCES attempts(attempt_id),
  kind TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content_hash TEXT,
  escalation_seq INTEGER,
  escalation_nonce TEXT,
  slack_pre_post_fence_ts TEXT,
  slack_post_ts TEXT,
  slack_recovered_post_ts TEXT,
  captured_at TEXT NOT NULL
);

CREATE UNIQUE INDEX artifact_recovery_idempotency
  ON artifacts(task_id, attempt_id, kind, content_hash)
  WHERE content_hash IS NOT NULL AND attempt_id IS NOT NULL;

CREATE INDEX artifacts_task_kind_attempt_idx
  ON artifacts(task_id, kind, attempt_id);

CREATE TABLE events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_id INTEGER REFERENCES attempts(attempt_id),
  event_type TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  payload_artifact_id INTEGER REFERENCES artifacts(artifact_id),
  occurred_at TEXT NOT NULL
);

CREATE INDEX events_task_occurred_idx ON events(task_id, occurred_at);
