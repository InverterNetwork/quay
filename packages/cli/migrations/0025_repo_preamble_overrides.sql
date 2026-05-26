-- Per-repo preamble overrides for worker and reviewer roles.
--
-- NULL keeps the existing global behavior: resolve the latest preamble row for
-- the attempt kind (code/review), creating the built-in default when needed.
-- Non-NULL pins the repo role to a specific preambles.preamble_id so attempts
-- record exact prompt provenance without affecting other repos.

ALTER TABLE repos ADD COLUMN preamble_worker INTEGER REFERENCES preambles(preamble_id);
ALTER TABLE repos ADD COLUMN preamble_reviewer INTEGER REFERENCES preambles(preamble_id);

CREATE INDEX repos_preamble_worker_idx
  ON repos(preamble_worker)
  WHERE preamble_worker IS NOT NULL;

CREATE INDEX repos_preamble_reviewer_idx
  ON repos(preamble_reviewer)
  WHERE preamble_reviewer IS NOT NULL;
