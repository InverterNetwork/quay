-- Durable reviewer protocol provenance.
--
-- Review guidance remains stored in attempts.preamble_id for compatibility
-- with existing prompt/guidance history. The static review result protocol is
-- code-owned, so review attempts also snapshot the protocol version that was
-- prepended to their final_prompt. NULL means the attempt predates this
-- migration or is not a review attempt.

ALTER TABLE attempts ADD COLUMN review_protocol_version TEXT;

CREATE INDEX attempts_review_protocol_version_idx
  ON attempts(review_protocol_version)
  WHERE review_protocol_version IS NOT NULL;
