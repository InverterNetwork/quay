-- Durable handoff queue backoff.
--
-- A human-wait timeout releases the task claim back to awaiting-next-brief,
-- but the handoff should not immediately become drainable again ahead of
-- newer pending handoffs. `next_eligible_at` is NULL for normal pending work
-- and future-dated when a human wait needs a cooldown before re-notification.

ALTER TABLE orchestrator_handoffs ADD COLUMN next_eligible_at TEXT;

CREATE INDEX orchestrator_handoffs_pending_eligible_idx
  ON orchestrator_handoffs(status, next_eligible_at, created_at, handoff_id)
  WHERE status = 'pending';
