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

export interface LinearBlockedByRelation {
  relationId: string;
  blocker: {
    identifier: string;
    url: string;
    title: string;
    body: string;
    stateType: string | null;
  };
}

export interface LinearHierarchyIssue {
  identifier: string;
  url: string;
  title: string;
  stateType: string | null;
}

export interface LinearIssueHierarchy {
  parent: LinearHierarchyIssue | null;
  children: LinearHierarchyIssue[];
}

export interface LinearPort {
  // Returns null on 404 (no such issue).
  // Throws `ticket_not_actionable` on draft issues, `adapter_error` with
  // `retryable:false` on 5xx, `adapter_error` with `retryable:true` and
  // `retry_after` on 429, and on network/auth errors.
  getIssue(identifier: string): Promise<LinearIssue | null>;

  // Returns Linear-native issues that block this issue. Complete blockers are
  // still returned so enqueue can record the observation in ticket_snapshot.
  getBlockedByRelations(identifier: string): Promise<LinearBlockedByRelation[]>;

  // Returns Linear-native parent/child issue metadata. Complete children are
  // still returned so future enqueue slices can decide whether they count.
  getIssueHierarchy(identifier: string): Promise<LinearIssueHierarchy>;

  // Best-effort idempotent state writeback. Resolves `stateName` to the
  // issue's team workflow state via Linear's `team.states` query
  // (per-process cache keyed on team id) and fires
  // `issueUpdate(input:{stateId})`. No-op when the issue is already at the
  // target state. Throws `unknown_state` when the team has no workflow
  // state with that name; `adapter_error` shape mirrors `getIssue` for
  // every other failure mode. Returns silently on a 404 issue lookup —
  // the ticket may have been deleted on Linear's side, which is not a
  // quay-fixable condition.
  setIssueState(identifier: string, stateName: string): Promise<void>;

  // Updates the Linear issue markdown description. Used by enqueue-time
  // metadata writeback after Quay infers missing canonical config fields.
  updateIssueBody(identifier: string, body: string): Promise<void>;
}
