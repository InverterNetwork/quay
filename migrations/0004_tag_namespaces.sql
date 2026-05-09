-- Layered tag vocabulary: per-deployment and per-repo namespaces with
-- required/optional metadata.
--
-- Two tables instead of one because values and metadata have different
-- cardinalities: a namespace can have many values but exactly one required
-- flag. Keeping them separate avoids NULLable columns on the values table and
-- makes the "list all namespaces for a repo" query a clean JOIN or two
-- independent SELECTs.
--
-- The (scope, repo_id, namespace, ...) shape lets scope='repo' rows live in
-- the same table as scope='deployment' rows. The CHECK constraint enforces
-- the invariant that deployment-scoped rows never carry a repo_id and
-- repo-scoped rows always do — the FK alone cannot express the NULL vs NOT
-- NULL distinction.
--
-- Uniqueness is enforced by an expression index over IFNULL(repo_id, '')
-- rather than a composite primary key. SQLite treats every NULL as distinct
-- in unique constraints, so a composite PK that includes a nullable repo_id
-- silently allows duplicate deployment rows. Folding NULL to '' in the index
-- key collapses deployment rows into a single uniqueness scope.

CREATE TABLE tag_namespaces (
  scope TEXT NOT NULL,
  repo_id TEXT,
  namespace TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (repo_id) REFERENCES repos(repo_id),
  CHECK ((scope='deployment' AND repo_id IS NULL)
      OR (scope='repo' AND repo_id IS NOT NULL))
);
CREATE UNIQUE INDEX uq_tag_namespaces
  ON tag_namespaces(scope, IFNULL(repo_id, ''), namespace, value);
CREATE INDEX idx_tag_namespaces_scope_repo
  ON tag_namespaces(scope, repo_id);

CREATE TABLE tag_namespace_meta (
  scope TEXT NOT NULL,
  repo_id TEXT,
  namespace TEXT NOT NULL,
  required INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (repo_id) REFERENCES repos(repo_id),
  CHECK ((scope='deployment' AND repo_id IS NULL)
      OR (scope='repo' AND repo_id IS NOT NULL))
);
CREATE UNIQUE INDEX uq_tag_namespace_meta
  ON tag_namespace_meta(scope, IFNULL(repo_id, ''), namespace);
