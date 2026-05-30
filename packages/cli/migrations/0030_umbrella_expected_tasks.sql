-- Persist the expected Linear child set for umbrella workflows.
--
-- This table records umbrella membership as observed at parent enqueue time.
-- It lets Quay distinguish not-yet-enqueued children from children already
-- completed outside Quay, without polling Linear from tick.

CREATE TABLE umbrella_expected_tasks (
  umbrella_expected_task_id INTEGER PRIMARY KEY AUTOINCREMENT,
  umbrella_workflow_id INTEGER NOT NULL REFERENCES umbrella_workflows(umbrella_workflow_id),
  external_ref TEXT NOT NULL,
  title TEXT,
  linear_issue_id TEXT,
  linear_issue_url TEXT,
  state TEXT NOT NULL DEFAULT 'expected' CHECK (
    state IN ('expected', 'linked', 'complete_without_quay')
  ),
  completion_source TEXT CHECK (
    completion_source IS NULL OR completion_source IN ('linear', 'manual')
  ),
  completion_reason TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (umbrella_workflow_id, external_ref)
);

CREATE INDEX umbrella_expected_tasks_workflow_state_idx
  ON umbrella_expected_tasks(umbrella_workflow_id, state, external_ref);
