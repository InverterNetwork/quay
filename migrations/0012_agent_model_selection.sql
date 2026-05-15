-- First-class agent/model selection snapshots.
--
-- Repo columns are role defaults. Task columns are immutable snapshots taken
-- at enqueue / synthetic review scheduling time, so later config changes do
-- not alter already-queued work. Attempt column records the intended model
-- that was passed to the agent invocation.

ALTER TABLE repos ADD COLUMN model_worker TEXT;
ALTER TABLE repos ADD COLUMN model_reviewer TEXT;

ALTER TABLE tasks ADD COLUMN worker_agent TEXT;
ALTER TABLE tasks ADD COLUMN worker_model TEXT;
ALTER TABLE tasks ADD COLUMN reviewer_agent TEXT;
ALTER TABLE tasks ADD COLUMN reviewer_model TEXT;

ALTER TABLE attempts ADD COLUMN agent_model TEXT;
