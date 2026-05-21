-- Soft task-level PR screenshot request.
--
-- When set, every code-worker prompt for the task asks the worker to include
-- UI screenshots in the PR when the runtime can capture and attach/link them.
-- This is intentionally advisory; Quay does not model worker capabilities yet.

ALTER TABLE tasks ADD COLUMN pr_screenshots_requested INTEGER NOT NULL DEFAULT 0
  CHECK (pr_screenshots_requested IN (0, 1));
