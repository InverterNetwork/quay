-- Per-attempt observability: snapshot which agent runtime executed this
-- attempt. Format: "<runtime>/<runtime_version>/<model_id>" (single string,
-- grep-friendly). NULL on rows that pre-date this migration; populated at
-- spawn time for new rows by probing the agent binary.

ALTER TABLE attempts ADD COLUMN agent_identity TEXT;
