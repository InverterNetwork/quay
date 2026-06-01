-- Configurable CI ignore policy, layered as deployment defaults plus repo
-- registry overrides. The list columns store JSON arrays so existing repo
-- lifecycle/export/import paths can treat policy as row-local metadata.

ALTER TABLE repos ADD COLUMN ci_ignore_mode TEXT NOT NULL DEFAULT 'inherit'
  CHECK (ci_ignore_mode IN ('inherit', 'extend', 'replace'));

ALTER TABLE repos ADD COLUMN ci_ignored_check_names TEXT NOT NULL DEFAULT '[]';
ALTER TABLE repos ADD COLUMN ci_ignored_workflow_names TEXT NOT NULL DEFAULT '[]';
