-- Generic task dependency persistence for dependency-aware Quay scheduling.
-- This is intentionally source-agnostic; Linear ingestion is layered on later.

CREATE TABLE task_dependencies (
  dependency_id INTEGER PRIMARY KEY AUTOINCREMENT,
  dependent_task_id TEXT NOT NULL REFERENCES tasks(task_id),
  dependency_task_id TEXT REFERENCES tasks(task_id),
  dependency_source TEXT NOT NULL CHECK (
    dependency_source IN ('linear', 'manual', 'quay')
  ),
  dependency_external_ref TEXT,
  dependency_repo_id TEXT REFERENCES repos(repo_id),
  kind TEXT NOT NULL CHECK (kind IN ('blocked_by')),
  scope TEXT NOT NULL CHECK (scope IN ('normal', 'umbrella')),
  required_state TEXT NOT NULL CHECK (
    required_state IN ('merged', 'merged_to_feature_branch')
  ),
  satisfied_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (dependency_task_id IS NOT NULL OR dependency_external_ref IS NOT NULL)
);

CREATE INDEX task_dependencies_dependent_idx
  ON task_dependencies(dependent_task_id, satisfied_at, dependency_id);

CREATE INDEX task_dependencies_dependency_task_idx
  ON task_dependencies(dependency_task_id, required_state)
  WHERE dependency_task_id IS NOT NULL;

CREATE INDEX task_dependencies_external_ref_idx
  ON task_dependencies(dependency_source, dependency_external_ref)
  WHERE dependency_external_ref IS NOT NULL;
