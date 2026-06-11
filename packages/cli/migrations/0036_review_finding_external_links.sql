-- Provider links created from persisted review findings.

CREATE TABLE review_finding_external_links (
  link_id INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id INTEGER REFERENCES review_findings(finding_id) ON DELETE SET NULL,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  review_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_external_id TEXT NOT NULL,
  provider_url TEXT NOT NULL,
  outbox_item_id INTEGER REFERENCES outbox_items(outbox_item_id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, task_id, review_id, fingerprint)
);

CREATE INDEX review_finding_external_links_finding_idx
  ON review_finding_external_links(finding_id);

