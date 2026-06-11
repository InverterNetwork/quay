-- Normalized storage for structured Quay reviewer findings.

CREATE TABLE review_findings (
  finding_id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  attempt_id INTEGER NOT NULL REFERENCES attempts(attempt_id) ON DELETE CASCADE,
  review_id TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  severity TEXT NOT NULL CHECK (severity IN ('blocking', 'non_blocking')),
  title TEXT NOT NULL,
  body_markdown TEXT NOT NULL,
  principle_text TEXT,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (attempt_id, fingerprint)
);

CREATE INDEX review_findings_review_idx
  ON review_findings(review_id, head_sha);

CREATE INDEX review_findings_task_idx
  ON review_findings(task_id, head_sha, ordinal);

CREATE TABLE review_finding_locations (
  location_id INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id INTEGER NOT NULL REFERENCES review_findings(finding_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 1),
  path TEXT,
  start_line INTEGER CHECK (start_line IS NULL OR start_line >= 1),
  end_line INTEGER CHECK (end_line IS NULL OR end_line >= 1),
  url TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX review_finding_locations_finding_idx
  ON review_finding_locations(finding_id, ordinal);
