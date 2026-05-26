-- Durable orchestrator handoff queue for tasks that enter
-- awaiting-next-brief and need judgment outside `quay tick`.

CREATE TABLE orchestrator_handoffs (
  handoff_id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  reason TEXT NOT NULL CHECK (
    reason IN (
      'worker_blocker',
      'budget_exhausted',
      'human_reply_ingested',
      'manual_resume'
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

CREATE INDEX orchestrator_handoffs_status_created_idx
  ON orchestrator_handoffs(status, created_at, handoff_id);

CREATE INDEX orchestrator_handoffs_task_status_idx
  ON orchestrator_handoffs(task_id, status, handoff_id);
