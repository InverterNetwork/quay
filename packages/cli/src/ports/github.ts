// GitHub operations used by core services. Real implementation lives under
// src/adapters/.
//
// `prExistsForBranch` is the spawn-time read: `gh pr view <branch>` exit 0 is
// "PR exists" (open or closed/merged). Tick uses this to snapshot
// `pr_existed_at_spawn` per attempt for the progress predicate.
//
// `prSnapshot` is the polling read used by tick for `pr-open` and `done`
// state handling: it returns enough to classify PR terminal state, merge
// conflicts, review feedback, and CI status from a single GitHub-side view.
// Real adapter composes this from `gh pr view --json ...` plus
// plain-text `gh pr checks ...` output.
export interface GitHubPort {
  prExistsForBranch(repoId: string, branch: string): boolean;
  // Same spawn-time read as `prExistsForBranch`, but forced through an explicit
  // actor token so worker/reviewer launch paths never depend on ambient gh auth
  // after resolving role-specific credentials.
  prExistsForBranchWithToken(
    repoId: string,
    branch: string,
    token: string,
  ): boolean;
  // Exact reconciliation read for a dead worker that reports an already-open
  // PR before Quay has attached PR metadata to the task row. The adapter must
  // filter by both head branch and base branch, and return only currently open
  // PRs so the classifier can reject ambiguous matches instead of retrying as
  // generic no-progress.
  openPrsForBranchBase(
    repoId: string,
    branch: string,
    baseBranch: string,
  ): OpenBranchPr[];
  createPullRequest(input: {
    repoId: string;
    headBranch: string;
    baseBranch: string;
    title: string;
    body: string;
  }): OpenBranchPr;
  updatePullRequestBody(repoId: string, prNumber: number, body: string): void;
  prCheckStatus(repoId: string, branch: string): PrCheckStatus;
  // Returns true iff a PR for the branch is currently open. Used by the cancel
  // finalizer to decide whether to retain the remote branch in the default
  // cleanup matrix.
  prIsOpen(repoId: string, branch: string): boolean;
  // Idempotent `gh pr close` for the named branch. Real adapter tolerates "PR
  // already closed" and "no PR for branch" without erroring.
  closePr(repoId: string, branch: string): void;
  // Polling read for `pr-open` / `done` handlers. Returns null when no PR is
  // associated with the branch (`gh pr view` exits non-zero). On API error,
  // the adapter throws — tick treats that as a transient failure and logs
  // `tick_error` for the task.
  prSnapshot(repoId: string, branch: string): PrSnapshot | null;
  // Same shape as `prSnapshot` but addresses the PR by its numeric id rather
  // than by branch ref. The `pr-review` terminal short-circuit uses this for
  // synthetic review tasks whose `branch_name` is the internal placeholder
  // `quay-review/<num>` — not a real GitHub ref — so a branch-keyed lookup
  // would always return null and miss external merges/closes.
  prSnapshotByNumber(repoId: string, prNumber: number): PrSnapshot | null;
  // Cheaper PR read for code paths that only need terminal/open state plus
  // identifying metadata. Implementations should avoid check/review reads.
  prLightweightSnapshot(repoId: string, branch: string): PrSnapshot | null;
  prLightweightSnapshotByNumber(
    repoId: string,
    prNumber: number,
  ): PrSnapshot | null;
  // Uncached reads used immediately before authority-sensitive write calls.
  // Tick's normal GitHub wrapper memoizes PR reads for efficiency; guarded
  // merges must re-read live state and verify all guards against that fresh
  // state in the same call path.
  freshPrSnapshotByNumber(repoId: string, prNumber: number): PrSnapshot | null;
  freshPrView(repoId: string, prNumber: number): PullRequestView | null;
  addPullRequestAssignees(
    repoId: string,
    prNumber: number,
    logins: string[],
  ): void;
  mergePullRequest(
    repoId: string,
    prNumber: number,
    expectedHeadSha: string,
  ): void;
  // Best-effort observability for GraphQL quota burn. Returning null means
  // telemetry was unavailable and must not block the caller.
  getGraphqlRateLimit(repoId: string): GitHubGraphqlRateLimit | null;
  prView(repoId: string, prNumber: number): PullRequestView | null;
  // `expectedLogin` overrides the adapter's auto-probed identity when the
  // reviewer worker posts under a different gh login than the tick process.
  // When omitted the adapter falls back to a cached `gh api user --jq .login`.
  fetchPostedReview(
    repoId: string,
    prNumber: number,
    headSha: string,
    expectedLogin?: string,
    token?: string,
    expectedDecision?: PostedReview["decision"],
    expectedBody?: string,
  ): PostedReview | null;
  // Diagnostic read used only after `fetchPostedReview` misses. It reports
  // review authors that did post a recognizable review at the same head SHA,
  // so tick can distinguish "no review posted" from "reviewer.login drifted".
  fetchPostedReviewAuthorsAtHead(
    repoId: string,
    prNumber: number,
    headSha: string,
  ): PostedReviewAuthor[];
  submitPullRequestReview(input: {
    repoId: string;
    prNumber: number;
    headSha: string;
    verdict: "APPROVED" | "CHANGES_REQUESTED";
    body: string;
    token: string;
  }): PostedReview;
  // Validate an explicit actor GH_TOKEN before handing it to a worker or
  // reviewer pane. Throws when the token is invalid, expired, or cannot access the
  // target repository. Kept repo-scoped so GitHub App installation tokens are
  // supported; installation tokens cannot use the authenticated-user endpoint.
  probeTokenAccess(
    repoId: string,
    token: string,
    actor: "worker" | "reviewer",
  ): void;
}

export interface GitHubGraphqlRateLimit {
  limit: number | null;
  used: number | null;
  remaining: number | null;
  resetAt: string | null;
}

export type PrCheckState = "pass" | "fail" | "pending";

export interface PrCheckStatus {
  state: PrCheckState;
  excerpt?: string;
}

export type PrTerminalState = "open" | "merged" | "closed_unmerged";

export type PrMergeableState = "mergeable" | "conflicting" | "unknown";

export type PrReviewDecision =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "COMMENTED"
  | "NONE";

export type PrCheckBucket =
  | "pass"
  | "fail"
  | "pending"
  | "skipping"
  | "cancelled";

export interface PrCheck {
  name: string;
  workflow: string | null;
  bucket: PrCheckBucket;
  required: boolean;
}

export interface PrLatestReview {
  decision: PrReviewDecision;
  latestReviewId: string | null;
  submittedHeadSha?: string | null;
  comments: string;
}

export interface PrChecksReport {
  // SHA the checks were run against. May differ from PR's headSha when a
  // force-push happens between the head-ref read and the checks read; tick
  // detects that as stale and skips this cycle. `null` when no checks at all
  // have been recorded for the PR yet.
  checkSha: string | null;
  items: PrCheck[];
  // Optional preformatted excerpt summarising the failure. Real adapter
  // composes this from `gh run view --log-failed` at the moment of detection.
  failureExcerpt?: string;
}

export interface PrSnapshot {
  state: PrTerminalState;
  isDraft?: boolean;
  headSha: string;
  baseSha: string | null;
  // GitHub's numeric PR id and the human-readable PR URL. Optional because
  // many test fixtures predate PR-metadata writeback and a few `gh` failure
  // modes (rate-limit on the metadata fields, gh older than 2.20) can leave
  // them missing — tick treats absent values as "don't update".
  prNumber?: number | null;
  prUrl?: string | null;
  prTitle?: string | null;
  // The base branch name (`gh pr view --json baseRefName`). Captured so
  // callers that need the base ref for diffing can compute against it
  // without re-scraping. Optional for the same reason as prNumber/prUrl.
  baseRef?: string | null;
  // Current tip SHA of `origin/<baseRef>`, distinct from `baseSha` (which is
  // the merge-base — stable across base advances by design). Conflict-respawn
  // dedup keys on the *tip* so a base advance that may have worsened the
  // conflict can re-trigger a respawn even when head is unchanged. Optional:
  // if the local rev-parse fails (unfetched base) the field is absent and
  // the dedup key falls back to baseSha — preserving the prior fallback shape
  // without silently weakening the trigger when the tip is known.
  baseTipSha?: string | null;
  mergeable: PrMergeableState;
  latestReview: PrLatestReview;
  checks: PrChecksReport;
}

export interface OpenBranchPr {
  number: number;
  title?: string | null;
  url: string | null;
  headSha: string;
  baseSha: string | null;
  baseRef: string | null;
}

export interface PullRequestView {
  number: number;
  title: string;
  body: string;
  url: string | null;
  headRefName: string;
  headSha: string;
  baseRef?: string | null;
  isCrossRepository?: boolean | null;
}

export interface PostedReview {
  reviewId: string;
  decision: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED";
  body: string;
  comments: string;
}

export interface PostedReviewAuthor {
  login: string;
  type: string;
  reviewId: string;
  decision: PostedReview["decision"];
}

// `kind` classifies the merge failure so the tick can decide whether to retry.
// `head_mismatch` and `not_mergeable` are RETRYABLE (head moved / transient
// unmergeable — a later tick may succeed). `method_not_allowed` is
// NON-RETRYABLE: the repo forbids the merge method GitHub was asked to use
// ("Merge commits are not allowed on this repository" and similar), so
// retrying the identical merge every tick can never succeed — the tick parks
// the task instead of looping (BRIX-1921). `unknown` is the catch-all.
export type GitHubMergeErrorKind =
  | "not_mergeable"
  | "head_mismatch"
  | "method_not_allowed"
  | "unknown";

export class GitHubMergeError extends Error {
  constructor(
    message: string,
    readonly kind: GitHubMergeErrorKind,
  ) {
    super(message);
    this.name = "GitHubMergeError";
  }
}
