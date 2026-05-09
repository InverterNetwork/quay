-- Layered tag vocabulary: per-deployment and per-repo namespaces with
-- required/optional metadata.
--
-- Two tables instead of one because values and metadata have different
-- cardinalities: a namespace can have many values but exactly one required
-- flag. Keeping them separate avoids NULLable columns on the values table and
-- makes the "list all namespaces for a repo" query a clean JOIN or two
-- independent SELECTs.
--
-- The (scope, repo_id, namespace, ...) primary-key shape lets scope='repo'
-- rows live in the same table as future scope='deployment' rows without a
-- separate table per scope. The CHECK constraint enforces the invariant that
-- deployment-scoped rows never carry a repo_id and repo-scoped rows always do
-- — the FK alone cannot express the NULL vs NOT NULL distinction.

CREATE TABLE tag_namespaces (
  scope TEXT NOT NULL,
  repo_id TEXT,
  namespace TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (scope, repo_id, namespace, value),
  FOREIGN KEY (repo_id) REFERENCES repos(repo_id),
  CHECK ((scope='deployment' AND repo_id IS NULL)
      OR (scope='repo' AND repo_id IS NOT NULL))
);
CREATE INDEX idx_tag_namespaces_scope_repo ON tag_namespaces(scope, repo_id);

CREATE TABLE tag_namespace_meta (
  scope TEXT NOT NULL,
  repo_id TEXT,
  namespace TEXT NOT NULL,
  required INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (scope, repo_id, namespace),
  FOREIGN KEY (repo_id) REFERENCES repos(repo_id),
  CHECK ((scope='deployment' AND repo_id IS NULL)
      OR (scope='repo' AND repo_id IS NOT NULL))
);
