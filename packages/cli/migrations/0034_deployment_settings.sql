-- Mutable deployment settings. config.toml remains bootstrap/host wiring;
-- this row owns operator-editable defaults after an explicit import/update.

CREATE TABLE deployment_settings (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  worker_agent TEXT,
  worker_model TEXT,
  reviewer_agent TEXT,
  reviewer_model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
