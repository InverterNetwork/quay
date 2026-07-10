-- Add a dedicated orchestrator handoff reason for worker GitHub auth
-- preflight failures that persisted after Quay's one fresh-auth retry.
-- quay: foreign_keys_off
-- SQLite cannot alter CHECK constraints in place, so rebuild while
-- preserving existing rows.
PRAGMA legacy_alter_table = ON;

ALTER TABLE orchestrator_handoffs RENAME TO orchestrator_handoffs_old;

CREATE TABLE orchestrator_handoffs (
  handoff_id INTEGER PRIMARY KEY AUTOINCREMENT,
  outbox_item_id INTEGER REFERENCES outbox_items(outbox_item_id),
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  reason TEXT NOT NULL CHECK (
    reason IN (
      'worker_blocker',
      'budget_exhausted',
      'human_reply_ingested',
      'manual_resume',
      'no_progress',
      'worker_auth_invalid'
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
  next_eligible_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (idempotency_key),
  UNIQUE (task_id, state_event_id, reason)
);

INSERT INTO orchestrator_handoffs (
  handoff_id, outbox_item_id, task_id, reason, state_event_id,
  idempotency_key, payload_json, status, claim_id, claimed_at,
  completed_at, next_eligible_at, created_at, updated_at
)
SELECT
  handoff_id, outbox_item_id, task_id, reason, state_event_id,
  idempotency_key, payload_json, status, claim_id, claimed_at,
  completed_at, next_eligible_at, created_at, updated_at
FROM orchestrator_handoffs_old;

DROP TABLE orchestrator_handoffs_old;

CREATE INDEX orchestrator_handoffs_status_created_idx
  ON orchestrator_handoffs(status, created_at, handoff_id);

CREATE INDEX orchestrator_handoffs_task_status_idx
  ON orchestrator_handoffs(task_id, status, handoff_id);

PRAGMA legacy_alter_table = OFF;
