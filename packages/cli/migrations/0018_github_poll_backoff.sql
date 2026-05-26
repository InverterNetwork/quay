-- GitHub polling observability and quota protection.
--
-- `github_pr_polled_at` is a task-local timestamp used by tick to avoid
-- taking full PR snapshots for low-priority states every scheduler minute.
--
-- `github_backoffs` stores global circuit-breaker windows. The current
-- consumer is scope='graphql', set after GitHub reports API rate-limit
-- exhaustion so subsequent background polling skips until reset.

ALTER TABLE tasks ADD COLUMN github_pr_polled_at TEXT;

CREATE TABLE github_backoffs (
  scope TEXT PRIMARY KEY,
  pause_until TEXT NOT NULL,
  reason TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  repo_id TEXT
);
