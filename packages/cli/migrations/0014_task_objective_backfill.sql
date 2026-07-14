-- Backfill task-level kind='task_objective' artifact rows for every task
-- that existed before the shared code-worker prompt composer landed.
--
-- The composer's loadOriginalTaskObjective() requires at least one
-- kind='task_objective' artifact with attempt_id IS NULL. Without
-- this backfill, any pre-existing active task would throw on its next CI /
-- crash / stale / wall-clock / malformed retry, on review/conflict respawn,
-- or on orchestrator submit-brief.
--
-- For legacy tasks, the raw original brief lives in the first attempt's
-- (`attempt_number=1`, `reason='initial'`) brief artifact. The backfilled
-- row points at the same on-disk file and copies the content_hash — no file
-- writes are required. The `artifact_recovery_idempotency` unique index
-- excludes `attempt_id IS NULL`, so the new task-level row never collides
-- with the per-attempt brief it shadows.
--
-- The NOT EXISTS clause makes this migration safe to re-run.

INSERT INTO artifacts (task_id, attempt_id, kind, file_path, content_hash, captured_at)
SELECT
  ar.task_id,
  NULL,
  'task_objective',
  ar.file_path,
  ar.content_hash,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM artifacts ar
JOIN attempts a ON a.attempt_id = ar.attempt_id
WHERE ar.kind = 'brief'
  AND a.attempt_number = 1
  AND a.reason = 'initial'
  AND NOT EXISTS (
    SELECT 1
      FROM artifacts ao
     WHERE ao.task_id = ar.task_id
       AND ao.kind = 'task_objective'
       AND ao.attempt_id IS NULL
  );
