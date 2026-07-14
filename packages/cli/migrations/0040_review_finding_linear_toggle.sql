-- Toggle for review-finding -> Linear issue creation (BRIX-1898).
--
-- Global default lives on deployment_settings; per-repo override lives on
-- repos. Both are nullable INTEGER tri-states:
--   NULL = unset / inherit,  1 = on,  0 = off.
--
-- Resolution at the enqueue gate (tick.ts persistReviewFindings ->
-- enqueueReviewFindingLinearIssues): repo value if non-NULL, else the global
-- default, else ON. Only `synthetic_review` tasks ever reach this gate, so the
-- switch never changes worker-authored (`quay_owned`) behavior. Turning it off
-- suppresses the `review_finding_linear_issue` outbox row only; findings are
-- still persisted and still posted in the PR review.

ALTER TABLE deployment_settings ADD COLUMN review_finding_linear_enabled INTEGER
  CHECK (review_finding_linear_enabled IN (0, 1));

ALTER TABLE repos ADD COLUMN review_finding_linear_enabled INTEGER
  CHECK (review_finding_linear_enabled IN (0, 1));
