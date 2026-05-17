-- Task-level goal worker mode.
-- quay: foreign_keys_off
--
-- A goal is owned by its Quay task, not scheduled independently. The task
-- stays the scheduling unit; task_goals carries durable objective/status and
-- accounting state across normal attempts.

ALTER TABLE tasks ADD COLUMN worker_execution TEXT NOT NULL DEFAULT 'oneshot'
  CHECK (worker_execution IN ('oneshot', 'goal'));

ALTER TABLE attempts ADD COLUMN goal_id TEXT;
ALTER TABLE attempts ADD COLUMN goal_report_processed_at TEXT;

-- Add the goal-mode no-progress handoff reason. SQLite cannot alter a CHECK
-- constraint in place, so rebuild the table while preserving rows.
ALTER TABLE orchestrator_handoffs RENAME TO orchestrator_handoffs_old;

CREATE TABLE orchestrator_handoffs (
  handoff_id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  reason TEXT NOT NULL CHECK (
    reason IN (
      'worker_blocker',
      'budget_exhausted',
      'human_reply_ingested',
      'manual_resume',
      'no_progress'
    )
  ),
  state_event_id INTEGER NOT NULL REFERENCES events(event_id),
  idempotency_key TEXT NOT NULL,
  payload_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'claimed', 'completed', 'cancelled')
  ),
  claim_id TEXT,
  claimed_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (idempotency_key),
  UNIQUE (task_id, state_event_id, reason)
);

INSERT INTO orchestrator_handoffs (
  handoff_id, task_id, reason, state_event_id, idempotency_key,
  payload_json, status, claim_id, claimed_at, completed_at, created_at,
  updated_at
)
SELECT
  handoff_id, task_id, reason, state_event_id, idempotency_key,
  payload_json, status, claim_id, claimed_at, completed_at, created_at,
  updated_at
FROM orchestrator_handoffs_old;

DROP TABLE orchestrator_handoffs_old;

CREATE INDEX orchestrator_handoffs_status_created_idx
  ON orchestrator_handoffs(status, created_at, handoff_id);

CREATE INDEX orchestrator_handoffs_task_status_idx
  ON orchestrator_handoffs(task_id, status, handoff_id);

CREATE TABLE task_goals (
  task_id TEXT PRIMARY KEY NOT NULL REFERENCES tasks(task_id),
  goal_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('active', 'blocked', 'budget_limited', 'complete')
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

CREATE INDEX task_goals_status_idx ON task_goals(status);
