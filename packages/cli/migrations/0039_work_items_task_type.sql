ALTER TABLE work_items
  ADD COLUMN task_type TEXT
  CHECK (task_type IS NULL OR task_type IN ('bugfix', 'feature', 'chore', 'refactor'));
