-- Slice 12 schema additions (per docs/quay-spec-deployment-adapters.md §5).
-- Owns: task_tags table (clustering tags), tasks.authors_json column
-- (TicketAuthor[] for Slack @-mention escalations).
-- Foreign keys must be enabled at the connection level (PRAGMA foreign_keys = ON).
--
-- Deletion semantics for task_tags: no ON DELETE clause, so SQLite's default
-- (RESTRICT / NO ACTION) applies — deleting a task that still has task_tags
-- rows is rejected by the FK. Tasks are not normally deleted in Quay; if a
-- caller ever needs to remove one, the rows in task_tags must be cleared
-- first. Chosen for safety; spec §5 leaves the choice open.

CREATE TABLE task_tags (
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  tag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, tag)
);
CREATE INDEX task_tags_by_tag ON task_tags(tag);

ALTER TABLE tasks ADD COLUMN authors_json TEXT;
