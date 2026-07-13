ALTER TABLE tasks ADD COLUMN spawn_retry_next_eligible_at TEXT;
ALTER TABLE tasks ADD COLUMN spawn_failure_reason TEXT;

CREATE INDEX tasks_spawn_retry_eligible_idx
  ON tasks(state, spawn_retry_next_eligible_at)
  WHERE state IN ('queued', 'pr-review');
