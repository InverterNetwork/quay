import type {
  GitHubPort,
  GitHubGraphqlRateLimit,
  OpenBranchPr,
  PostedReview,
  PostedReviewAuthor,
  PrCheckStatus,
  PrSnapshot,
  PullRequestView,
} from "../../../src/ports/github.ts";

export class FakeGitHub implements GitHubPort {
  readonly defaultWorkerToken = "ghs_fake_worker_test_token";
  readonly calls: { repoId: string; branch: string }[] = [];
  readonly snapshotCalls: { repoId: string; branch: string }[] = [];
  readonly snapshotByNumberCalls: { repoId: string; prNumber: number }[] = [];
  readonly lightweightSnapshotCalls: { repoId: string; branch: string }[] = [];
  readonly lightweightSnapshotByNumberCalls: {
    repoId: string;
    prNumber: number;
  }[] = [];
  readonly closePrCalls: { repoId: string; branch: string }[] = [];
  readonly prExisting = new Map<string, boolean>(); // key = `${repoId}\0${branch}`
  readonly openPrsByBranchBase = new Map<string, OpenBranchPr[]>();
  readonly prOpen = new Map<string, boolean>();
  readonly checkStatuses = new Map<string, PrCheckStatus>();
  readonly createPullRequestCalls: {
    repoId: string;
    headBranch: string;
    baseBranch: string;
    title: string;
    body: string;
  }[] = [];
  readonly updatePullRequestBodyCalls: {
    repoId: string;
    prNumber: number;
    body: string;
  }[] = [];
  // Explicit per-(repo, branch) PR snapshots take precedence over the legacy
  // `setPrCheckStatus`-derived synthesis.
  readonly snapshots = new Map<string, PrSnapshot | null>();
  readonly snapshotsByNumber = new Map<string, PrSnapshot | null>();
  readonly lightweightSnapshots = new Map<string, PrSnapshot | null>();
  readonly lightweightSnapshotsByNumber = new Map<string, PrSnapshot | null>();
  readonly prViews = new Map<string, PullRequestView | null>();
  readonly postedReviews = new Map<string, PostedReview | null>();
  readonly postedReviewAuthorsAtHead = new Map<string, PostedReviewAuthor[]>();
  readonly tokenAccessCalls: {
    repoId: string;
    token: string;
    actor: "worker" | "reviewer";
  }[] = [];
  readonly mergePullRequestCalls: {
    repoId: string;
    prNumber: number;
    expectedHeadSha: string;
  }[] = [];
  private graphqlRateLimit: GitHubGraphqlRateLimit | null = null;
  private prSnapshotHandler:
    | ((repoId: string, branch: string) => PrSnapshot | null)
    | null = null;
  private tokenAccessHandler: (
    repoId: string,
    token: string,
    actor: "worker" | "reviewer",
  ) => void = () => {};
  private mergePullRequestHandler:
    | ((repoId: string, prNumber: number, expectedHeadSha: string) => void)
    | null = null;

  prExistsForBranch(repoId: string, branch: string): boolean {
    this.calls.push({ repoId, branch });
    return this.prExisting.get(`${repoId}\0${branch}`) ?? false;
  }

  setPrExists(repoId: string, branch: string, exists: boolean): void {
    this.prExisting.set(`${repoId}\0${branch}`, exists);
  }

  openPrsForBranchBase(
    repoId: string,
    branch: string,
    baseBranch: string,
  ): OpenBranchPr[] {
    return [
      ...(this.openPrsByBranchBase.get(`${repoId}\0${branch}\0${baseBranch}`) ?? []),
    ];
  }

  setOpenPrsForBranchBase(
    repoId: string,
    branch: string,
    baseBranch: string,
    prs: OpenBranchPr[],
  ): void {
    this.openPrsByBranchBase.set(`${repoId}\0${branch}\0${baseBranch}`, [...prs]);
  }

  createPullRequest(input: {
    repoId: string;
    headBranch: string;
    baseBranch: string;
    title: string;
    body: string;
  }): OpenBranchPr {
    this.createPullRequestCalls.push({ ...input });
    const prNumber = 1000 + this.createPullRequestCalls.length;
    const pr: OpenBranchPr = {
      number: prNumber,
      url: `https://github.example/${input.repoId}/pull/${prNumber}`,
      headSha: `head-${prNumber}`,
      baseSha: `base-${prNumber}`,
      baseRef: input.baseBranch,
    };
    this.setOpenPrsForBranchBase(input.repoId, input.headBranch, input.baseBranch, [
      pr,
    ]);
    this.setPrView(input.repoId, prNumber, {
      number: prNumber,
      title: input.title,
      body: input.body,
      url: pr.url,
      headRefName: input.headBranch,
      headSha: pr.headSha,
      baseRef: input.baseBranch,
      isCrossRepository: false,
    });
    return pr;
  }

  updatePullRequestBody(repoId: string, prNumber: number, body: string): void {
    this.updatePullRequestBodyCalls.push({ repoId, prNumber, body });
    const existing = this.prView(repoId, prNumber);
    if (existing !== null) {
      this.setPrView(repoId, prNumber, { ...existing, body });
    }
  }

  prCheckStatus(repoId: string, branch: string): PrCheckStatus {
    return this.checkStatuses.get(`${repoId}\0${branch}`) ?? { state: "pending" };
  }

  setPrCheckStatus(repoId: string, branch: string, status: PrCheckStatus): void {
    this.checkStatuses.set(`${repoId}\0${branch}`, status);
  }

  prIsOpen(repoId: string, branch: string): boolean {
    return this.prOpen.get(`${repoId}\0${branch}`) ?? false;
  }

  setPrIsOpen(repoId: string, branch: string, open: boolean): void {
    this.prOpen.set(`${repoId}\0${branch}`, open);
  }

  closePr(repoId: string, branch: string): void {
    this.closePrCalls.push({ repoId, branch });
    // Idempotent: closing a non-existent or already-closed PR succeeds.
    this.prOpen.set(`${repoId}\0${branch}`, false);
  }

  prSnapshot(repoId: string, branch: string): PrSnapshot | null {
    this.snapshotCalls.push({ repoId, branch });
    if (this.prSnapshotHandler !== null) {
      return this.prSnapshotHandler(repoId, branch);
    }
    const key = `${repoId}\0${branch}`;
    if (this.snapshots.has(key)) return this.snapshots.get(key) ?? null;
    const cs = this.checkStatuses.get(key);
    if (cs !== undefined) return synthesizeSnapshotFromCheckStatus(cs);
    return null;
  }

  setPrSnapshot(repoId: string, branch: string, snapshot: PrSnapshot | null): void {
    this.snapshots.set(`${repoId}\0${branch}`, snapshot);
  }

  setPrSnapshotHandler(
    handler: ((repoId: string, branch: string) => PrSnapshot | null) | null,
  ): void {
    this.prSnapshotHandler = handler;
  }

  prSnapshotByNumber(repoId: string, prNumber: number): PrSnapshot | null {
    this.snapshotByNumberCalls.push({ repoId, prNumber });
    const key = `${repoId}\0${prNumber}`;
    return this.snapshotsByNumber.get(key) ?? null;
  }

  setPrSnapshotByNumber(
    repoId: string,
    prNumber: number,
    snapshot: PrSnapshot | null,
  ): void {
    this.snapshotsByNumber.set(`${repoId}\0${prNumber}`, snapshot);
  }

  prLightweightSnapshot(repoId: string, branch: string): PrSnapshot | null {
    this.lightweightSnapshotCalls.push({ repoId, branch });
    const key = `${repoId}\0${branch}`;
    if (this.lightweightSnapshots.has(key)) {
      return this.lightweightSnapshots.get(key) ?? null;
    }
    return this.prSnapshot(repoId, branch);
  }

  setPrLightweightSnapshot(
    repoId: string,
    branch: string,
    snapshot: PrSnapshot | null,
  ): void {
    this.lightweightSnapshots.set(`${repoId}\0${branch}`, snapshot);
  }

  prLightweightSnapshotByNumber(
    repoId: string,
    prNumber: number,
  ): PrSnapshot | null {
    this.lightweightSnapshotByNumberCalls.push({ repoId, prNumber });
    const key = `${repoId}\0${prNumber}`;
    if (this.lightweightSnapshotsByNumber.has(key)) {
      return this.lightweightSnapshotsByNumber.get(key) ?? null;
    }
    return this.prSnapshotByNumber(repoId, prNumber);
  }

  freshPrSnapshotByNumber(repoId: string, prNumber: number): PrSnapshot | null {
    return this.prSnapshotByNumber(repoId, prNumber);
  }

  freshPrView(repoId: string, prNumber: number): PullRequestView | null {
    return this.prView(repoId, prNumber);
  }

  mergePullRequest(
    repoId: string,
    prNumber: number,
    expectedHeadSha: string,
  ): void {
    this.mergePullRequestCalls.push({ repoId, prNumber, expectedHeadSha });
    this.mergePullRequestHandler?.(repoId, prNumber, expectedHeadSha);
  }

  setMergePullRequestHandler(
    handler:
      | ((repoId: string, prNumber: number, expectedHeadSha: string) => void)
      | null,
  ): void {
    this.mergePullRequestHandler = handler;
  }

  setPrLightweightSnapshotByNumber(
    repoId: string,
    prNumber: number,
    snapshot: PrSnapshot | null,
  ): void {
    this.lightweightSnapshotsByNumber.set(`${repoId}\0${prNumber}`, snapshot);
  }

  getGraphqlRateLimit(_repoId: string): GitHubGraphqlRateLimit | null {
    return this.graphqlRateLimit === null ? null : { ...this.graphqlRateLimit };
  }

  setGraphqlRateLimit(rateLimit: GitHubGraphqlRateLimit | null): void {
    this.graphqlRateLimit =
      rateLimit === null ? null : { ...rateLimit };
  }

  prView(repoId: string, prNumber: number): PullRequestView | null {
    return this.prViews.get(`${repoId}\0${prNumber}`) ?? null;
  }

  setPrView(repoId: string, prNumber: number, view: PullRequestView | null): void {
    this.prViews.set(`${repoId}\0${prNumber}`, view);
  }

  fetchPostedReview(
    repoId: string,
    prNumber: number,
    headSha: string,
  ): PostedReview | null {
    return this.postedReviews.get(`${repoId}\0${prNumber}\0${headSha}`) ?? null;
  }

  fetchPostedReviewAuthorsAtHead(
    repoId: string,
    prNumber: number,
    headSha: string,
  ): PostedReviewAuthor[] {
    return [
      ...(this.postedReviewAuthorsAtHead.get(`${repoId}\0${prNumber}\0${headSha}`) ?? []),
    ];
  }

  setPostedReview(
    repoId: string,
    prNumber: number,
    headSha: string,
    review: PostedReview | null,
  ): void {
    this.postedReviews.set(`${repoId}\0${prNumber}\0${headSha}`, review);
  }

  setPostedReviewAuthorsAtHead(
    repoId: string,
    prNumber: number,
    headSha: string,
    authors: PostedReviewAuthor[],
  ): void {
    this.postedReviewAuthorsAtHead.set(`${repoId}\0${prNumber}\0${headSha}`, [
      ...authors,
    ]);
  }

  probeTokenAccess(
    repoId: string,
    token: string,
    actor: "worker" | "reviewer",
  ): void {
    this.tokenAccessCalls.push({ repoId, token, actor });
    this.tokenAccessHandler(repoId, token, actor);
  }

  setTokenAccessHandler(
    handler: (
      repoId: string,
      token: string,
      actor: "worker" | "reviewer",
    ) => void,
  ): void {
    this.tokenAccessHandler = handler;
  }
}

function synthesizeSnapshotFromCheckStatus(s: PrCheckStatus): PrSnapshot {
  const bucket = s.state;
  const checks: PrSnapshot["checks"] = {
    checkSha: "fake-head",
    items: [{ name: "build", workflow: null, bucket, required: true }],
  };
  if (s.excerpt !== undefined) checks.failureExcerpt = s.excerpt;
  return {
    prNumber: null,
    state: "open",
    headSha: "fake-head",
    baseSha: "fake-base",
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks,
  };
}
