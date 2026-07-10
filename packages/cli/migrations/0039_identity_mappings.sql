-- Slack-to-GitHub identity mappings used for automatic PR assignee selection.

CREATE TABLE identity_mappings (
  slack_user_id TEXT PRIMARY KEY,
  slack_display_name TEXT NOT NULL,
  slack_handle TEXT,
  slack_email TEXT,
  github_login TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('mapped', 'verified', 'conflict')),
  source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'csv', 'auto', 'task')),
  last_used_at TEXT,
  last_used_task_id TEXT,
  last_used_pr_number INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX identity_mappings_github_login_unique
  ON identity_mappings(github_login COLLATE NOCASE);

ALTER TABLE tasks ADD COLUMN pr_assignee_login TEXT;
ALTER TABLE tasks ADD COLUMN pr_assignee_selected_at TEXT;
