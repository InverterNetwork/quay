// Linear adapter contract. Adapters spec §7.
//
// The lean v1 field set is deliberate: the `quay-config` block carried in a
// ticket body is the single source of truth for tags / slack thread /
// authors, Quay does not filter by Linear state, and no other v1 code path
// consumes the rest. Add fields here only when a concrete v1 use case
// demands them (the spec §7 exclusion list enumerates what stays out).

export interface LinearComment {
  id: string;
  authorName: string;
  authorIsBot: boolean;
  body: string;
  createdAt: string;
}

export interface LinearIssue {
  identifier: string;
  url: string;
  title: string;
  body: string;
  comments: LinearComment[];
}

export interface LinearPort {
  // Returns null on 404 (no such issue).
  // Throws `ticket_not_actionable` on draft issues, `adapter_error` with
  // `retryable:false` on 5xx, `adapter_error` with `retryable:true` and
  // `retry_after` on 429, and on network/auth errors.
  getIssue(identifier: string): LinearIssue | null;
}
