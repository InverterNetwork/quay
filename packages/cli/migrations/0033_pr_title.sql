-- Persist a lightweight PR title snapshot for Mission Control review cards.

ALTER TABLE tasks ADD COLUMN pr_title TEXT;
