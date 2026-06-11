-- Separate durable work-item identity from task execution runs.
--
-- `tasks` remains the run table: attempts/events/artifacts continue to point
-- at task_id, while work_items carries the stable external identity.

CREATE TABLE work_items (
  work_item_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  repo_id TEXT NOT NULL REFERENCES repos(repo_id),
  external_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source, repo_id, external_ref)
);

ALTER TABLE tasks ADD COLUMN work_item_id TEXT REFERENCES work_items(work_item_id);
ALTER TABLE tasks ADD COLUMN run_number INTEGER;
ALTER TABLE tasks ADD COLUMN supersedes_task_id TEXT REFERENCES tasks(task_id);

INSERT INTO work_items (
  work_item_id, source, repo_id, external_ref, created_at, updated_at
)
SELECT
  'wi:' || hex(randomblob(16)),
  'linear',
  repo_id,
  external_ref,
  MIN(created_at),
  MAX(updated_at)
FROM tasks
WHERE external_ref IS NOT NULL
GROUP BY repo_id, external_ref;

INSERT INTO work_items (
  work_item_id, source, repo_id, external_ref, created_at, updated_at
)
SELECT
  'wi:' || task_id,
  'synthetic',
  repo_id,
  task_id,
  created_at,
  updated_at
FROM tasks
WHERE external_ref IS NULL;

UPDATE tasks
   SET work_item_id = (
         SELECT wi.work_item_id
          FROM work_items wi
          WHERE wi.source = 'linear'
            AND wi.repo_id = tasks.repo_id
            AND wi.external_ref = tasks.external_ref
       )
 WHERE external_ref IS NOT NULL;

UPDATE tasks
   SET work_item_id = 'wi:' || task_id
 WHERE external_ref IS NULL;

UPDATE tasks
   SET work_item_id = (
         SELECT source_task.work_item_id
           FROM tasks AS source_task
          WHERE source_task.task_id = tasks.retargeted_from_task_id
       )
 WHERE retargeted_from_task_id IS NOT NULL;

WITH numbered_runs AS (
  SELECT
    task_id,
    ROW_NUMBER() OVER (
      PARTITION BY work_item_id
      ORDER BY
        CASE WHEN retargeted_from_task_id IS NULL THEN 0 ELSE 1 END,
        created_at,
        task_id
    ) AS backfilled_run_number
  FROM tasks
  WHERE work_item_id IS NOT NULL
)
UPDATE tasks
   SET run_number = (
         SELECT numbered_runs.backfilled_run_number
           FROM numbered_runs
          WHERE numbered_runs.task_id = tasks.task_id
       )
 WHERE run_number IS NULL;

DROP INDEX IF EXISTS tasks_repo_external_ref_unique;

CREATE UNIQUE INDEX tasks_work_item_run_number_unique
  ON tasks(work_item_id, run_number)
  WHERE work_item_id IS NOT NULL AND run_number IS NOT NULL;

-- Mirrors TASK_TERMINAL_STATES in src/core/task_state.ts.
CREATE UNIQUE INDEX one_active_run_per_work_item
  ON tasks(work_item_id)
  WHERE work_item_id IS NOT NULL
    AND cancel_requested_at IS NULL
    AND state NOT IN (
      'cancelled',
      'merged_to_feature_branch',
      'merged',
      'closed_unmerged'
    );

CREATE INDEX tasks_work_item_idx
  ON tasks(work_item_id, task_id)
  WHERE work_item_id IS NOT NULL;

CREATE INDEX tasks_supersedes_task_idx
  ON tasks(supersedes_task_id)
  WHERE supersedes_task_id IS NOT NULL;
