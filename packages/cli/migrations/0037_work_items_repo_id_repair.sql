-- quay: foreign_keys_off
-- Repair deployments that applied an older 0035_work_items_runs.sql before
-- work_items.repo_id was added. Migrations are tracked by filename, so those
-- DBs need a forward-only rebuild even though the checked-in 0035 is now fixed.

CREATE TABLE work_items_repaired (
  work_item_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  repo_id TEXT NOT NULL REFERENCES repos(repo_id),
  external_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source, repo_id, external_ref)
);

INSERT INTO work_items_repaired (
  work_item_id, source, repo_id, external_ref, created_at, updated_at
)
WITH grouped AS (
  SELECT
    wi.work_item_id AS old_work_item_id,
    wi.source,
    wi.external_ref,
    t.repo_id,
    MIN(wi.created_at) AS created_at,
    MAX(wi.updated_at) AS updated_at
  FROM work_items wi
  JOIN tasks t ON t.work_item_id = wi.work_item_id
  GROUP BY wi.work_item_id, wi.source, wi.external_ref, t.repo_id
), repo_counts AS (
  SELECT old_work_item_id, COUNT(*) AS repo_count
  FROM grouped
  GROUP BY old_work_item_id
)
SELECT
  CASE
    WHEN repo_counts.repo_count = 1 THEN grouped.old_work_item_id
    ELSE grouped.old_work_item_id || ':' || grouped.repo_id
  END AS work_item_id,
  grouped.source,
  grouped.repo_id,
  grouped.external_ref,
  grouped.created_at,
  grouped.updated_at
FROM grouped
JOIN repo_counts ON repo_counts.old_work_item_id = grouped.old_work_item_id;

UPDATE tasks
   SET work_item_id = (
         SELECT repaired.work_item_id
           FROM work_items old
           JOIN work_items_repaired repaired
             ON repaired.source = old.source
            AND repaired.external_ref = old.external_ref
            AND repaired.repo_id = tasks.repo_id
          WHERE old.work_item_id = tasks.work_item_id
          LIMIT 1
       )
 WHERE work_item_id IS NOT NULL;

DROP TABLE work_items;
ALTER TABLE work_items_repaired RENAME TO work_items;
