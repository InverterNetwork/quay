-- Link tasks created by `quay task retarget` back to their source task.
-- The reverse link is recorded as event_data on the source task's
-- `retargeted` audit event so existing task rows stay append-only except for
-- their state transition.

ALTER TABLE tasks ADD COLUMN retargeted_from_task_id TEXT REFERENCES tasks(task_id);

CREATE INDEX tasks_retargeted_from_idx
  ON tasks(retargeted_from_task_id)
  WHERE retargeted_from_task_id IS NOT NULL;
