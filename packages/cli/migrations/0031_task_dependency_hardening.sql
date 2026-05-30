-- Tie umbrella dependency rows to their workflow and prevent duplicate edges.

ALTER TABLE task_dependencies
  ADD COLUMN umbrella_workflow_id INTEGER REFERENCES umbrella_workflows(umbrella_workflow_id);

CREATE UNIQUE INDEX task_dependencies_edge_unique
  ON task_dependencies(
    dependent_task_id,
    dependency_source,
    COALESCE(dependency_task_id, char(0)),
    COALESCE(dependency_external_ref, char(0)),
    COALESCE(dependency_repo_id, char(0)),
    kind,
    scope,
    COALESCE(umbrella_workflow_id, -1)
  );

CREATE INDEX task_dependencies_umbrella_workflow_idx
  ON task_dependencies(umbrella_workflow_id, dependent_task_id)
  WHERE umbrella_workflow_id IS NOT NULL;
