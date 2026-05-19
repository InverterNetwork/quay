-- Goal completion audit gate.
-- quay: foreign_keys_off
--
-- `completion_pending` is an internal status: the worker has made a terminal
-- completion claim, but Quay has not yet accepted the claim and entered the
-- PR lifecycle.

ALTER TABLE task_goals RENAME TO task_goals_old;

CREATE TABLE task_goals (
  task_id TEXT PRIMARY KEY NOT NULL REFERENCES tasks(task_id),
  goal_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'active',
      'blocked',
      'budget_limited',
      'completion_pending',
      'complete'
    )
  ),
  token_budget INTEGER,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  time_used_seconds INTEGER NOT NULL DEFAULT 0,
  no_progress_active_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_id INTEGER REFERENCES attempts(attempt_id),
  current_handoff_id INTEGER REFERENCES orchestrator_handoffs(handoff_id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (token_budget IS NULL OR token_budget > 0)
);

INSERT INTO task_goals (
  task_id, goal_id, objective, status, token_budget,
  tokens_used, time_used_seconds, no_progress_active_count,
  last_attempt_id, current_handoff_id, created_at, updated_at, completed_at
)
SELECT
  task_id, goal_id, objective, status, token_budget,
  tokens_used, time_used_seconds, no_progress_active_count,
  last_attempt_id, current_handoff_id, created_at, updated_at, completed_at
FROM task_goals_old;

DROP TABLE task_goals_old;

CREATE INDEX task_goals_status_idx ON task_goals(status);
