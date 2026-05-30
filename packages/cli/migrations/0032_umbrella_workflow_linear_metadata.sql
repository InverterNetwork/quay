-- Persist parent Linear issue metadata for final umbrella PR rendering.

ALTER TABLE umbrella_workflows
  ADD COLUMN linear_issue_title TEXT;

ALTER TABLE umbrella_workflows
  ADD COLUMN linear_issue_url TEXT;
