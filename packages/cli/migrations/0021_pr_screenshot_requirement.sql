-- Hard task-level PR screenshot requirement.
--
-- When set, enqueue has already verified that the resolved worker agent
-- advertises screenshot capability. The flag persists the hard prompt mode
-- across retries, goal continuations, and non-budget respawns.

ALTER TABLE tasks ADD COLUMN pr_screenshots_required INTEGER NOT NULL DEFAULT 0
  CHECK (pr_screenshots_required IN (0, 1));
