-- Additive per-repo prompt guidance.
--
-- `preambles` remains the full global/pinned preamble stream. This table is
-- a separate append-only stream for small repo-specific appendices that compose
-- on top of the selected preamble instead of replacing it.

CREATE TABLE repo_guidance (
  guidance_id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL REFERENCES repos(repo_id),
  role TEXT NOT NULL CHECK (role IN ('worker', 'reviewer')),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX repo_guidance_repo_role_idx
  ON repo_guidance(repo_id, role, guidance_id DESC);

ALTER TABLE attempts ADD COLUMN repo_guidance_id INTEGER REFERENCES repo_guidance(guidance_id);

CREATE INDEX attempts_repo_guidance_id_idx
  ON attempts(repo_guidance_id)
  WHERE repo_guidance_id IS NOT NULL;
