-- Closes the read-before-write race in `quay enqueue --linear-issue`.
--
-- Two concurrent pollers can both pass the preflight lookupExistingTask()
-- check (each reads zero rows) and then both attempt to INSERT a task for the
-- same (repo_id, external_ref) pair. This partial unique index makes the
-- second INSERT fail with SQLITE_CONSTRAINT_UNIQUE, which the caller catches
-- to return the already-inserted row instead — converging on one task per
-- ticket even under concurrent invocation (spec §3).
--
-- The WHERE clause excludes legacy tasks (external_ref IS NULL) so existing
-- data continues to work without modification.

CREATE UNIQUE INDEX tasks_repo_external_ref_unique
  ON tasks(repo_id, external_ref)
  WHERE external_ref IS NOT NULL;
