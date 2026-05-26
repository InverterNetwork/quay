-- Shared durable outbox for orchestrator-owned side effects.
--
-- `orchestrator_handoffs` remains as a compatibility surface for existing
-- human/advice workflows, but each handoff is now backed by an outbox item.
-- New delivery-only side effects can use outbox_items directly without
-- pretending to be task claims.

CREATE TABLE outbox_items (
  outbox_item_id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  kind TEXT NOT NULL,
  handler_class TEXT NOT NULL CHECK (
    handler_class IN ('workflow_intervention', 'delivery')
  ),
  source_event_id INTEGER REFERENCES events(event_id),
  idempotency_key TEXT NOT NULL,
  payload_json TEXT,
  route_hint_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'claimed', 'completed', 'cancelled')
  ),
  claim_id TEXT,
  claimed_at TEXT,
  delivered_at TEXT,
  completed_at TEXT,
  last_error TEXT,
  next_eligible_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (idempotency_key)
);

CREATE UNIQUE INDEX outbox_items_task_source_kind_idx
  ON outbox_items(task_id, source_event_id, kind)
  WHERE source_event_id IS NOT NULL;

CREATE INDEX outbox_items_status_created_idx
  ON outbox_items(status, created_at, outbox_item_id);

CREATE INDEX outbox_items_task_status_idx
  ON outbox_items(task_id, status, outbox_item_id);

CREATE INDEX outbox_items_pending_eligible_idx
  ON outbox_items(status, next_eligible_at, created_at, outbox_item_id)
  WHERE status = 'pending';

ALTER TABLE orchestrator_handoffs ADD COLUMN outbox_item_id INTEGER
  REFERENCES outbox_items(outbox_item_id);

INSERT INTO outbox_items (
  task_id, kind, handler_class, source_event_id, idempotency_key,
  payload_json, status, claim_id, claimed_at, completed_at,
  next_eligible_at, created_at, updated_at
)
SELECT
  task_id,
  'workflow_intervention.' || reason,
  'workflow_intervention',
  state_event_id,
  idempotency_key,
  payload_json,
  status,
  claim_id,
  claimed_at,
  completed_at,
  next_eligible_at,
  created_at,
  updated_at
FROM orchestrator_handoffs;

UPDATE orchestrator_handoffs
   SET outbox_item_id = (
     SELECT outbox_items.outbox_item_id
       FROM outbox_items
      WHERE outbox_items.idempotency_key = orchestrator_handoffs.idempotency_key
   );

CREATE INDEX orchestrator_handoffs_outbox_item_idx
  ON orchestrator_handoffs(outbox_item_id);
