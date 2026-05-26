-- Human PR adoption support.
--
-- `authoring_mode` records who owns the branch-writing lifecycle. Synthetic
-- review tasks are review-only until an operator explicitly adopts them; once
-- adopted, Quay code workers may push the existing human PR branch, but branch
-- cleanup must preserve that human-created remote branch by default.

ALTER TABLE tasks ADD COLUMN authoring_mode TEXT NOT NULL DEFAULT 'quay_owned'
  CHECK (authoring_mode IN ('quay_owned', 'synthetic_review', 'adopted_external_pr'));

UPDATE tasks
   SET authoring_mode = 'synthetic_review'
 WHERE task_id LIKE 'pr-review-%';
