-- One-repo umbrella workflow persistence.
--
-- An umbrella workflow is a shared feature branch that ordinary task rows can
-- target as their effective PR base. Final PR fields are nullable placeholders
-- for the later reconciliation slice.

CREATE TABLE umbrella_workflows (
  umbrella_workflow_id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_ref TEXT NOT NULL,
  repo_id TEXT NOT NULL REFERENCES repos(repo_id),
  base_branch TEXT NOT NULL,
  feature_branch TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (
    state IN ('active', 'completed', 'cancelled')
  ),
  final_pr_task_id TEXT REFERENCES tasks(task_id),
  final_pr_number INTEGER,
  final_pr_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repo_id, external_ref)
);

CREATE UNIQUE INDEX umbrella_workflows_repo_feature_branch_unique
  ON umbrella_workflows(repo_id, feature_branch);

CREATE TABLE umbrella_tasks (
  umbrella_task_id INTEGER PRIMARY KEY AUTOINCREMENT,
  umbrella_workflow_id INTEGER NOT NULL REFERENCES umbrella_workflows(umbrella_workflow_id),
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(task_id),
  external_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (umbrella_workflow_id, external_ref)
);

CREATE INDEX umbrella_tasks_workflow_idx
  ON umbrella_tasks(umbrella_workflow_id, umbrella_task_id);
