-- PR-review lifecycle support.
--
-- Adds the attempt/task metadata needed for review-only workers, separates
-- reviewer preambles from code-worker preambles, and loosens the pending
-- attempt invariant so an ended pending review attempt can be superseded by a
-- newer SHA.

ALTER TABLE attempts ADD COLUMN head_sha TEXT;
ALTER TABLE attempts ADD COLUMN review_verdict TEXT;
ALTER TABLE attempts ADD COLUMN review_id TEXT;

CREATE UNIQUE INDEX attempts_review_dedup_idx
  ON attempts(task_id, head_sha)
  WHERE reason = 'review_only'
    AND head_sha IS NOT NULL
    AND ended_at IS NULL;

DROP INDEX IF EXISTS one_pending_attempt_per_task;
CREATE UNIQUE INDEX one_pending_attempt_per_task
  ON attempts(task_id)
  WHERE spawned_at IS NULL AND ended_at IS NULL;

ALTER TABLE preambles ADD COLUMN kind TEXT NOT NULL DEFAULT 'code';
CREATE INDEX preambles_kind_idx ON preambles(kind);

ALTER TABLE tasks ADD COLUMN review_infra_failures_consecutive INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN review_infra_failure_head_sha TEXT;
