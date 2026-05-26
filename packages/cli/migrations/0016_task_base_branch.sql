-- Task-level effective base branch.
--
-- Existing tasks are backfilled from their repo default so later repo config
-- changes do not alter already-enqueued work. New enqueue paths write the
-- effective branch explicitly.

ALTER TABLE tasks ADD COLUMN base_branch TEXT;

UPDATE tasks
   SET base_branch = (
     SELECT repos.base_branch
       FROM repos
      WHERE repos.repo_id = tasks.repo_id
   )
 WHERE base_branch IS NULL;
