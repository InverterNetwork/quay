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
