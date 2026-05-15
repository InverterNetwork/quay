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

-- Durable review enrollment queue consumed by tick.
CREATE TABLE review_requests (
  request_id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  repo_id TEXT NOT NULL REFERENCES repos(repo_id),
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'review-pr',
  requested_by TEXT,
  delivery_id TEXT,
  tags_json TEXT,
  reviewer_agent TEXT,
  reviewer_model TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('pending_ci', 'scheduled', 'superseded', 'discarded_terminal')
  ),
  scheduled_attempt_id INTEGER REFERENCES attempts(attempt_id),
  superseded_by_request_id INTEGER REFERENCES review_requests(request_id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_state TEXT
);

CREATE UNIQUE INDEX review_requests_unique_head
  ON review_requests(task_id, head_sha);

CREATE INDEX review_requests_pending_idx
  ON review_requests(status, repo_id, pr_number, created_at);
