import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";
import type { CommandRunner } from "../ports/command_runner.ts";
import type { GitPort } from "../ports/git.ts";
import { GitHubMergeError } from "../ports/github.ts";
import type {
  GitHubGraphqlRateLimit,
  GitHubPort,
  OpenBranchPr,
  PostedReview,
  PostedReviewAuthor,
  PrCheckStatus,
  PrSnapshot,
  PullRequestView,
} from "../ports/github.ts";
import type { LinearPort } from "../ports/linear.ts";
import type { SlackPort } from "../ports/slack.ts";
import type { PaneExitInfo, TmuxPort, TmuxSpawnInput } from "../ports/tmux.ts";
import { parseAgentBinary, probeAgentIdentity } from "./agent_identity.ts";
import {
  DEFAULT_AGENT_NAME,
  DEFAULT_CLAUDE_WORKER_INVOCATION,
  type AgentResolver,
  type AgentRole,
  type ResolvedAgent,
} from "./agents.ts";
import { baseBranchNameSchema } from "./base_branch.ts";
import { QUAY_BRANCH_PREFIX } from "./branch_slug.ts";
import { runCancelFinalizer } from "./cancel.ts";
import { EXIT_INFO_NONE } from "./exit_status.ts";
import {
  LINEAR_STATE_IN_PROGRESS,
  LINEAR_STATE_WAITING,
  LinearSyncQueue,
} from "./linear_state_sync.ts";
import {
  cancelOpenOrchestratorHandoffs,
  enqueueOrchestratorHandoff,
  reopenClaimedOrchestratorHandoffs,
} from "./orchestrator_handoffs.ts";
import { ensurePreambleIdForAttemptReason } from "./preamble.ts";
import { collectToolTraceArtifact } from "./tool_trace.ts";
import { collectUsageArtifact, persistResolvedAttemptModel } from "./usage.ts";
import {
  classifyAndApply,
  type ClassifyContextAttempt,
  type ClassifyContextTask,
  type ClassifyOutcome,
} from "./classifier.ts";
import { classifyCi } from "./ci_status.ts";
import {
  EMPTY_CI_IGNORE_POLICY,
  parseCiIgnoreListJson,
  resolveCiIgnorePolicy,
  type CiIgnorePolicy,
  type CiIgnoreMode,
  type RepoCiIgnorePolicy,
} from "./ci_policy.ts";
import { fireFailpoint } from "./failpoints.ts";
import { scheduleNonBudgetRespawn } from "./non_budget_respawn.ts";
import {
  enterReview,
  type TaskAuthoringMode,
} from "./pr_review.ts";
import { enqueuePrReadyApprovedOutboxItem } from "./pr_ready_approved_outbox.ts";
import {
  processGoalCompletionAudit,
  type GoalCompletionPendingTask,
} from "./goal_audit.ts";
import { transitionTaskState } from "./task_state.ts";
import {
  listWaitingDependencyTasks,
  releaseTaskIfDependenciesSatisfied,
  reconcileWaitingDependencyTask,
  satisfyDependenciesForMergedTask,
  satisfyDependenciesForMergedToFeatureBranchTask,
} from "./task_dependencies.ts";
import {
  scheduleCleanSpawnRetry,
  scheduleDeterministicRetry,
  type BudgetRetryReason,
  type RetryAttemptRef,
} from "./retries.ts";
import { accountGoalFailureAndMaybeLimit } from "./goals.ts";
import { requireUmbrellaFeatureBranchExists } from "./umbrella_workflows.ts";
import type { SupervisorLock } from "./supervisor_lock.ts";
import {
  installWorktreeDependencies,
  loadWorktreeDependencyRepo,
} from "./worktree_dependencies.ts";

export const DEFAULT_MAX_CONCURRENT = 2;
export const DEFAULT_MAX_CONCURRENT_REVIEWERS = 2;
export const DEFAULT_MAX_ATTEMPT_DURATION_SECONDS = 3600;
export const DEFAULT_STALENESS_THRESHOLD_SECONDS = 600;
export const DEFAULT_MAX_SPAWN_FAILURES = 3;
export const DEFAULT_CLAIM_TIMEOUT_SECONDS = 1800;
export const DEFAULT_MAX_CLAIM_EXPIRATIONS = 3;
export const DEFAULT_MAX_NON_BUDGET_RESPAWNS = 20;
export const DEFAULT_LOW_PRIORITY_PR_POLL_INTERVAL_MINUTES = 5;
export const DEFAULT_PARKED_PR_POLL_INTERVAL_MINUTES = 15;
export const DEFAULT_GITHUB_GRAPHQL_BACKOFF_MINUTES = 10;
export const DEFAULT_RETAINED_CANCELLED_WORKTREE_RETENTION_HOURS = 24;
export const DEFAULT_RETAINED_CANCELLED_WORKTREE_GC_BATCH_SIZE = 10;
export const WORKER_GH_TOKEN_ENV = "QUAY_WORKER_GH_TOKEN";
export const REVIEWER_GH_TOKEN_ENV = "QUAY_REVIEWER_GH_TOKEN";
const REVIEW_RESULT_FILENAME = ".quay-review-result.json";
const CODEX_SOURCE_HOME_ENV = "QUAY_CODEX_SOURCE_HOME";
// Canonical claude worker template, kept here as a named re-export so
// callers that imported it from `tick.ts` before the agent-resolver
// refactor (and tests that still pass `agentInvocation: "..."` as a
// shorthand) don't have to chase the rename.
//
// `--output-format json` makes claude print one final JSON envelope
// (tokens, cost, model id, full response) to stdout instead of the
// streaming human-readable text. We redirect that stdout to
// `.quay-usage.json` in the worktree so the dead-worker classifier
// can ingest it as a `usage` artifact.
//
// `--debug --debug-file .quay-tool-trace.log` captures claude's
// tool-dispatch / API events into a worktree-local file, ingested
// as a `tool_trace` artifact. This is the highest-signal data for
// prompt iteration; without it, only the final stdout reaches the
// session log and intermediate tool calls vanish.
//
// Operators with non-claude agent runtimes (Codex, Cursor, ...)
// register their own entry under `[agents.invocations]` and either
// emit the same `.quay-usage.json` / `.quay-tool-trace.log` files for
// capture, or accept null cost / no trace for those attempts.
export const DEFAULT_AGENT_INVOCATION = DEFAULT_CLAUDE_WORKER_INVOCATION;

export interface TickDeps {
  db: DB;
  clock: Clock;
  git: GitPort;
  commandRunner: CommandRunner;
  github: GitHubPort;
  tmux: TmuxPort;
  slack: SlackPort;
  artifactStore: ArtifactStore;
  supervisorLock: SupervisorLock;
  // Passed through to runCancelFinalizer so the cancel sweep also picks
  // up the writeback without a separate wiring.
  linear?: LinearPort;
  referenceReposRoot?: string | undefined;
}

export interface TickOptions {
  maxConcurrent?: number;
  maxConcurrentReviewers?: number;
  reviewerEnabled?: boolean;
  gateQuayOwnedDone?: boolean;
  // gh login of the reviewer worker; threaded into fetchPostedReview so the
  // ingest matches the right author when tick and worker authenticate as
  // different identities. Defaults to whatever `gh api user` reports.
  reviewerLogin?: string;
  // Absolute path to a fallback file (expected mode 0600) whose contents
  // are exported as `GH_TOKEN` in the worker tmux pane's environment.
  // `QUAY_WORKER_GH_TOKEN` in the tick process environment wins when present.
  workerGhTokenFile?: string;
  // Absolute path to a fallback file (expected mode 0600) whose contents
  // are exported as `GH_TOKEN` in the reviewer tmux pane's environment.
  // `QUAY_REVIEWER_GH_TOKEN` in the tick process environment wins when
  // present; this file path exists for migration compatibility.
  reviewerGhTokenFile?: string;
  // Test seam for token-source selection. Production callers leave this
  // unset so tick reads the real process environment.
  env?: NodeJS.ProcessEnv;
  // Either `agentResolver` (production: looks up the registered agent
  // for a given (repo_id, role)) or `agentInvocation` (test shorthand:
  // same string for every attempt). When both are set, the resolver
  // wins. When neither is set, every attempt runs the built-in claude
  // default. `agentInvocation` is kept around so tests that just want
  // "run `bun --version` as the worker" don't have to construct a
  // resolver and a fake DB row.
  agentResolver?: AgentResolver;
  agentInvocation?: string;
  maxAttemptDurationSeconds?: number;
  stalenessThresholdSeconds?: number;
  maxSpawnFailures?: number;
  claimTimeoutSeconds?: number;
  maxClaimExpirations?: number;
  maxNonBudgetRespawns?: number;
  referenceReposRoot?: string | undefined;
  ciIgnorePolicy?: CiIgnorePolicy;
}

interface ParsedReviewResult {
  verdict: "approved" | "changes_requested";
  body: string;
  findings: unknown[];
  raw: string;
}

type ReviewResultRead =
  | { ok: true; result: ParsedReviewResult }
  | { ok: false; diagnostic: string; raw?: string };

export type TickAction =
  | "spawned"
  | "skipped_capacity"
  | "skipped_predicate"
  | "skipped_no_pending_attempt"
  | "spawn_substrate_failed"
  | "blocker_ingested"
  | "goal_continuation_scheduled"
  | "goal_completion_pending"
  | "goal_completion_accepted"
  | "goal_completion_rejected"
  | "goal_budget_limited"
  | "malformed_signal"
  | "pr_opened"
  | "existing_pr_attached"
  | "no_progress"
  | "crashed"
  | "spawn_window_recovered"
  | "spawn_failed"
  | "wall_clock_killed"
  | "stale_killed"
  | "kill_intent_set"
  | "ci_failed"
  | "ci_pending"
  | "ci_passed"
  | "adopted_pr_reconciled"
  | "umbrella_final_pr_reconciled"
  | "pr_merged"
  | "pr_closed_unmerged"
  | "review_respawn_scheduled"
  | "review_requested"
  | "review_approved"
  | "review_changes_requested"
  | "review_errored"
  | "review_retry_scheduled"
  | "conflict_respawn_scheduled"
  | "non_budget_loop_parked"
  | "claim_expired"
  | "orchestrator_loop_parked"
  | "cancel_finalized"
  | "retained_worktree_cleaned"
  | "slack_fence_captured"
  | "slack_post_recovered"
  | "slack_posted"
  | "slack_reply_ingested"
  | "waiting_human_requeued"
  | "slack_skipped"
  | "github_backoff_skipped"
  | "tick_error";

export interface TickTaskResult {
  task_id: string;
  action: TickAction;
  error?: string;
}

interface QueuedTaskRow {
  task_id: string;
  repo_id: string;
  branch_name: string;
  base_branch: string;
  tmux_id: string;
  worktree_path: string;
  cancel_requested_at: string | null;
  external_ref: string | null;
  worker_agent: string | null;
  worker_model: string | null;
  worker_execution: "oneshot" | "goal";
}

interface RunningTaskRow {
  task_id: string;
  repo_id: string;
  branch_name: string;
  base_branch: string | null;
  tmux_id: string;
  worktree_path: string;
  pr_number: number | null;
  cancel_requested_at: string | null;
  worker_execution: "oneshot" | "goal";
}

interface PrOpenTaskRow {
  task_id: string;
  repo_id: string;
  authoring_mode: TaskAuthoringMode;
  branch_name: string;
  worktree_path: string;
  cancel_requested_at: string | null;
  last_review_id_acted_on: string | null;
  last_conflict_observation: string | null;
  github_pr_polled_at: string | null;
}

interface PrReviewTaskRow {
  task_id: string;
  repo_id: string;
  authoring_mode: TaskAuthoringMode;
  branch_name: string;
  worktree_path: string;
  pr_number: number | null;
  cancel_requested_at: string | null;
  github_pr_polled_at: string | null;
}

type PrTerminalFromState =
  | "pr-open"
  | "done"
  | "pr-review"
  | "awaiting-next-brief"
  | "claimed-by-orchestrator"
  | "waiting_external_changes"
  | "waiting_human"
  | "non_budget_loop"
  | "worktree_error"
  | "orchestrator_loop"
  | "queued"
  | "running";

interface ParkedPrTerminalTaskRow {
  task_id: string;
  repo_id: string;
  authoring_mode: TaskAuthoringMode;
  state: PrTerminalFromState;
  branch_name: string;
  worktree_path: string;
  pr_number: number | null;
  head_sha: string | null;
  cancel_requested_at: string | null;
  github_pr_polled_at: string | null;
}

// Queued / running tasks with a Quay-owned PR don't poll PR state via any
// per-state handler — `processRunningTask` looks at the worker pane, and
// `promoteAndSpawn` only checks cancel intent. If a human closes the PR
// unmerged while the task is in one of these states (typical repro: the
// task bounced from pr-review back to queued via CHANGES_REQUESTED, then
// the human closed the PR before the next worker attempt), tick will keep
// spawning workers that push to the same branch and open replacement PRs.
// The closed-unmerged sweep runs before promotion / dead-worker
// classification and finalises any such task to `closed_unmerged`.
interface ClosedUnmergedCandidateRow {
  task_id: string;
  repo_id: string;
  authoring_mode: TaskAuthoringMode;
  state: "queued" | "running";
  branch_name: string;
  tmux_id: string;
  worktree_path: string;
  pr_number: number;
}

interface ReviewAttemptTaskRow {
  task_id: string;
  repo_id: string;
  authoring_mode: TaskAuthoringMode;
  branch_name: string;
  tmux_id: string;
  worktree_path: string;
  pr_number: number | null;
  cancel_requested_at: string | null;
  review_infra_failures_consecutive: number;
  review_infra_failure_head_sha: string | null;
  attempt_id: number;
  attempt_number: number;
  preamble_id: number;
  head_sha: string;
  tmux_session: string | null;
  spawned_at: string | null;
  kill_intent: string | null;
  reviewer_agent: string | null;
  reviewer_model: string | null;
}

interface DoneTaskRow {
  task_id: string;
  repo_id: string;
  authoring_mode: TaskAuthoringMode;
  branch_name: string;
  worktree_path: string;
  pr_number: number | null;
  cancel_requested_at: string | null;
  last_review_id_acted_on: string | null;
  last_conflict_observation: string | null;
  github_pr_polled_at: string | null;
}

interface UmbrellaSubtaskIntegrationRow {
  umbrella_workflow_id: number;
  feature_branch: string;
  final_pr_task_id: string | null;
}

interface ReadyUmbrellaFinalPrWorkflowRow {
  umbrella_workflow_id: number;
  external_ref: string;
  repo_id: string;
  base_branch: string;
  feature_branch: string;
  linear_issue_title: string | null;
  linear_issue_url: string | null;
  final_pr_task_id: string | null;
  final_pr_number: number | null;
  final_pr_url: string | null;
}

interface UmbrellaFinalPrExpectedSubtaskRow {
  external_ref: string;
  title: string | null;
  state: string;
  completion_source: string | null;
  completion_reason: string | null;
  task_id: string | null;
  task_state: string | null;
  pr_url: string | null;
  objective_path: string | null;
}

type SyntheticReviewLifecycleState =
  | "pr-review"
  | "done"
  | "waiting_external_changes";

interface SyntheticReviewLifecycleTaskRow {
  task_id: string;
  repo_id: string;
  authoring_mode: TaskAuthoringMode;
  state: SyntheticReviewLifecycleState;
  branch_name: string;
  worktree_path: string;
  pr_number: number | null;
  cancel_requested_at: string | null;
  github_pr_polled_at: string | null;
}

interface ClaimedTaskRow {
  task_id: string;
  claimed_at: string | null;
  claim_id: string | null;
  claim_expirations_consecutive: number;
  cancel_requested_at: string | null;
}

interface PendingAttemptRow {
  attempt_id: number;
  attempt_number: number;
  consumed_budget: number;
  preamble_id: number;
}

interface PendingReviewRequestRow {
  request_id: number;
  task_id: string;
  repo_id: string;
  pr_number: number;
}

interface CurrentAttemptRow {
  attempt_id: number;
  attempt_number: number;
  preamble_id: number;
  template_id: number | null;
  reason: string;
  consumed_budget: number;
  remote_sha_at_spawn: string | null;
  pr_existed_at_spawn: number;
  tmux_session: string | null;
  spawned_at: string | null;
  kill_intent: string | null;
  goal_id: string | null;
  goal_report_processed_at: string | null;
}

class TickGithubCache implements GitHubPort {
  private readonly prSnapshotByBranch = new Map<string, PrSnapshot | null>();
  private readonly prSnapshotByNumberCache = new Map<string, PrSnapshot | null>();
  private readonly lightweightByBranch = new Map<string, PrSnapshot | null>();
  private readonly lightweightByNumber = new Map<string, PrSnapshot | null>();
  private readonly prViews = new Map<string, PullRequestView | null>();
  private readonly postedReviews = new Map<string, PostedReview | null>();
  private readonly graphqlRateLimits = new Map<string, GitHubGraphqlRateLimit | null>();

  constructor(private readonly inner: GitHubPort) {}

  get defaultWorkerToken(): string | undefined {
    return (this.inner as { defaultWorkerToken?: string }).defaultWorkerToken;
  }

  prExistsForBranch(repoId: string, branch: string): boolean {
    return this.inner.prExistsForBranch(repoId, branch);
  }

  prExistsForBranchWithToken(
    repoId: string,
    branch: string,
    token: string,
  ): boolean {
    return this.inner.prExistsForBranchWithToken(repoId, branch, token);
  }

  openPrsForBranchBase(
    repoId: string,
    branch: string,
    baseBranch: string,
  ): OpenBranchPr[] {
    return this.inner.openPrsForBranchBase(repoId, branch, baseBranch);
  }

  createPullRequest(input: {
    repoId: string;
    headBranch: string;
    baseBranch: string;
    title: string;
    body: string;
  }): OpenBranchPr {
    const pr = this.inner.createPullRequest(input);
    this.prSnapshotByBranch.delete(`${input.repoId}\0${input.headBranch}`);
    this.lightweightByBranch.delete(`${input.repoId}\0${input.headBranch}`);
    return pr;
  }

  updatePullRequestBody(repoId: string, prNumber: number, body: string): void {
    this.inner.updatePullRequestBody(repoId, prNumber, body);
    this.prViews.delete(`${repoId}\0${prNumber}`);
  }

  prCheckStatus(repoId: string, branch: string): PrCheckStatus {
    return this.inner.prCheckStatus(repoId, branch);
  }

  prIsOpen(repoId: string, branch: string): boolean {
    return this.inner.prIsOpen(repoId, branch);
  }

  closePr(repoId: string, branch: string): void {
    this.inner.closePr(repoId, branch);
  }

  prSnapshot(repoId: string, branch: string): PrSnapshot | null {
    const key = `${repoId}\0${branch}`;
    if (!this.prSnapshotByBranch.has(key)) {
      const snapshot = this.inner.prSnapshot(repoId, branch);
      this.prSnapshotByBranch.set(key, snapshot);
      this.rememberSnapshotAliases(repoId, branch, snapshot, false);
    }
    return this.prSnapshotByBranch.get(key) ?? null;
  }

  prSnapshotByNumber(repoId: string, prNumber: number): PrSnapshot | null {
    const key = `${repoId}\0${prNumber}`;
    if (!this.prSnapshotByNumberCache.has(key)) {
      const snapshot = this.inner.prSnapshotByNumber(repoId, prNumber);
      this.prSnapshotByNumberCache.set(key, snapshot);
      this.rememberSnapshotAliases(repoId, String(prNumber), snapshot, false);
    }
    return this.prSnapshotByNumberCache.get(key) ?? null;
  }

  prLightweightSnapshot(repoId: string, branch: string): PrSnapshot | null {
    const key = `${repoId}\0${branch}`;
    if (!this.lightweightByBranch.has(key)) {
      const snapshot = this.inner.prLightweightSnapshot(repoId, branch);
      this.lightweightByBranch.set(key, snapshot);
      this.rememberSnapshotAliases(repoId, branch, snapshot, true);
    }
    return this.lightweightByBranch.get(key) ?? null;
  }

  prLightweightSnapshotByNumber(
    repoId: string,
    prNumber: number,
  ): PrSnapshot | null {
    const key = `${repoId}\0${prNumber}`;
    if (!this.lightweightByNumber.has(key)) {
      const snapshot = this.inner.prLightweightSnapshotByNumber(repoId, prNumber);
      this.lightweightByNumber.set(key, snapshot);
      this.rememberSnapshotAliases(repoId, String(prNumber), snapshot, true);
    }
    return this.lightweightByNumber.get(key) ?? null;
  }

  freshPrSnapshotByNumber(repoId: string, prNumber: number): PrSnapshot | null {
    const snapshot = this.inner.freshPrSnapshotByNumber(repoId, prNumber);
    this.prSnapshotByNumberCache.set(`${repoId}\0${prNumber}`, snapshot);
    this.rememberSnapshotAliases(repoId, String(prNumber), snapshot, false);
    return snapshot;
  }

  freshPrView(repoId: string, prNumber: number): PullRequestView | null {
    const view = this.inner.freshPrView(repoId, prNumber);
    this.prViews.set(`${repoId}\0${prNumber}`, view);
    return view;
  }

  mergePullRequest(
    repoId: string,
    prNumber: number,
    expectedHeadSha: string,
  ): void {
    this.inner.mergePullRequest(repoId, prNumber, expectedHeadSha);
    this.prSnapshotByNumberCache.delete(`${repoId}\0${prNumber}`);
    this.lightweightByNumber.delete(`${repoId}\0${prNumber}`);
  }

  getGraphqlRateLimit(repoId: string): GitHubGraphqlRateLimit | null {
    if (!this.graphqlRateLimits.has(repoId)) {
      this.graphqlRateLimits.set(repoId, this.inner.getGraphqlRateLimit(repoId));
    }
    const value = this.graphqlRateLimits.get(repoId) ?? null;
    return value === null ? null : { ...value };
  }

  prView(repoId: string, prNumber: number): PullRequestView | null {
    const key = `${repoId}\0${prNumber}`;
    if (!this.prViews.has(key)) {
      this.prViews.set(key, this.inner.prView(repoId, prNumber));
    }
    return this.prViews.get(key) ?? null;
  }

  fetchPostedReview(
    repoId: string,
    prNumber: number,
    headSha: string,
    expectedLogin?: string,
  ): PostedReview | null {
    const key = `${repoId}\0${prNumber}\0${headSha}\0${expectedLogin ?? ""}`;
    if (!this.postedReviews.has(key)) {
      this.postedReviews.set(
        key,
        this.inner.fetchPostedReview(repoId, prNumber, headSha, expectedLogin),
      );
    }
    return this.postedReviews.get(key) ?? null;
  }

  fetchPostedReviewAuthorsAtHead(
    repoId: string,
    prNumber: number,
    headSha: string,
  ): PostedReviewAuthor[] {
    return this.inner.fetchPostedReviewAuthorsAtHead(repoId, prNumber, headSha);
  }

  submitPullRequestReview(input: {
    repoId: string;
    prNumber: number;
    headSha: string;
    verdict: "APPROVED" | "CHANGES_REQUESTED";
    body: string;
    token: string;
  }): PostedReview {
    const posted = this.inner.submitPullRequestReview(input);
    this.postedReviews.set(
      `${input.repoId}\0${input.prNumber}\0${input.headSha}\0`,
      posted,
    );
    this.prSnapshotByNumberCache.delete(`${input.repoId}\0${input.prNumber}`);
    this.lightweightByNumber.delete(`${input.repoId}\0${input.prNumber}`);
    return posted;
  }

  probeTokenAccess(
    repoId: string,
    token: string,
    actor: "worker" | "reviewer",
  ): void {
    this.inner.probeTokenAccess(repoId, token, actor);
  }

  private rememberSnapshotAliases(
    repoId: string,
    selector: string,
    snapshot: PrSnapshot | null,
    lightweight: boolean,
  ): void {
    if (snapshot === null) return;
    if (snapshot.prNumber !== undefined && snapshot.prNumber !== null) {
      const numberKey = `${repoId}\0${snapshot.prNumber}`;
      if (lightweight) {
        if (!this.lightweightByNumber.has(numberKey)) {
          this.lightweightByNumber.set(numberKey, snapshot);
        }
      } else if (!this.prSnapshotByNumberCache.has(numberKey)) {
        this.prSnapshotByNumberCache.set(numberKey, snapshot);
      }
    }
    if (selector.startsWith(QUAY_BRANCH_PREFIX)) {
      const branchKey = `${repoId}\0${selector}`;
      if (lightweight) {
        if (!this.lightweightByBranch.has(branchKey)) {
          this.lightweightByBranch.set(branchKey, snapshot);
        }
      } else if (!this.prSnapshotByBranch.has(branchKey)) {
        this.prSnapshotByBranch.set(branchKey, snapshot);
      }
    }
  }
}

interface GithubBackoffRow {
  pause_until: string;
  reason: string;
  repo_id: string | null;
}

interface GithubBackoffState {
  active: GithubBackoffRow | null;
}

function readActiveGithubGraphqlBackoff(
  db: DB,
  nowISO: string,
): GithubBackoffRow | null {
  return (
    db
      .query<GithubBackoffRow, [string]>(
        `SELECT pause_until, reason, repo_id
           FROM github_backoffs
          WHERE scope = 'graphql'
            AND pause_until > ?
          LIMIT 1`,
      )
      .get(nowISO) ?? null
  );
}

function githubBackoffSkipResult(
  backoff: GithubBackoffState,
  taskId: string,
): TickTaskResult | null {
  if (backoff.active === null) return null;
  return {
    task_id: taskId,
    action: "github_backoff_skipped",
    error: `GitHub GraphQL polling paused until ${backoff.active.pause_until}: ${backoff.active.reason}`,
  };
}

function recordTickErrorWithGithubBackoff(
  deps: TickDeps,
  backoff: GithubBackoffState,
  taskId: string,
  err: unknown,
  repoId?: string,
): TickTaskResult {
  const recorded = maybeRecordGithubGraphqlBackoff(deps, err, repoId);
  if (recorded === null) return recordTickError(deps, taskId, err);
  backoff.active = recorded;
  const message = err instanceof Error ? err.message : String(err);
  return recordTickError(
    deps,
    taskId,
    new Error(
      `${message}; GitHub GraphQL polling paused until ${recorded.pause_until}`,
    ),
  );
}

function maybeRecordGithubGraphqlBackoff(
  deps: TickDeps,
  err: unknown,
  repoId?: string,
): GithubBackoffRow | null {
  const message = err instanceof Error ? err.message : String(err);
  if (!isGithubRateLimitError(message)) return null;
  const nowISO = deps.clock.nowISO();
  const rateLimit =
    repoId === undefined ? null : safeGraphqlRateLimit(deps.github, repoId);
  const pauseUntil = resolveGithubBackoffPauseUntil(nowISO, message, rateLimit);
  const reason = formatGithubBackoffReason(message, rateLimit);
  deps.db
    .query(
      `INSERT INTO github_backoffs (scope, pause_until, reason, observed_at, repo_id)
       VALUES ('graphql', ?, ?, ?, ?)
       ON CONFLICT(scope) DO UPDATE SET
         pause_until = excluded.pause_until,
         reason = excluded.reason,
         observed_at = excluded.observed_at,
         repo_id = excluded.repo_id`,
    )
    .run(pauseUntil, reason, nowISO, repoId ?? null);
  return { pause_until: pauseUntil, reason, repo_id: repoId ?? null };
}

function isGithubRateLimitError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("rate limit") &&
    (lower.includes("github") ||
      lower.includes("graphql") ||
      lower.includes("gh pr") ||
      lower.includes("gh api") ||
      lower.includes("api rate limit"))
  );
}

function safeGraphqlRateLimit(
  github: GitHubPort,
  repoId: string,
): GitHubGraphqlRateLimit | null {
  try {
    return github.getGraphqlRateLimit(repoId);
  } catch {
    return null;
  }
}

function resolveGithubBackoffPauseUntil(
  nowISO: string,
  message: string,
  rateLimit: GitHubGraphqlRateLimit | null,
): string {
  const nowMs = Date.parse(nowISO);
  const fallback = new Date(
    nowMs + DEFAULT_GITHUB_GRAPHQL_BACKOFF_MINUTES * 60_000,
  ).toISOString();
  const resetAt =
    rateLimit?.resetAt ?? parseGithubResetTimeFromMessage(message, nowISO);
  if (resetAt === null) return fallback;
  const resetMs = Date.parse(resetAt);
  if (!Number.isFinite(resetMs) || resetMs <= nowMs) return fallback;
  return new Date(resetMs + 30_000).toISOString();
}

function parseGithubResetTimeFromMessage(
  message: string,
  nowISO: string,
): string | null {
  const iso = message.match(
    /reset(?:s|ting)?\s+(?:at|on)\s+([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+-]+Z?)/i,
  )?.[1];
  if (iso !== undefined) {
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  const retrySeconds = message.match(/retry[- ]after[:=]?\s*(\d+)/i)?.[1];
  if (retrySeconds !== undefined) {
    const seconds = Number(retrySeconds);
    if (Number.isFinite(seconds) && seconds > 0) {
      return new Date(Date.parse(nowISO) + seconds * 1000).toISOString();
    }
  }
  return null;
}

function formatGithubBackoffReason(
  message: string,
  rateLimit: GitHubGraphqlRateLimit | null,
): string {
  const compact = message.replace(/\s+/g, " ").trim();
  const suffix =
    rateLimit === null
      ? ""
      : ` (graphql remaining=${rateLimit.remaining ?? "unknown"}, used=${rateLimit.used ?? "unknown"}, reset=${rateLimit.resetAt ?? "unknown"})`;
  return `${compact}${suffix}`;
}

function shouldPollLowPriorityPr(
  githubPrPolledAt: string | null,
  nowISO: string,
  intervalMinutes: number,
): boolean {
  if (githubPrPolledAt === null) return true;
  const lastMs = Date.parse(githubPrPolledAt);
  const nowMs = Date.parse(nowISO);
  if (!Number.isFinite(lastMs) || !Number.isFinite(nowMs)) return true;
  return nowMs - lastMs >= intervalMinutes * 60_000;
}

function markGithubPrPolled(deps: TickDeps, taskId: string): void {
  deps.db
    .query(`UPDATE tasks SET github_pr_polled_at = ? WHERE task_id = ?`)
    .run(deps.clock.nowISO(), taskId);
}

export async function tick_once(
  deps: TickDeps,
  options: TickOptions = {},
): Promise<TickTaskResult[]> {
  if (options.referenceReposRoot !== undefined) {
    deps = { ...deps, referenceReposRoot: options.referenceReposRoot };
  }
  deps = { ...deps, github: new TickGithubCache(deps.github) };
  const max = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const agentResolver = resolveTickAgentResolver(options);
  // Linear writebacks are scheduled inside the lock but drained after it
  // releases, so a slow or unreachable Linear cannot extend the supervisor-
  // lock-held window and starve concurrent ticks / cancels.
  const linearSyncs = new LinearSyncQueue(deps.linear);
  // Spec §5: a tick that fires while another tick (or `quay cancel`) holds
  // the supervisor lock exits immediately without action — the next
  // scheduled fire retries. `tryRun` returns `acquired: false` in that case;
  // we surface it as an empty result list rather than throwing, so cron
  // observes a clean exit.
  const attempt = await deps.supervisorLock.tryRun(async () => {
    const results: TickTaskResult[] = [];
    const nowISO = deps.clock.nowISO();
    const githubBackoff: GithubBackoffState = {
      active: readActiveGithubGraphqlBackoff(deps.db, nowISO),
    };

    for (const task of readRetainedCancelledWorktreeGcCandidates(
      deps.db,
      retainedCancelledWorktreeGcCutoff(nowISO),
      DEFAULT_RETAINED_CANCELLED_WORKTREE_GC_BATCH_SIZE,
    )) {
      try {
        cleanupRetainedCancelledWorktree(deps, task);
        results.push({
          task_id: task.task_id,
          action: "retained_worktree_cleaned",
        });
      } catch (err) {
        results.push(recordTickError(deps, task.task_id, err));
      }
    }

    if (options.reviewerEnabled === true) {
      for (const req of readPendingReviewRequests(deps.db)) {
        const skipped = githubBackoffSkipResult(githubBackoff, req.task_id);
        if (skipped !== null) {
          results.push(skipped);
          continue;
        }
        try {
          const result = processPendingReviewRequest(deps, req, options);
          if (result !== null) results.push(result);
        } catch (err) {
          results.push(
            recordTickErrorWithGithubBackoff(
              deps,
              githubBackoff,
              req.task_id,
              err,
              req.repo_id,
            ),
          );
        }
      }
    }

    // Top-of-loop cancel check (spec §5 + §14). Cancel intent is durable on
    // the task row, so honor it from every non-terminal state — running,
    // pr-open, done, awaiting-next-brief, claimed-by-orchestrator,
    // waiting_human, parked. Per-state handling for these tasks is skipped
    // this cycle; the finalizer drives them to `cancelled`.
    const cancelTargets = readCancelTargets(deps.db);
    const cancelledIds = new Set<string>();
    for (const task of cancelTargets) {
      try {
        await runCancelFinalizer(deps, task.task_id, linearSyncs);
        cancelledIds.add(task.task_id);
        results.push({ task_id: task.task_id, action: "cancel_finalized" });
      } catch (err) {
        results.push(recordTickError(deps, task.task_id, err));
        cancelledIds.add(task.task_id);
      }
    }

    // Closed-unmerged sweep for queued + running tasks. Other states
    // (pr-open, done, pr-review, synthetic, parked) already short-circuit
    // to terminal in their per-state handlers; queued + running are the gap
    // — neither processRunningTask nor promoteAndSpawn polls PR state, so
    // a human closing the PR while the task is mid-respawn would otherwise
    // let the next worker push and open a replacement PR.
    // `closedUnmergedIds` excludes a candidate from this tick's per-state
    // processing when the sweep succeeded or errored. A probe failure
    // (transient GitHub error, malformed snapshot) must NOT fall through to
    // promoteAndSpawn / processRunningTask — that's the exact regression
    // path the sweep exists to prevent. The one exception is an active
    // GraphQL backoff for a running task: the GitHub probe is skipped, but
    // the tmux-local watchdog still needs to enforce kill_intent, wall-clock,
    // and stale-log handling.
    const closedUnmergedIds = new Set<string>();
    for (const task of readClosedUnmergedCandidates(deps.db)) {
      if (cancelledIds.has(task.task_id)) continue;
      const skipped = githubBackoffSkipResult(githubBackoff, task.task_id);
      if (skipped !== null) {
        if (task.state === "queued") {
          results.push(skipped);
          closedUnmergedIds.add(task.task_id);
        }
        continue;
      }
      try {
        const result = processClosedUnmergedQuayPr(deps, task);
        if (result !== null) {
          results.push(result);
          closedUnmergedIds.add(task.task_id);
        }
      } catch (err) {
        results.push(
          recordTickErrorWithGithubBackoff(
            deps,
            githubBackoff,
            task.task_id,
            err,
            task.repo_id,
          ),
        );
        closedUnmergedIds.add(task.task_id);
      }
    }

    // Snapshot active tasks once per tick (spec §5 "for each task in active
    // states"). Processing running first lets dead-worker classification run,
    // but tasks that transition through `queued` mid-tick are not promoted
    // until the next tick — the retry latency budget is one tick interval.
    const runningSnapshot = readRunning(deps.db).filter(
      (t) => !cancelledIds.has(t.task_id) && !closedUnmergedIds.has(t.task_id),
    );
    const goalCompletionPendingSnapshot = readGoalCompletionPending(
      deps.db,
    ).filter((t) => !cancelledIds.has(t.task_id));
    const syntheticReviewLifecycleSnapshot = readSyntheticReviewLifecycle(
      deps.db,
    ).filter((t) => !cancelledIds.has(t.task_id));
    const syntheticReviewLifecycleIds = new Set(
      syntheticReviewLifecycleSnapshot.map((t) => t.task_id),
    );
    const prOpenSnapshot = readPrOpen(deps.db).filter(
      (t) => !cancelledIds.has(t.task_id),
    );
    const doneSnapshot = readDone(deps.db).filter(
      (t) =>
        !cancelledIds.has(t.task_id) &&
        !syntheticReviewLifecycleIds.has(t.task_id) &&
        shouldPollLowPriorityPr(
          t.github_pr_polled_at,
          nowISO,
          DEFAULT_LOW_PRIORITY_PR_POLL_INTERVAL_MINUTES,
        ),
    );
    const parkedPrTerminalSnapshot = readParkedPrTerminal(deps.db).filter(
      (t) =>
        !cancelledIds.has(t.task_id) &&
        shouldPollLowPriorityPr(
          t.github_pr_polled_at,
          nowISO,
          DEFAULT_PARKED_PR_POLL_INTERVAL_MINUTES,
        ),
    );
    const claimedSnapshot = readClaimed(deps.db).filter(
      (t) => !cancelledIds.has(t.task_id),
    );
    const waitingHumanSnapshot = readWaitingHuman(deps.db).filter(
      (t) => !cancelledIds.has(t.task_id),
    );
    const runningReviewSnapshot = readRunningReviewAttempts(deps.db).filter(
      (t) => !cancelledIds.has(t.task_id),
    );
    const pendingReviewSnapshot = readPendingReviewAttempts(deps.db).filter(
      (t) => !cancelledIds.has(t.task_id),
    );

    for (const task of listWaitingDependencyTasks(deps.db)) {
      if (cancelledIds.has(task.task_id)) continue;
      linearSyncs.enqueue(task.external_ref, LINEAR_STATE_WAITING);
      try {
        reconcileWaitingDependencyTask(deps, task.task_id, nowISO);
      } catch (err) {
        results.push(recordTickError(deps, task.task_id, err));
      }
    }

    const queuedSnapshot = readQueued(deps.db).filter(
      (t) => !cancelledIds.has(t.task_id) && !closedUnmergedIds.has(t.task_id),
    );

    for (const task of runningSnapshot) {
      try {
        const result = processRunningTask(deps, task, options, githubBackoff);
        if (result !== null) results.push(result);
      } catch (err) {
        results.push(
          recordTickErrorWithGithubBackoff(
            deps,
            githubBackoff,
            task.task_id,
            err,
            task.repo_id,
          ),
        );
      }
    }

    for (const task of goalCompletionPendingSnapshot) {
      const skipped = githubBackoffSkipResult(githubBackoff, task.task_id);
      if (skipped !== null) {
        results.push(skipped);
        continue;
      }
      try {
        markGithubPrPolled(deps, task.task_id);
        const result = processGoalCompletionAudit(deps, task);
        if (result !== null) results.push(result);
      } catch (err) {
        results.push(
          recordTickErrorWithGithubBackoff(
            deps,
            githubBackoff,
            task.task_id,
            err,
            task.repo_id,
          ),
        );
      }
    }

    for (const workflow of readReadyUmbrellaFinalPrWorkflows(deps.db)) {
      try {
        results.push(reconcileUmbrellaFinalPr(deps, workflow));
      } catch (err) {
        const taskId =
          workflow.final_pr_task_id ??
          `umbrella-final-pr-${workflow.umbrella_workflow_id}`;
        results.push(
          recordTickErrorWithGithubBackoff(
            deps,
            githubBackoff,
            taskId,
            err,
            workflow.repo_id,
          ),
        );
      }
    }

    for (const task of prOpenSnapshot) {
      const skipped = githubBackoffSkipResult(githubBackoff, task.task_id);
      if (skipped !== null) {
        results.push(skipped);
        continue;
      }
      try {
        const result = processPrOpenTask(deps, task, options);
        if (result !== null) results.push(result);
      } catch (err) {
        results.push(
          recordTickErrorWithGithubBackoff(
            deps,
            githubBackoff,
            task.task_id,
            err,
            task.repo_id,
          ),
        );
      }
    }

    for (const task of doneSnapshot) {
      const skipped = githubBackoffSkipResult(githubBackoff, task.task_id);
      if (skipped !== null) {
        results.push(skipped);
        continue;
      }
      try {
        const result = processDoneTask(deps, task, options);
        if (result !== null) results.push(result);
      } catch (err) {
        results.push(
          recordTickErrorWithGithubBackoff(
            deps,
            githubBackoff,
            task.task_id,
            err,
            task.repo_id,
          ),
        );
      }
    }

    const syntheticReviewAttemptSkipIds = new Set<string>();
    for (const task of syntheticReviewLifecycleSnapshot) {
      if (
        !shouldPollLowPriorityPr(
          task.github_pr_polled_at,
          nowISO,
          DEFAULT_LOW_PRIORITY_PR_POLL_INTERVAL_MINUTES,
        )
      ) {
        continue;
      }
      const skipped = githubBackoffSkipResult(githubBackoff, task.task_id);
      if (skipped !== null) {
        results.push(skipped);
        syntheticReviewAttemptSkipIds.add(task.task_id);
        continue;
      }
      try {
        const result = processSyntheticReviewLifecycle(deps, task, options);
        if (result !== null) {
          results.push(result);
          if (
            result.action === "pr_merged" ||
            result.action === "pr_closed_unmerged" ||
            result.action === "review_requested"
          ) {
            syntheticReviewAttemptSkipIds.add(task.task_id);
          }
        }
      } catch (err) {
        results.push(
          recordTickErrorWithGithubBackoff(
            deps,
            githubBackoff,
            task.task_id,
            err,
            task.repo_id,
          ),
        );
      }
    }

    const terminalParkedIds = new Set<string>();
    for (const task of parkedPrTerminalSnapshot) {
      const skipped = githubBackoffSkipResult(githubBackoff, task.task_id);
      if (skipped !== null) {
        results.push(skipped);
        continue;
      }
      try {
        const result = processParkedPrTerminal(deps, task);
        if (result !== null) {
          results.push(result);
          terminalParkedIds.add(task.task_id);
        }
      } catch (err) {
        results.push(
          recordTickErrorWithGithubBackoff(
            deps,
            githubBackoff,
            task.task_id,
            err,
            task.repo_id,
          ),
        );
      }
    }

    for (const task of claimedSnapshot) {
      if (terminalParkedIds.has(task.task_id)) continue;
      try {
        const result = processClaimedTask(deps, task, options);
        if (result !== null) results.push(result);
      } catch (err) {
        results.push(recordTickError(deps, task.task_id, err));
      }
    }

    for (const task of waitingHumanSnapshot) {
      if (terminalParkedIds.has(task.task_id)) continue;
      try {
        const taskResults = await processWaitingHumanTask(deps, task, linearSyncs);
        for (const r of taskResults) results.push(r);
      } catch (err) {
        results.push(recordTickError(deps, task.task_id, err));
      }
    }

    if (options.reviewerEnabled === true) {
      // Reap any review-only attempts that were marked ended + kill_intent
      // but whose tmux session is still alive. enterReview sets kill_intent
      // before COMMIT and kills the session after; a crash in between would
      // otherwise leave the worker running. Idempotent: a dead session is a
      // no-op.
      reapAbandonedReviewers(deps);

      // Mirror the precedent in processPrOpenTask / processDoneTask: poll PR
      // state once per pr-review task before iterating review attempts. A
      // merge / close by a human (or any external actor) while we're in
      // pr-review must short-circuit to the terminal state instead of
      // respawning a reviewer pane onto an already-closed PR.
      const prReviewSnapshot = readPrReview(deps.db).filter(
        (t) =>
          !cancelledIds.has(t.task_id) &&
          !syntheticReviewLifecycleIds.has(t.task_id),
      );
      const terminalReviewIds = new Set<string>();
      for (const task of prReviewSnapshot) {
        if (
          !shouldPollLowPriorityPr(
            task.github_pr_polled_at,
            nowISO,
            DEFAULT_LOW_PRIORITY_PR_POLL_INTERVAL_MINUTES,
          )
        ) {
          continue;
        }
        const skipped = githubBackoffSkipResult(githubBackoff, task.task_id);
        if (skipped !== null) {
          results.push(skipped);
          terminalReviewIds.add(task.task_id);
          continue;
        }
        try {
          const result = processPrReviewTerminal(deps, task);
          if (result !== null) {
            results.push(result);
            terminalReviewIds.add(task.task_id);
          }
        } catch (err) {
          results.push(
            recordTickErrorWithGithubBackoff(
              deps,
              githubBackoff,
              task.task_id,
              err,
              task.repo_id,
            ),
          );
        }
      }

      for (const task of runningReviewSnapshot) {
        if (syntheticReviewAttemptSkipIds.has(task.task_id)) continue;
        if (terminalReviewIds.has(task.task_id)) continue;
        const skipped = githubBackoffSkipResult(githubBackoff, task.task_id);
        if (skipped !== null) {
          results.push(skipped);
          continue;
        }
        try {
          const result = processRunningReviewAttempt(deps, task, options);
          if (result !== null) results.push(result);
        } catch (err) {
          results.push(
            recordTickErrorWithGithubBackoff(
              deps,
              githubBackoff,
              task.task_id,
              err,
              task.repo_id,
            ),
          );
        }
      }

      const reviewCap =
        options.maxConcurrentReviewers ?? DEFAULT_MAX_CONCURRENT_REVIEWERS;
      let reviewerRunningCount = countRunningReviewers(deps.db);
      for (const task of pendingReviewSnapshot) {
        if (syntheticReviewAttemptSkipIds.has(task.task_id)) continue;
        if (terminalReviewIds.has(task.task_id)) continue;
        if (reviewerRunningCount >= reviewCap) {
          results.push({ task_id: task.task_id, action: "skipped_capacity" });
          continue;
        }
        try {
          results.push(promoteAndSpawnReviewer(deps, task, agentResolver, options));
        } catch (err) {
          results.push(
            recordTickErrorWithGithubBackoff(
              deps,
              githubBackoff,
              task.task_id,
              err,
              task.repo_id,
            ),
          );
        }
        reviewerRunningCount = countRunningReviewers(deps.db);
      }
    }

    let runningCount = countRunning(deps.db);
    for (const task of queuedSnapshot) {
      if (runningCount >= max) {
        results.push({ task_id: task.task_id, action: "skipped_capacity" });
        continue;
      }
      const skipped = githubBackoffSkipResult(githubBackoff, task.task_id);
      if (skipped !== null) {
        results.push(skipped);
        continue;
      }
      try {
        results.push(
          promoteAndSpawn(deps, task, agentResolver, linearSyncs, options),
        );
      } catch (err) {
        results.push(
          recordTickErrorWithGithubBackoff(
            deps,
            githubBackoff,
            task.task_id,
            err,
            task.repo_id,
          ),
        );
      }
      // Re-read running count from the DB so terminal/non-promotion outcomes
      // don't drift the cap.
      runningCount = countRunning(deps.db);
    }

    return results;
  });
  // Drain Linear writebacks outside the supervisor lock so the network
  // round-trips do not extend the lock-held window. Still awaited before
  // tick_once returns so tests observe the writebacks deterministically.
  await linearSyncs.drain();
  return attempt.acquired ? attempt.value : [];
}

function readPendingReviewRequests(db: DB): PendingReviewRequestRow[] {
  return db
    .query<PendingReviewRequestRow, []>(
      `SELECT rr.request_id, rr.task_id, rr.repo_id, rr.pr_number
         FROM review_requests rr
         JOIN tasks t ON t.task_id = rr.task_id
        WHERE rr.status = 'pending_ci'
          AND t.cancel_requested_at IS NULL
          AND t.state NOT IN (
            'merged_to_feature_branch',
            'merged',
            'closed_unmerged',
            'cancelled'
          )
        ORDER BY rr.created_at ASC, rr.request_id ASC`,
    )
    .all();
}

function processPendingReviewRequest(
  deps: TickDeps,
  req: PendingReviewRequestRow,
  options: TickOptions,
): TickTaskResult | null {
  markGithubPrPolled(deps, req.task_id);
  const snapshot = deps.github.prLightweightSnapshotByNumber(
    req.repo_id,
    req.pr_number,
  );
  if (snapshot === null) return null;
  if (snapshot.state === "merged" || snapshot.state === "closed_unmerged") {
    deps.db
      .query(
        `UPDATE review_requests
            SET status = 'discarded_terminal',
                terminal_state = ?,
                updated_at = ?
          WHERE request_id = ?
            AND status = 'pending_ci'`,
      )
      .run(snapshot.state, deps.clock.nowISO(), req.request_id);
    return null;
  }

  const result = enterReview(
    {
      db: deps.db,
      clock: deps.clock,
      github: deps.github,
      artifactStore: deps.artifactStore,
      tmux: deps.tmux,
    },
    {
      repoId: req.repo_id,
      prNumber: req.pr_number,
      headSha: snapshot.headSha,
      reviewerEnabled: true,
      gateQuayOwnedDone: true,
      referenceReposRoot: deps.referenceReposRoot,
      ciIgnorePolicy: options.ciIgnorePolicy,
    },
  );
  if (result.scheduled) {
    return { task_id: req.task_id, action: "review_requested" };
  }
  return null;
}

interface CancelTargetRow {
  task_id: string;
}

interface RetainedCancelledWorktreeGcRow {
  task_id: string;
  worktree_path: string;
}

function retainedCancelledWorktreeGcCutoff(nowISO: string): string {
  const now = new Date(nowISO).getTime();
  return new Date(
    now -
      DEFAULT_RETAINED_CANCELLED_WORKTREE_RETENTION_HOURS * 60 * 60 * 1000,
  ).toISOString();
}

function readRetainedCancelledWorktreeGcCandidates(
  db: DB,
  cutoffISO: string,
  limit: number,
): RetainedCancelledWorktreeGcRow[] {
  return db
    .query<RetainedCancelledWorktreeGcRow, [string, number]>(
      `SELECT task_id, worktree_path
         FROM tasks
        WHERE state = 'cancelled'
          AND cancel_keep_worktree = 1
          AND worktree_cleaned_at IS NULL
          AND COALESCE(cancel_requested_at, updated_at) <= ?
        ORDER BY COALESCE(cancel_requested_at, updated_at), task_id
        LIMIT ?`,
    )
    .all(cutoffISO, limit);
}

function cleanupRetainedCancelledWorktree(
  deps: TickDeps,
  task: RetainedCancelledWorktreeGcRow,
): void {
  if (existsSync(task.worktree_path)) {
    deps.git.worktreeRemove(task.worktree_path);
    if (existsSync(task.worktree_path)) {
      throw new Error(
        `retained cancelled worktree cleanup did not remove ${task.worktree_path}`,
      );
    }
  }

  const now = deps.clock.nowISO();
  deps.db.exec("BEGIN");
  try {
    deps.db
      .query(
        `UPDATE tasks
            SET worktree_cleaned_at = ?,
                tick_error = NULL,
                updated_at = ?
          WHERE task_id = ?
            AND state = 'cancelled'
            AND cancel_keep_worktree = 1
            AND worktree_cleaned_at IS NULL`,
      )
      .run(now, now, task.task_id);
    deps.db
      .query(
        `INSERT INTO events (task_id, event_type, occurred_at)
         VALUES (?, 'retained_worktree_cleaned', ?)`,
      )
      .run(task.task_id, now);
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

function readCancelTargets(db: DB): CancelTargetRow[] {
  return db
    .query<CancelTargetRow, []>(
      `SELECT task_id FROM tasks
        WHERE cancel_requested_at IS NOT NULL
          AND state NOT IN (
            'cancelled',
            'merged_to_feature_branch',
            'merged',
            'closed_unmerged'
          )
        ORDER BY task_id`,
    )
    .all();
}

function readQueued(db: DB): QueuedTaskRow[] {
  return db
    .query<QueuedTaskRow, []>(
      `SELECT t.task_id, t.repo_id, t.branch_name,
              COALESCE(t.base_branch, r.base_branch) AS base_branch,
              t.tmux_id, t.worktree_path,
              t.cancel_requested_at, t.external_ref, t.worker_agent, t.worker_model,
              t.worker_execution
         FROM tasks t JOIN repos r ON r.repo_id = t.repo_id
        WHERE t.state = 'queued'
        ORDER BY t.created_at, t.task_id`,
    )
    .all();
}

function readRunning(db: DB): RunningTaskRow[] {
  return db
    .query<RunningTaskRow, []>(
      `SELECT t.task_id, t.repo_id, t.branch_name,
              COALESCE(t.base_branch, r.base_branch) AS base_branch,
              t.tmux_id, t.worktree_path,
              t.pr_number, t.cancel_requested_at, t.worker_execution
         FROM tasks t JOIN repos r ON r.repo_id = t.repo_id
        WHERE t.state = 'running'
        ORDER BY t.created_at, t.task_id`,
    )
    .all();
}

function readGoalCompletionPending(db: DB): GoalCompletionPendingTask[] {
  return db
    .query<GoalCompletionPendingTask, []>(
      `SELECT task_id, repo_id, branch_name, worktree_path, cancel_requested_at
         FROM tasks
        WHERE state = 'goal-completion-pending'
        ORDER BY created_at, task_id`,
    )
    .all();
}

function readClaimed(db: DB): ClaimedTaskRow[] {
  return db
    .query<ClaimedTaskRow, []>(
      `SELECT task_id, claimed_at, claim_id,
              claim_expirations_consecutive, cancel_requested_at
         FROM tasks
        WHERE state = 'claimed-by-orchestrator'
        ORDER BY claimed_at, task_id`,
    )
    .all();
}

interface WaitingHumanTaskRow {
  task_id: string;
  slack_thread_ref: string | null;
  claim_id: string | null;
  cancel_requested_at: string | null;
  authors_json: string | null;
  external_ref: string | null;
}

function readWaitingHuman(db: DB): WaitingHumanTaskRow[] {
  return db
    .query<WaitingHumanTaskRow, []>(
      `SELECT task_id, slack_thread_ref, claim_id, cancel_requested_at,
              authors_json, external_ref
         FROM tasks
        WHERE state = 'waiting_human'
        ORDER BY created_at, task_id`,
    )
    .all();
}

function readPrOpen(db: DB): PrOpenTaskRow[] {
  return db
    .query<PrOpenTaskRow, []>(
      `SELECT task_id, repo_id, branch_name, worktree_path,
              CASE
                WHEN authoring_mode = 'quay_owned'
                 AND task_id LIKE 'pr-review-%'
                THEN 'synthetic_review'
                ELSE authoring_mode
              END AS authoring_mode,
              cancel_requested_at, last_review_id_acted_on,
              last_conflict_observation, github_pr_polled_at
         FROM tasks
        WHERE state = 'pr-open'
        ORDER BY created_at, task_id`,
    )
    .all();
}

function readDone(db: DB): DoneTaskRow[] {
  return db
    .query<DoneTaskRow, []>(
      `SELECT task_id, repo_id, branch_name, worktree_path,
              CASE
                WHEN authoring_mode = 'quay_owned'
                 AND task_id LIKE 'pr-review-%'
                THEN 'synthetic_review'
                ELSE authoring_mode
              END AS authoring_mode,
              pr_number, cancel_requested_at, last_review_id_acted_on,
              last_conflict_observation, github_pr_polled_at
         FROM tasks
        WHERE state = 'done'
        ORDER BY created_at, task_id`,
    )
    .all();
}

function readReadyUmbrellaFinalPrWorkflows(
  db: DB,
): ReadyUmbrellaFinalPrWorkflowRow[] {
  return db
    .query<ReadyUmbrellaFinalPrWorkflowRow, []>(
      `SELECT uw.umbrella_workflow_id, uw.external_ref, uw.repo_id,
              uw.base_branch, uw.feature_branch, uw.linear_issue_title,
              uw.linear_issue_url, uw.final_pr_task_id, uw.final_pr_number,
              uw.final_pr_url
         FROM umbrella_workflows uw
        WHERE uw.state = 'active'
          AND (
               uw.final_pr_task_id IS NULL
            OR uw.final_pr_number IS NULL
          )
          AND EXISTS (
            SELECT 1
              FROM umbrella_expected_tasks uet
             WHERE uet.umbrella_workflow_id = uw.umbrella_workflow_id
          )
          AND NOT EXISTS (
            SELECT 1
              FROM umbrella_expected_tasks uet
              LEFT JOIN umbrella_tasks ut
                ON ut.umbrella_workflow_id = uet.umbrella_workflow_id
               AND ut.external_ref = uet.external_ref
              LEFT JOIN tasks t
                ON t.task_id = ut.task_id
             WHERE uet.umbrella_workflow_id = uw.umbrella_workflow_id
               AND NOT (
                    uet.state = 'complete_without_quay'
                 OR (
                      ut.task_id IS NOT NULL
                  AND t.state = 'merged_to_feature_branch'
                 )
               )
          )
        ORDER BY uw.created_at, uw.umbrella_workflow_id`,
    )
    .all();
}

function readSyntheticReviewLifecycle(
  db: DB,
): SyntheticReviewLifecycleTaskRow[] {
  return db
    .query<SyntheticReviewLifecycleTaskRow, []>(
      `SELECT task_id, repo_id, state, branch_name, worktree_path,
              CASE
                WHEN authoring_mode = 'quay_owned'
                 AND task_id LIKE 'pr-review-%'
                THEN 'synthetic_review'
                ELSE authoring_mode
              END AS authoring_mode,
              pr_number, cancel_requested_at, github_pr_polled_at
         FROM tasks
        WHERE (
              authoring_mode = 'synthetic_review'
           OR (authoring_mode = 'quay_owned' AND task_id LIKE 'pr-review-%')
        )
          AND state IN ('pr-review', 'done', 'waiting_external_changes')
        ORDER BY created_at, task_id`,
    )
    .all();
}

function readPrReview(db: DB): PrReviewTaskRow[] {
  return db
    .query<PrReviewTaskRow, []>(
      `SELECT task_id, repo_id, branch_name, worktree_path,
              CASE
                WHEN authoring_mode = 'quay_owned'
                 AND task_id LIKE 'pr-review-%'
                THEN 'synthetic_review'
                ELSE authoring_mode
              END AS authoring_mode,
              pr_number, cancel_requested_at, github_pr_polled_at
         FROM tasks
        WHERE state = 'pr-review'
        ORDER BY created_at, task_id`,
    )
    .all();
}

function readClosedUnmergedCandidates(
  db: DB,
): ClosedUnmergedCandidateRow[] {
  return db
    .query<ClosedUnmergedCandidateRow, []>(
      `SELECT task_id, repo_id, state, branch_name, tmux_id,
              CASE
                WHEN authoring_mode = 'quay_owned'
                 AND task_id LIKE 'pr-review-%'
                THEN 'synthetic_review'
                ELSE authoring_mode
              END AS authoring_mode,
              worktree_path, pr_number
         FROM tasks
        WHERE state IN ('queued', 'running')
          AND pr_number IS NOT NULL
          AND cancel_requested_at IS NULL
        ORDER BY task_id`,
    )
    .all();
}

function readParkedPrTerminal(db: DB): ParkedPrTerminalTaskRow[] {
  return db
    .query<ParkedPrTerminalTaskRow, []>(
      `SELECT task_id, repo_id, state, branch_name, worktree_path,
              CASE
                WHEN authoring_mode = 'quay_owned'
                 AND task_id LIKE 'pr-review-%'
                THEN 'synthetic_review'
                ELSE authoring_mode
              END AS authoring_mode,
              pr_number, head_sha, cancel_requested_at, github_pr_polled_at
         FROM tasks
        WHERE state IN (
          'awaiting-next-brief',
          'claimed-by-orchestrator',
          'waiting_human',
          'non_budget_loop',
          'worktree_error',
          'orchestrator_loop'
        )
        ORDER BY created_at, task_id`,
    )
    .all();
}

function readRunningReviewAttempts(db: DB): ReviewAttemptTaskRow[] {
  return db
    .query<ReviewAttemptTaskRow, []>(
      `SELECT t.task_id, t.repo_id, t.branch_name, t.tmux_id, t.worktree_path,
              CASE
                WHEN t.authoring_mode = 'quay_owned'
                 AND t.task_id LIKE 'pr-review-%'
                THEN 'synthetic_review'
                ELSE t.authoring_mode
              END AS authoring_mode,
              t.pr_number, t.cancel_requested_at,
              t.review_infra_failures_consecutive,
              t.review_infra_failure_head_sha,
              a.attempt_id, a.attempt_number, a.preamble_id, a.head_sha,
              a.tmux_session, a.spawned_at, a.kill_intent,
              t.reviewer_agent, t.reviewer_model
         FROM attempts a
         JOIN tasks t ON t.task_id = a.task_id
        WHERE t.state = 'pr-review'
          AND a.reason = 'review_only'
          AND a.spawned_at IS NOT NULL
          AND a.ended_at IS NULL
        ORDER BY a.attempt_id`,
    )
    .all();
}

function readPendingReviewAttempts(db: DB): ReviewAttemptTaskRow[] {
  return db
    .query<ReviewAttemptTaskRow, []>(
      `SELECT t.task_id, t.repo_id, t.branch_name, t.tmux_id, t.worktree_path,
              CASE
                WHEN t.authoring_mode = 'quay_owned'
                 AND t.task_id LIKE 'pr-review-%'
                THEN 'synthetic_review'
                ELSE t.authoring_mode
              END AS authoring_mode,
              t.pr_number, t.cancel_requested_at,
              t.review_infra_failures_consecutive,
              t.review_infra_failure_head_sha,
              a.attempt_id, a.attempt_number, a.preamble_id, a.head_sha,
              a.tmux_session, a.spawned_at, a.kill_intent,
              t.reviewer_agent, t.reviewer_model
         FROM attempts a
         JOIN tasks t ON t.task_id = a.task_id
        WHERE t.state = 'pr-review'
          AND a.reason = 'review_only'
          AND a.spawned_at IS NULL
          AND a.ended_at IS NULL
        ORDER BY a.attempt_id`,
    )
    .all();
}

function loadCurrentAttempt(db: DB, taskId: string): CurrentAttemptRow | null {
  return (
    db
      .query<CurrentAttemptRow, [string]>(
        `SELECT attempt_id, attempt_number, preamble_id,
                template_id, reason, consumed_budget,
                remote_sha_at_spawn, pr_existed_at_spawn, tmux_session,
                spawned_at, kill_intent, goal_id, goal_report_processed_at
           FROM attempts
          WHERE task_id = ? AND spawned_at IS NOT NULL
          ORDER BY attempt_id DESC
          LIMIT 1`,
      )
      .get(taskId) ?? null
  );
}

function processRunningTask(
  deps: TickDeps,
  task: RunningTaskRow,
  options: TickOptions,
  githubBackoff: GithubBackoffState,
): TickTaskResult | null {
  // Cancel intent is the slice-7 finalizer's responsibility; skip cleanly.
  if (task.cancel_requested_at !== null) return null;

  const attempt = loadCurrentAttempt(deps.db, task.task_id);
  if (!attempt) return null;

  const ctxTask: ClassifyContextTask = {
    task_id: task.task_id,
    repo_id: task.repo_id,
    branch_name: task.branch_name,
    base_branch: task.base_branch,
    pr_number: task.pr_number,
    tmux_id: task.tmux_id,
    worktree_path: task.worktree_path,
    state: "running",
    worker_execution: task.worker_execution,
  };
  const ctxAttempt: ClassifyContextAttempt = {
    attempt_id: attempt.attempt_id,
    attempt_number: attempt.attempt_number,
    preamble_id: attempt.preamble_id,
    reason: attempt.reason,
    remote_sha_at_spawn: attempt.remote_sha_at_spawn,
    pr_existed_at_spawn: attempt.pr_existed_at_spawn,
    tmux_session: attempt.tmux_session,
    spawned_at: attempt.spawned_at,
    goal_id: attempt.goal_id,
    goal_report_processed_at: attempt.goal_report_processed_at,
  };

  if (attempt.tmux_session === null) {
    // Spawn-window recovery: kill any orphan tmux session matching the
    // canonical name (idempotent — missing session is OK), then run the
    // same evidence classifier. No worker process ever started in this
    // window, so there's no OS-level exit to capture — pass NONE.
    const canonical = `quay-task-${task.tmux_id}-${attempt.attempt_number}`;
    try {
      deps.tmux.kill(canonical);
    } catch {}
    const skipped = githubBackoffSkipResult(githubBackoff, task.task_id);
    if (skipped !== null) return skipped;
    const res = classifyAndApply(deps, ctxTask, ctxAttempt, {
      sessionName: canonical,
      spawnWindow: true,
      exitInfo: EXIT_INFO_NONE,
    });
    if (res.outcome === "spawn_window_no_evidence") {
      return handleSpawnFailure(deps, task, attempt, options);
    }
    return outcomeToResult(task.task_id, res.outcome, true);
  }

  if (deps.tmux.isAlive(attempt.tmux_session)) {
    if (attempt.kill_intent !== null) {
      deps.tmux.kill(attempt.tmux_session);
      return { task_id: task.task_id, action: "kill_intent_set" };
    }
    const intent = detectKillIntent(deps, task, attempt, options);
    if (intent !== null) {
      setKillIntent(deps, task, attempt, intent);
      fireFailpoint("after_kill_intent_commit");
      deps.tmux.kill(attempt.tmux_session);
      return { task_id: task.task_id, action: "kill_intent_set" };
    }
    return null;
  }

  // Worker pane is dead. Capture the OS-level exit observation once, here,
  // before classifier cleanup deletes the marker file the wrapper wrote
  // into the worktree. The captured pair is stamped onto the attempts
  // row by whichever terminal path runs next.
  const exitInfo = readExitInfo(deps, attempt.tmux_session, task.worktree_path);

  if (attempt.kill_intent === "wall_clock" || attempt.kill_intent === "stale") {
    const retryReason: BudgetRetryReason = attempt.kill_intent;
    finalizeKillIntent(deps, task, attempt, retryReason, exitInfo);
    return {
      task_id: task.task_id,
      action: retryReason === "wall_clock" ? "wall_clock_killed" : "stale_killed",
    };
  }

  const skipped = githubBackoffSkipResult(githubBackoff, task.task_id);
  if (skipped !== null) return skipped;

  const res = classifyAndApply(
    { ...deps, artifactStore: deps.artifactStore },
    ctxTask,
    ctxAttempt,
    { sessionName: attempt.tmux_session, spawnWindow: false, exitInfo },
  );
  return outcomeToResult(task.task_id, res.outcome, false);
}

function processRunningReviewAttempt(
  deps: TickDeps,
  task: ReviewAttemptTaskRow,
  options: TickOptions,
): TickTaskResult | null {
  if (task.cancel_requested_at !== null) return null;
  if (task.tmux_session === null) {
    return markReviewInfraFailure(
      deps,
      task,
      "reviewer spawn did not record a tmux session",
      EXIT_INFO_NONE,
      options,
    );
  }
  if (deps.tmux.isAlive(task.tmux_session)) {
    if (task.kill_intent !== null) {
      deps.tmux.kill(task.tmux_session);
      return { task_id: task.task_id, action: "kill_intent_set" };
    }
    const intent = detectKillIntent(deps, task, task, options);
    if (intent !== null) {
      setKillIntent(deps, task, task, intent);
      fireFailpoint("after_kill_intent_commit");
      deps.tmux.kill(task.tmux_session);
      return { task_id: task.task_id, action: "kill_intent_set" };
    }
    return null;
  }

  const exitInfo = readExitInfo(deps, task.tmux_session, task.worktree_path);
  if (task.kill_intent === "wall_clock" || task.kill_intent === "stale") {
    return markReviewInfraFailure(
      deps,
      task,
      reviewKillIntentDiagnostic(task.kill_intent),
      exitInfo,
      options,
    );
  }

  const blockerPath = join(task.worktree_path, ".quay-blocked.md");
  if (existsSync(blockerPath)) {
    let blocker = "";
    try {
      blocker = readFileSync(blockerPath, "utf8");
    } catch (err) {
      blocker = `Unable to read reviewer blocker file: ${(err as Error).message}`;
    }
    try {
      rmSync(blockerPath, { force: true });
    } catch {}
    // markReviewInfraFailure persists the blocker as a review_blocker
    // artifact inside its txn. A second write here would collide on the
    // (task_id, attempt_id, kind, content_hash) unique index and roll
    // the whole transition back, leaving the task stuck on tick_error.
    return markReviewInfraFailure(deps, task, blocker, exitInfo, options);
  }

  if (task.pr_number === null) {
    return markReviewInfraFailure(
      deps,
      task,
      "review task has no pr_number",
      exitInfo,
      options,
    );
  }

  const resultRead = readReviewResultFile(task.worktree_path);
  if (!resultRead.ok) {
    return markReviewInfraFailure(
      deps,
      task,
      resultRead.diagnostic,
      exitInfo,
      options,
      resultRead.raw,
    );
  }

  const token = resolveGithubActorToken("reviewer", deps, task.repo_id, options);
  if (!token.ok) {
    return markReviewInfraFailure(deps, task, token.error, exitInfo, options);
  }

  let posted: PostedReview;
  try {
    posted = deps.github.submitPullRequestReview({
      repoId: task.repo_id,
      prNumber: task.pr_number,
      headSha: task.head_sha,
      verdict:
        resultRead.result.verdict === "approved"
          ? "APPROVED"
          : "CHANGES_REQUESTED",
      body: resultRead.result.body,
      token: token.token,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return markReviewInfraFailure(
      deps,
      task,
      `failed to post GitHub review: ${message}`,
      exitInfo,
      options,
      resultRead.result.raw,
    );
  }

  if (posted.decision === "COMMENTED") {
    return markReviewInfraFailure(
      deps,
      task,
      `review ${posted.reviewId} used COMMENTED instead of an approve/request-changes verdict`,
      exitInfo,
      options,
      resultRead.result.raw,
    );
  }
  if (
    posted.decision === "APPROVED" &&
    task.authoring_mode !== "synthetic_review"
  ) {
    const ciGate = guardApprovedReviewCi(
      deps,
      task,
      posted,
      exitInfo,
      options,
      resultRead.result.raw,
    );
    if (ciGate !== null) return ciGate;
  }
  return finalizePostedReview(
    deps,
    task,
    posted,
    exitInfo,
    options,
    resultRead.result.raw,
  );
}

function reviewKillIntentDiagnostic(intent: "wall_clock" | "stale"): string {
  return intent === "wall_clock"
    ? "The live reviewer exceeded max_attempt_duration_seconds and was killed."
    : "The live reviewer stopped producing fresh logs past staleness_threshold_seconds and was killed.";
}

function readReviewResultFile(worktreePath: string): ReviewResultRead {
  const resultPath = join(worktreePath, REVIEW_RESULT_FILENAME);
  if (!existsSync(resultPath)) {
    return {
      ok: false,
      diagnostic: `reviewer did not write ${REVIEW_RESULT_FILENAME}`,
    };
  }

  let raw: string;
  try {
    raw = readFileSync(resultPath, "utf8");
  } catch (err) {
    return {
      ok: false,
      diagnostic: `unable to read ${REVIEW_RESULT_FILENAME}: ${(err as Error).message}`,
    };
  } finally {
    try {
      rmSync(resultPath, { force: true });
    } catch {}
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      diagnostic: `${REVIEW_RESULT_FILENAME} is not valid JSON: ${(err as Error).message}`,
      raw,
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      diagnostic: `${REVIEW_RESULT_FILENAME} must contain a JSON object`,
      raw,
    };
  }

  const obj = parsed as Record<string, unknown>;
  const verdict = obj.verdict;
  const body = obj.body;
  const findings = obj.findings;
  const errors: string[] = [];
  if (verdict !== "approved" && verdict !== "changes_requested") {
    errors.push("verdict must be approved or changes_requested");
  }
  if (typeof body !== "string" || body.trim() === "") {
    errors.push("body must be a non-empty string");
  }
  if (!Array.isArray(findings)) {
    errors.push("findings must be an array");
  }
  if (errors.length > 0) {
    return {
      ok: false,
      diagnostic: `${REVIEW_RESULT_FILENAME} is malformed: ${errors.join("; ")}`,
      raw,
    };
  }

  return {
    ok: true,
    result: {
      verdict: verdict as "approved" | "changes_requested",
      body: body as string,
      findings: findings as unknown[],
      raw,
    },
  };
}

// Worker exit info is best-effort: a missing marker file (worker exec'd
// itself, was killed before the wrapper's printf ran) should never block
// the dead-worker path. EXIT_INFO_NONE leaves both columns NULL, which
// is indistinguishable from a pre-migration row for downstream consumers.
function readExitInfo(
  deps: TickDeps,
  sessionName: string,
  worktreePath: string,
): PaneExitInfo {
  try {
    return deps.tmux.getExitInfo(sessionName, worktreePath);
  } catch {
    return EXIT_INFO_NONE;
  }
}

function outcomeToResult(
  taskId: string,
  outcome: ClassifyOutcome,
  spawnWindow: boolean,
): TickTaskResult | null {
  switch (outcome) {
    case "blocker_written":
      return {
        task_id: taskId,
        action: spawnWindow ? "spawn_window_recovered" : "blocker_ingested",
      };
    case "goal_continuation_scheduled":
      return { task_id: taskId, action: "goal_continuation_scheduled" };
    case "goal_completion_pending":
      return { task_id: taskId, action: "goal_completion_pending" };
    case "goal_budget_limited":
      return { task_id: taskId, action: "goal_budget_limited" };
    case "goal_report_processed":
      return null;
    case "malformed_signal":
      return { task_id: taskId, action: "malformed_signal" };
    case "pr_opened":
      return { task_id: taskId, action: "pr_opened" };
    case "existing_pr_attached":
      return { task_id: taskId, action: "existing_pr_attached" };
    case "adopted_pr_ready_for_review":
      return { task_id: taskId, action: "existing_pr_attached" };
    case "no_progress":
      return { task_id: taskId, action: "no_progress" };
    case "crashed":
      return { task_id: taskId, action: "crashed" };
    case "spawn_window_no_evidence":
      return null;
  }
}

function processPrOpenTask(
  deps: TickDeps,
  task: PrOpenTaskRow,
  options: TickOptions,
): TickTaskResult | null {
  if (task.cancel_requested_at !== null) return null;
  const attempt = loadLatestAttempt(deps.db, task.task_id);
  if (!attempt) return null;

  markGithubPrPolled(deps, task.task_id);
  const snapshot = deps.github.prSnapshot(task.repo_id, task.branch_name);
  if (snapshot === null) {
    return recordTickError(
      deps,
      task.task_id,
      new Error(
        `PR snapshot unavailable for branch ${task.branch_name}; tick will retry next cycle`,
      ),
    );
  }

  // Persist the PR's identifying metadata (number, url, head/base SHAs) onto
  // the task row before downstream branches can short-circuit (terminal
  // state, conflict, CI). The CLI/operator surface reads these columns; if
  // we wait until after CI passes we miss the entire pr-open window.
  persistPrMetadata(deps, task.task_id, snapshot);

  // 1. Terminal PR state (merged / closed_unmerged) takes precedence over
  //    everything else — even pending CI. A human merging or closing the PR
  //    while CI is still running must convert to terminal cleanly (spec §5
  //    "pr-open polls PR state").
  if (snapshot.state === "merged" || snapshot.state === "closed_unmerged") {
    return finalizePrTerminal(deps, task, attempt, snapshot.state, "pr-open");
  }

  // 2. Merge conflict: schedule a non-budget conflict respawn unless the
  //    (head_sha:base_sha) pair matches the dedupe key.
  if (snapshot.mergeable === "conflicting") {
    const observation = formatConflictObservation(snapshot);
    if (task.last_conflict_observation !== observation) {
      return scheduleConflictNonBudget(
        deps,
        task.task_id,
        attempt,
        snapshot,
        observation,
        "pr-open",
        options,
      );
    }
  }

  // 3. CI status (any reported failure blocks; empty check set preserves no-CI).
  const repo = loadRepoForTask(deps.db, task.task_id);
  const ci = classifyCi(
    snapshot,
    repo?.ci_workflow_name ?? null,
    resolveCiIgnorePolicy(options.ciIgnorePolicy ?? EMPTY_CI_IGNORE_POLICY, repo),
  );

  if (ci === "stale") {
    return recordTickError(
      deps,
      task.task_id,
      new Error(
        `PR head SHA (${snapshot.headSha}) and check-run SHA (${snapshot.checks.checkSha}) disagree; skipping CI evaluation this tick`,
      ),
    );
  }
  if (ci === "pending") {
    clearTickError(deps, task.task_id);
    return { task_id: task.task_id, action: "ci_pending" };
  }
  if (ci === "pass") {
    if (options.reviewerEnabled === true && options.gateQuayOwnedDone === true) {
      if (snapshot.prNumber === undefined || snapshot.prNumber === null) {
        return recordTickError(
          deps,
          task.task_id,
          new Error(
            `PR snapshot for ${task.branch_name} did not include a PR number; cannot enter pr-review`,
          ),
        );
      }
      const result = enterReview(
        {
          db: deps.db,
          clock: deps.clock,
          github: deps.github,
          artifactStore: deps.artifactStore,
          tmux: deps.tmux,
        },
        {
          repoId: task.repo_id,
          prNumber: snapshot.prNumber,
          headSha: snapshot.headSha,
          reviewerEnabled: true,
          gateQuayOwnedDone: true,
          referenceReposRoot: deps.referenceReposRoot,
          ciIgnorePolicy: options.ciIgnorePolicy,
        },
      );
      if (
        result.skipped_reason === "terminal_verdict_exists" &&
        result.review_verdict === "approved"
      ) {
        return transitionCiPassed(deps, task, attempt);
      }
      return {
        task_id: task.task_id,
        action: result.scheduled ? "review_requested" : "skipped_predicate",
      };
    }
    return transitionCiPassed(deps, task, attempt);
  }
  return scheduleCiFailRetry(deps, task.task_id, attempt, snapshot, "pr-open");
}

function processDoneTask(
  deps: TickDeps,
  task: DoneTaskRow,
  options: TickOptions,
): TickTaskResult | null {
  if (task.cancel_requested_at !== null) return null;
  const attempt = loadLatestAttempt(deps.db, task.task_id);
  if (!attempt) return null;

  markGithubPrPolled(deps, task.task_id);
  const snapshot = deps.github.prSnapshot(task.repo_id, task.branch_name);
  if (snapshot === null) {
    return recordTickError(
      deps,
      task.task_id,
      new Error(
        `PR snapshot unavailable for branch ${task.branch_name}; tick will retry next cycle`,
      ),
    );
  }

  // Same writeback as the pr-open path: keep PR metadata current while we
  // poll for review feedback / merge state in the done branch.
  persistPrMetadata(deps, task.task_id, snapshot);

  // 1. Terminal PR state.
  if (snapshot.state === "merged" || snapshot.state === "closed_unmerged") {
    return finalizePrTerminal(deps, task, attempt, snapshot.state, "done");
  }

  // 2. PR-side worker respawn triggers. Evaluate all actionable observations
  // before scheduling so a conflict does not hide fresh review feedback.
  const conflictObservation =
    snapshot.mergeable === "conflicting"
      ? formatConflictObservation(snapshot)
      : null;
  const hasFreshConflict =
    conflictObservation !== null &&
    task.last_conflict_observation !== conflictObservation;
  const hasFreshReview = hasActionableReviewFeedback(task, snapshot);

  if (hasFreshConflict && hasFreshReview) {
    return scheduleConflictReviewNonBudget(
      deps,
      task.task_id,
      attempt,
      snapshot,
      conflictObservation!,
      "done",
      options,
    );
  }

  if (hasFreshConflict) {
    return scheduleConflictNonBudget(
      deps,
      task.task_id,
      attempt,
      snapshot,
      conflictObservation!,
      "done",
      options,
    );
  }

  if (hasFreshReview) {
    return scheduleReviewNonBudget(
      deps,
      task.task_id,
      attempt,
      snapshot,
      "done",
      options,
    );
  }

  const umbrellaIntegration = loadUmbrellaSubtaskIntegration(deps.db, task.task_id);
  if (umbrellaIntegration !== null) {
    return processUmbrellaSubtaskAutoMerge(
      deps,
      task,
      attempt,
      snapshot,
      umbrellaIntegration,
      options,
    );
  }

  clearTickError(deps, task.task_id);
  return null;
}

function reconcileUmbrellaFinalPr(
  deps: TickDeps,
  workflow: ReadyUmbrellaFinalPrWorkflowRow,
): TickTaskResult {
  requireUmbrellaFeatureBranchExists(deps, {
    repo_id: workflow.repo_id,
    external_ref: workflow.external_ref,
    base_branch: workflow.base_branch,
    feature_branch: workflow.feature_branch,
  });
  const subtasks = loadUmbrellaFinalPrExpectedSubtasks(
    deps.db,
    workflow.umbrella_workflow_id,
  );
  const title = renderUmbrellaFinalPrTitle(workflow);
  const managedSection = renderUmbrellaFinalPrManagedSection(workflow, subtasks);
  const existingPrs = deps.github.openPrsForBranchBase(
    workflow.repo_id,
    workflow.feature_branch,
    workflow.base_branch,
  );
  if (existingPrs.length > 1) {
    throw new Error(
      `umbrella final PR reconciliation found ${existingPrs.length} open PRs for ${workflow.feature_branch} -> ${workflow.base_branch}`,
    );
  }

  const pr =
    existingPrs[0] ??
    deps.github.createPullRequest({
      repoId: workflow.repo_id,
      headBranch: workflow.feature_branch,
      baseBranch: workflow.base_branch,
      title,
      body: managedSection,
    });

  if (existingPrs.length === 1) {
    const view = deps.github.prView(workflow.repo_id, pr.number);
    const nextBody = replaceUmbrellaFinalPrManagedSection(
      view?.body ?? "",
      managedSection,
    );
    if (view === null || view.body !== nextBody) {
      deps.github.updatePullRequestBody(workflow.repo_id, pr.number, nextBody);
    }
  }

  const taskId = ensureUmbrellaFinalPrTask(deps, workflow, pr, managedSection);
  deps.db
    .query(
      `UPDATE umbrella_workflows
          SET final_pr_task_id = ?,
              final_pr_number = ?,
              final_pr_url = COALESCE(?, final_pr_url),
              updated_at = ?
        WHERE umbrella_workflow_id = ?`,
    )
    .run(
      taskId,
      pr.number,
      pr.url,
      deps.clock.nowISO(),
      workflow.umbrella_workflow_id,
    );
  clearTickError(deps, taskId);
  return { task_id: taskId, action: "umbrella_final_pr_reconciled" };
}

function processUmbrellaSubtaskAutoMerge(
  deps: TickDeps,
  task: DoneTaskRow,
  attempt: CurrentAttemptRow,
  observedSnapshot: PrSnapshot,
  umbrella: UmbrellaSubtaskIntegrationRow,
  options: TickOptions,
): TickTaskResult | null {
  if (umbrella.final_pr_task_id === task.task_id) {
    return recordUmbrellaMergeGuardFailure(
      deps,
      task.task_id,
      "task is the umbrella final PR task; Quay may only auto-merge subtasks into the feature branch",
    );
  }

  const prNumber = task.pr_number ?? observedSnapshot.prNumber ?? null;
  if (prNumber === null) {
    return recordUmbrellaMergeGuardFailure(
      deps,
      task.task_id,
      `PR number is unavailable for branch ${task.branch_name}`,
    );
  }

  const liveView = deps.github.freshPrView(task.repo_id, prNumber);
  const liveSnapshot = deps.github.freshPrSnapshotByNumber(task.repo_id, prNumber);
  if (liveView === null || liveSnapshot === null) {
    return recordUmbrellaMergeGuardFailure(
      deps,
      task.task_id,
      `live PR #${prNumber} could not be read before guarded umbrella auto-merge`,
    );
  }
  persistPrMetadata(deps, task.task_id, liveSnapshot);

  if (liveSnapshot.state === "merged" || liveSnapshot.state === "closed_unmerged") {
    return finalizePrTerminal(deps, task, attempt, liveSnapshot.state, "done");
  }
  if (liveView.headRefName !== task.branch_name) {
    return recordUmbrellaMergeGuardFailure(
      deps,
      task.task_id,
      `PR #${prNumber} head branch ${liveView.headRefName || "<unknown>"} does not match subtask branch ${task.branch_name}`,
    );
  }
  if (liveView.isCrossRepository === true) {
    return recordUmbrellaMergeGuardFailure(
      deps,
      task.task_id,
      `PR #${prNumber} head branch is from a fork`,
    );
  }
  if (liveView.headSha !== "" && liveView.headSha !== liveSnapshot.headSha) {
    return recordUmbrellaMergeGuardFailure(
      deps,
      task.task_id,
      `PR #${prNumber} head SHA changed during guarded read (${liveView.headSha} -> ${liveSnapshot.headSha})`,
    );
  }
  if (
    liveView.baseRef !== umbrella.feature_branch ||
    liveSnapshot.baseRef !== umbrella.feature_branch
  ) {
    return recordUmbrellaMergeGuardFailure(
      deps,
      task.task_id,
      `PR #${prNumber} base branch ${liveView.baseRef ?? liveSnapshot.baseRef ?? "<unknown>"} does not exactly match umbrella feature branch ${umbrella.feature_branch}`,
    );
  }
  if (liveSnapshot.isDraft === true) {
    return recordUmbrellaMergeGuardFailure(
      deps,
      task.task_id,
      `PR #${prNumber} is still a draft`,
    );
  }
  if (liveSnapshot.mergeable === "conflicting") {
    ensureUmbrellaSubtaskBaseBranch(deps, task.task_id, umbrella.feature_branch);
    const observation = formatConflictObservation(liveSnapshot);
    if (task.last_conflict_observation !== observation) {
      return scheduleConflictNonBudget(
        deps,
        task.task_id,
        attempt,
        liveSnapshot,
        observation,
        "done",
        options,
      );
    }
    return recordUmbrellaMergeGuardFailure(
      deps,
      task.task_id,
      `PR #${prNumber} is not mergeable and the conflict observation has already been acted on`,
    );
  }
  if (liveSnapshot.mergeable !== "mergeable") {
    return recordUmbrellaMergeGuardFailure(
      deps,
      task.task_id,
      `PR #${prNumber} mergeable state is ${liveSnapshot.mergeable}`,
    );
  }

  const repo = loadRepoForTask(deps.db, task.task_id);
  const ci = classifyCi(
    liveSnapshot,
    repo?.ci_workflow_name ?? null,
    resolveCiIgnorePolicy(options.ciIgnorePolicy ?? EMPTY_CI_IGNORE_POLICY, repo),
  );
  if (ci === "stale") {
    return recordUmbrellaMergeGuardFailure(
      deps,
      task.task_id,
      `PR #${prNumber} head SHA (${liveSnapshot.headSha}) and check-run SHA (${liveSnapshot.checks.checkSha}) disagree`,
    );
  }
  if (ci !== "pass") {
    return recordUmbrellaMergeGuardFailure(
      deps,
      task.task_id,
      `PR #${prNumber} required CI is ${ci}`,
    );
  }
  if (
    liveSnapshot.latestReview.decision !== "APPROVED" ||
    liveSnapshot.latestReview.latestReviewId === null ||
    !reviewAppliesToHead(liveSnapshot)
  ) {
    return recordUmbrellaMergeGuardFailure(
      deps,
      task.task_id,
      `PR #${prNumber} latest applicable review is not approved`,
    );
  }

  try {
    deps.github.mergePullRequest(task.repo_id, prNumber, liveSnapshot.headSha);
  } catch (err) {
    if (err instanceof GitHubMergeError && err.kind === "not_mergeable") {
      ensureUmbrellaSubtaskBaseBranch(deps, task.task_id, umbrella.feature_branch);
      const conflictSnapshot: PrSnapshot = {
        ...liveSnapshot,
        mergeable: "conflicting",
      };
      const observation = formatConflictObservation(conflictSnapshot);
      if (task.last_conflict_observation !== observation) {
        return scheduleConflictNonBudget(
          deps,
          task.task_id,
          attempt,
          conflictSnapshot,
          observation,
          "done",
          options,
        );
      }
    }
    throw err;
  }

  return finalizePrTerminal(deps, task, attempt, "merged", "done");
}

function reviewAppliesToHead(snapshot: PrSnapshot): boolean {
  return (
    snapshot.latestReview.submittedHeadSha === undefined ||
    snapshot.latestReview.submittedHeadSha === null ||
    snapshot.latestReview.submittedHeadSha === snapshot.headSha
  );
}

function recordUmbrellaMergeGuardFailure(
  deps: TickDeps,
  taskId: string,
  reason: string,
): TickTaskResult {
  return recordTickError(
    deps,
    taskId,
    new Error(`umbrella auto-merge guard failed: ${reason}`),
  );
}

function ensureUmbrellaSubtaskBaseBranch(
  deps: TickDeps,
  taskId: string,
  featureBranch: string,
): void {
  deps.db
    .query(
      `UPDATE tasks
          SET base_branch = ?,
              updated_at = ?
        WHERE task_id = ?
          AND (base_branch IS NULL OR base_branch <> ?)`,
    )
    .run(featureBranch, deps.clock.nowISO(), taskId, featureBranch);
}

function processSyntheticReviewLifecycle(
  deps: TickDeps,
  task: SyntheticReviewLifecycleTaskRow,
  options: TickOptions,
): TickTaskResult | null {
  if (task.cancel_requested_at !== null) return null;
  if (task.pr_number === null) {
    return recordTickError(
      deps,
      task.task_id,
      new Error("synthetic review task has no pr_number"),
    );
  }

  const attempt = loadLatestAttempt(deps.db, task.task_id);
  if (!attempt) return null;

  markGithubPrPolled(deps, task.task_id);
  const snapshot = deps.github.prLightweightSnapshotByNumber(
    task.repo_id,
    task.pr_number,
  );
  if (snapshot === null) return null;
  persistPrMetadata(deps, task.task_id, snapshot);

  if (snapshot.state === "merged" || snapshot.state === "closed_unmerged") {
    return finalizePrTerminal(deps, task, attempt, snapshot.state, task.state);
  }

  if (options.reviewerEnabled !== true) {
    clearTickError(deps, task.task_id);
    return null;
  }

  const result = enterReview(
    {
      db: deps.db,
      clock: deps.clock,
      github: deps.github,
      artifactStore: deps.artifactStore,
      tmux: deps.tmux,
    },
    {
      repoId: task.repo_id,
      prNumber: task.pr_number,
      headSha: snapshot.headSha,
      reviewerEnabled: true,
      gateQuayOwnedDone: true,
      referenceReposRoot: deps.referenceReposRoot,
      ciIgnorePolicy: options.ciIgnorePolicy,
    },
  );

  if (!result.scheduled) {
    clearTickError(deps, task.task_id);
    return null;
  }

  return { task_id: task.task_id, action: "review_requested" };
}

interface PrTerminalRow {
  task_id: string;
  repo_id: string;
  authoring_mode?: TaskAuthoringMode;
  branch_name: string;
  worktree_path: string;
}

function processPrReviewTerminal(
  deps: TickDeps,
  task: PrReviewTaskRow,
): TickTaskResult | null {
  if (task.cancel_requested_at !== null) return null;
  const attempt = loadLatestAttempt(deps.db, task.task_id);
  if (!attempt) return null;

  // Unlike pr-open / done — which require a snapshot to decide everything —
  // pr-review only consults the snapshot for terminal short-circuit. A
  // missing snapshot must not block the review-attempt iteration; fall
  // through and let the next tick re-probe.
  //
  // Synthetic review tasks store `branch_name = quay-review/<num>` — an
  // internal placeholder that has no GitHub ref — so a branch-keyed
  // `prSnapshot` would always return null and miss the external merge /
  // close. For those, probe by PR number instead.
  markGithubPrPolled(deps, task.task_id);
  const snapshot =
    task.authoring_mode !== "quay_owned" && task.pr_number !== null
      ? deps.github.prLightweightSnapshotByNumber(task.repo_id, task.pr_number)
      : deps.github.prLightweightSnapshot(task.repo_id, task.branch_name);
  if (snapshot === null) return null;
  if (snapshot.state !== "merged" && snapshot.state !== "closed_unmerged") {
    return null;
  }
  return finalizePrTerminal(deps, task, attempt, snapshot.state, "pr-review");
}

function processClosedUnmergedQuayPr(
  deps: TickDeps,
  task: ClosedUnmergedCandidateRow,
): TickTaskResult | null {
  // Probe the specific PR Quay opened (pr_number), not the branch. A
  // human-opened replacement PR on the same branch would resolve via
  // `prSnapshot(branch)` and mask the original closure; addressing by
  // number keeps the invariant scoped to "the PR we own".
  markGithubPrPolled(deps, task.task_id);
  const snapshot = deps.github.prLightweightSnapshotByNumber(
    task.repo_id,
    task.pr_number,
  );
  if (snapshot === null) return null;
  if (snapshot.state !== "closed_unmerged") return null;

  const attempt = loadLatestAttempt(deps.db, task.task_id);
  if (!attempt) return null;

  // For a running task, kill the worker pane before the terminal commit so
  // it can't race the cleanup matrix by pushing a fresh commit and
  // `gh pr create`-ing a replacement PR. In the spawn-window state
  // (`tmux_session IS NULL`) the canonical session may still be alive but
  // the column hasn't been populated yet — fall back to the canonical name,
  // mirroring cancel.ts's killRunningTmux and processRunningTask's
  // spawn-window recovery. tmux.kill is idempotent on missing sessions, so
  // we issue it unconditionally rather than gating on isAlive.
  if (task.state === "running") {
    const session =
      attempt.tmux_session ??
      `quay-task-${task.tmux_id}-${attempt.attempt_number}`;
    try {
      deps.tmux.kill(session);
    } catch {}
  }

  return finalizePrTerminal(deps, task, attempt, "closed_unmerged", task.state);
}

function processParkedPrTerminal(
  deps: TickDeps,
  task: ParkedPrTerminalTaskRow,
): TickTaskResult | null {
  if (task.cancel_requested_at !== null) return null;
  const attempt = loadLatestAttempt(deps.db, task.task_id);
  if (!attempt) return null;

  markGithubPrPolled(deps, task.task_id);
  const snapshot = loadParkedPrSnapshot(deps, task);
  if (snapshot === null) return null;
  if (snapshot.state !== "merged" && snapshot.state !== "closed_unmerged") {
    const reconciled = reconcileParkedAdoptedOpenPr(deps, task, attempt);
    if (reconciled !== null) return reconciled;
    return null;
  }

  persistPrMetadata(deps, task.task_id, snapshot);
  return finalizePrTerminal(deps, task, attempt, snapshot.state, task.state);
}

function reconcileParkedAdoptedOpenPr(
  deps: TickDeps,
  task: ParkedPrTerminalTaskRow,
  attempt: CurrentAttemptRow,
): TickTaskResult | null {
  if (task.authoring_mode !== "adopted_external_pr") return null;
  if (
    task.state !== "awaiting-next-brief" &&
    task.state !== "claimed-by-orchestrator" &&
    task.state !== "waiting_human" &&
    task.state !== "orchestrator_loop"
  ) {
    return null;
  }
  const snapshot = loadParkedPrFullSnapshot(deps, task);
  if (snapshot === null) return null;
  if (snapshot.state !== "open") return null;
  if (task.head_sha !== null && snapshot.headSha === task.head_sha) return null;

  const repo = loadRepoForTask(deps.db, task.task_id);
  const ci = classifyCi(snapshot, repo?.ci_workflow_name ?? null);
  if (ci === "stale") {
    return recordTickError(
      deps,
      task.task_id,
      new Error(
        `PR head SHA (${snapshot.headSha}) and check-run SHA (${snapshot.checks.checkSha}) disagree; skipping adopted PR reconciliation this tick`,
      ),
    );
  }

  persistPrMetadata(deps, task.task_id, snapshot);

  if (snapshot.mergeable === "conflicting") {
    return transitionParkedAdoptedToPrOpen(deps, task, "adopted_pr_reconciled");
  }
  if (ci === "pending" || ci === "fail") {
    return transitionParkedAdoptedToPrOpen(
      deps,
      task,
      ci === "pending" ? "ci_pending" : "ci_failed",
    );
  }
  if (snapshot.latestReview.decision === "CHANGES_REQUESTED") {
    return transitionParkedAdoptedToPrOpen(
      deps,
      task,
      "adopted_pr_reconciled",
    );
  }

  return transitionParkedAdoptedReady(deps, task, attempt, snapshot);
}

function transitionParkedAdoptedToPrOpen(
  deps: TickDeps,
  task: ParkedPrTerminalTaskRow,
  action: Extract<TickAction, "adopted_pr_reconciled" | "ci_pending" | "ci_failed">,
): TickTaskResult | null {
  const now = deps.clock.nowISO();
  deps.db.exec("BEGIN IMMEDIATE");
  try {
    const transition = transitionTaskState(deps, {
      taskId: task.task_id,
      from: task.state,
      to: "pr-open",
      eventType: "existing_pr_attached",
      now,
      updates: {
        clearClaim: true,
        resetClaimExpirations: true,
        clearTickError: true,
        budgetExhausted: 0,
      },
    });
    if (!transition.applied) {
      deps.db.exec("ROLLBACK");
      return null;
    }
    cancelOpenOrchestratorHandoffs(deps, task.task_id);
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
  return { task_id: task.task_id, action };
}

function transitionParkedAdoptedReady(
  deps: TickDeps,
  task: ParkedPrTerminalTaskRow,
  attempt: CurrentAttemptRow,
  snapshot: PrSnapshot,
): TickTaskResult | null {
  const now = deps.clock.nowISO();
  deps.db.exec("BEGIN IMMEDIATE");
  try {
    const transition = transitionTaskState(deps, {
      taskId: task.task_id,
      from: task.state,
      to: "done",
      eventType: "ci_passed",
      attemptId: attempt.attempt_id,
      now,
      updates: {
        clearClaim: true,
        resetClaimExpirations: true,
        clearTickError: true,
        budgetExhausted: 0,
      },
    });
    if (!transition.applied) {
      deps.db.exec("ROLLBACK");
      return null;
    }
    cancelOpenOrchestratorHandoffs(deps, task.task_id);
    if (
      snapshot.latestReview.decision === "APPROVED" &&
      snapshot.latestReview.latestReviewId !== null
    ) {
      enqueuePrReadyApprovedOutboxItem(deps, {
        taskId: task.task_id,
        sourceEventId: transition.eventId,
        externalReview: { reviewId: snapshot.latestReview.latestReviewId },
      });
    }
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
  return { task_id: task.task_id, action: "ci_passed" };
}

function loadParkedPrSnapshot(
  deps: TickDeps,
  task: Pick<ParkedPrTerminalTaskRow, "repo_id" | "branch_name" | "pr_number">,
): PrSnapshot | null {
  if (task.pr_number !== null) {
    const byNumber = deps.github.prLightweightSnapshotByNumber(
      task.repo_id,
      task.pr_number,
    );
    if (byNumber !== null) return byNumber;
  }
  return deps.github.prLightweightSnapshot(task.repo_id, task.branch_name);
}

function loadParkedPrFullSnapshot(
  deps: TickDeps,
  task: Pick<ParkedPrTerminalTaskRow, "repo_id" | "branch_name" | "pr_number">,
): PrSnapshot | null {
  if (task.pr_number !== null) {
    const byNumber = deps.github.prSnapshotByNumber(task.repo_id, task.pr_number);
    if (byNumber !== null) return byNumber;
  }
  return deps.github.prSnapshot(task.repo_id, task.branch_name);
}

function finalizePrTerminal(
  deps: TickDeps,
  task: PrTerminalRow,
  attempt: CurrentAttemptRow,
  terminal: "merged" | "closed_unmerged",
  fromState: PrTerminalFromState,
): TickTaskResult {
  const now = deps.clock.nowISO();
  const taskTerminalState =
    terminal === "merged" && isUmbrellaTask(deps.db, task.task_id)
      ? "merged_to_feature_branch"
      : terminal;
  const activeReviewers =
    fromState === "pr-review"
      ? loadActiveReviewersForTask(deps.db, task.task_id)
      : [];

  if (activeReviewers.length > 0) {
    collectReviewAttemptArtifactsForRows(deps, task, activeReviewers);
  }

  // Step 1: branch + worktree cleanup per the §5 cleanup matrix.
  applyTerminalCleanup(deps, task, terminal);

  // Step 2: atomic SQL terminal transition.
  const reviewerSessionsToKill: string[] = [];
  deps.db.exec("BEGIN IMMEDIATE");
  try {
    const transition = transitionTaskState(deps, {
      taskId: task.task_id,
      from: fromState,
      to: taskTerminalState,
      eventType: terminal === "merged" ? "merged" : "closed",
      attemptId: attempt.attempt_id,
      now,
      updates: {
        clearClaim: true,
        resetClaimExpirations: true,
        clearTickError: true,
      },
    });
    if (!transition.applied) {
      deps.db.exec("ROLLBACK");
      return { task_id: task.task_id, action: "skipped_predicate" };
    }
    if (fromState === "pr-review") {
      // Mark every active review-only attempt ended + superseded so the
      // reviewer pane stops being a live participant in the task's history,
      // and collect their tmux sessions for a post-commit kill. Mirrors
      // enterReview's supersede-on-new-SHA pattern. reapAbandonedReviewers
      // closes the crash window between this COMMIT and the kill loop.
      for (const row of activeReviewers) {
        if (row.tmux_session !== null) {
          reviewerSessionsToKill.push(row.tmux_session);
        }
      }
      deps.db
        .query(
          `UPDATE attempts
              SET ended_at = ?,
                  review_verdict = 'superseded',
                  kill_intent = COALESCE(kill_intent, 'superseded')
            WHERE task_id = ?
              AND reason = 'review_only'
              AND ended_at IS NULL`,
        )
        .run(now, task.task_id);
    } else if (attempt.spawned_at !== null) {
      // Stamp `pr_merged` / `pr_closed_unmerged` exit_kind on the latest
      // attempt when it has no terminal exit yet (e.g. CI was still pending
      // — the attempt itself didn't reach a clean done state, so the latest
      // exit_kind is whatever was set when the worker died, typically
      // `pr_opened`). We only update when ended_at IS NULL to preserve the
      // historical exit.
      deps.db
        .query(
          `UPDATE attempts SET ended_at = ? WHERE attempt_id = ? AND ended_at IS NULL`,
        )
        .run(now, attempt.attempt_id);
    }
    cancelOpenOrchestratorHandoffs(deps, task.task_id);
    if (terminal === "merged") {
      if (taskTerminalState === "merged_to_feature_branch") {
        releaseDependentsForMergedToFeatureBranchTask(deps, task.task_id, now);
      } else {
        markFinalUmbrellaWorkflowCompleted(deps.db, task.task_id, now);
        releaseDependentsForMergedTask(deps, task.task_id, now);
      }
    }
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }

  for (const session of reviewerSessionsToKill) {
    try {
      deps.tmux.kill(session);
    } catch {}
  }

  return {
    task_id: task.task_id,
    action: terminal === "merged" ? "pr_merged" : "pr_closed_unmerged",
  };
}

function markFinalUmbrellaWorkflowCompleted(
  db: DB,
  taskId: string,
  now: string,
): void {
  db.query(
    `UPDATE umbrella_workflows
        SET state = 'completed',
            updated_at = ?
      WHERE final_pr_task_id = ?
        AND state = 'active'`,
  ).run(now, taskId);
}

function isUmbrellaTask(db: DB, taskId: string): boolean {
  const row = db
    .query<{ n: number }, [string]>(
      `SELECT 1 AS n FROM umbrella_tasks WHERE task_id = ? LIMIT 1`,
    )
    .get(taskId);
  return row !== null && row !== undefined;
}

function loadUmbrellaSubtaskIntegration(
  db: DB,
  taskId: string,
): UmbrellaSubtaskIntegrationRow | null {
  const row = db
    .query<UmbrellaSubtaskIntegrationRow, [string]>(
      `SELECT uw.umbrella_workflow_id,
              uw.feature_branch,
              uw.final_pr_task_id
         FROM umbrella_tasks ut
         JOIN umbrella_workflows uw
           ON uw.umbrella_workflow_id = ut.umbrella_workflow_id
        WHERE ut.task_id = ?
          AND uw.state = 'active'
        LIMIT 1`,
    )
    .get(taskId);
  return row ?? null;
}

function loadUmbrellaFinalPrExpectedSubtasks(
  db: DB,
  umbrellaWorkflowId: number,
): UmbrellaFinalPrExpectedSubtaskRow[] {
  return db
    .query<UmbrellaFinalPrExpectedSubtaskRow, [number]>(
      `SELECT uet.external_ref,
              uet.title,
              uet.state,
              uet.completion_source,
              uet.completion_reason,
              ut.task_id,
              t.state AS task_state,
              t.pr_url,
              ao.file_path AS objective_path
         FROM umbrella_expected_tasks uet
         LEFT JOIN umbrella_tasks ut
           ON ut.umbrella_workflow_id = uet.umbrella_workflow_id
          AND ut.external_ref = uet.external_ref
         LEFT JOIN tasks t
           ON t.task_id = ut.task_id
         LEFT JOIN artifacts ao
           ON ao.task_id = ut.task_id
          AND ao.kind = 'task_objective'
          AND ao.attempt_id IS NULL
        WHERE uet.umbrella_workflow_id = ?
        ORDER BY uet.external_ref`,
    )
    .all(umbrellaWorkflowId);
}

const UMBRELLA_FINAL_PR_START = "<!-- quay:umbrella-final-pr:start -->";
const UMBRELLA_FINAL_PR_END = "<!-- quay:umbrella-final-pr:end -->";

function renderUmbrellaFinalPrTitle(
  workflow: ReadyUmbrellaFinalPrWorkflowRow,
): string {
  const ticket = normalizeTicketRef(workflow.external_ref);
  const linearTitle = normalizePrTitleText(workflow.linear_issue_title);
  if (linearTitle !== null) {
    const titled =
      hasConventionalCommitPrefix(linearTitle) ? linearTitle : `feat: ${linearTitle}`;
    return appendTicketRefToTitle(titled, ticket);
  }
  return ticket === null
    ? "feat: reconcile umbrella workflow"
    : `feat: reconcile umbrella workflow (${ticket})`;
}

function renderUmbrellaFinalPrManagedSection(
  workflow: ReadyUmbrellaFinalPrWorkflowRow,
  subtasks: UmbrellaFinalPrExpectedSubtaskRow[],
): string {
  const displayRef = normalizeTicketRef(workflow.external_ref) ?? workflow.external_ref;
  const linearTicket = renderLinearTicketLink(displayRef, workflow.linear_issue_url);
  const linearTitle = normalizePrTitleText(workflow.linear_issue_title);
  const lines = [
    UMBRELLA_FINAL_PR_START,
    "## Quay Umbrella Final PR",
    "",
    `Umbrella external ref: ${displayRef}`,
    ...(linearTitle === null ? [] : [`Umbrella title: ${linearTitle}`]),
    `Linear ticket: ${linearTicket}`,
    `Source branch: ${workflow.feature_branch}`,
    `Target branch: ${workflow.base_branch}`,
    "",
    "Quay opened this PR after all expected umbrella subtasks were accounted for.",
    "",
    "### Expected Subtasks",
  ];
  for (const subtask of subtasks) {
    const subtaskRef = normalizeTicketRef(subtask.external_ref) ?? subtask.external_ref;
    const title = subtask.title ?? extractObjectiveTitle(subtask.objective_path);
    const titlePart = title === null ? "" : ` - ${title}`;
    if (subtask.state === "complete_without_quay") {
      const source =
        subtask.completion_source === null
          ? "unknown"
          : subtask.completion_source;
      const reason =
        subtask.completion_reason === null || subtask.completion_reason === ""
          ? "no reason recorded"
          : subtask.completion_reason;
      lines.push(
        `- ${subtaskRef}${titlePart} (complete without Quay; source: ${source}; reason: ${reason})`,
      );
      continue;
    }
    const taskPart =
      subtask.task_id === null ? "task unavailable" : `task ${subtask.task_id}`;
    const prPart =
      subtask.pr_url === null || subtask.pr_url === ""
        ? "subtask PR: unavailable"
        : `subtask PR: ${subtask.pr_url}`;
    lines.push(`- ${subtaskRef}${titlePart} (${taskPart}; ${prPart})`);
  }
  if (subtasks.length === 0) {
    lines.push("- No expected subtasks recorded.");
  }
  lines.push("", UMBRELLA_FINAL_PR_END);
  return lines.join("\n");
}

function normalizePrTitleText(title: string | null): string | null {
  if (title === null) return null;
  const normalized = title.replace(/\s+/g, " ").trim();
  return normalized === "" ? null : normalized;
}

function hasConventionalCommitPrefix(title: string): boolean {
  return /^[a-z]+(?:\([^)]+\))?!?:\s/i.test(title);
}

function appendTicketRefToTitle(title: string, ticket: string | null): string {
  if (ticket === null) return title;
  if (title.toUpperCase().includes(ticket.toUpperCase())) return title;
  return `${title} (${ticket})`;
}

function renderLinearTicketLink(displayRef: string, url: string | null): string {
  const trimmed = url?.trim();
  if (trimmed === undefined || trimmed === "") return displayRef;
  return `[${displayRef}](${trimmed})`;
}

function replaceUmbrellaFinalPrManagedSection(
  existingBody: string,
  managedSection: string,
): string {
  const start = existingBody.indexOf(UMBRELLA_FINAL_PR_START);
  const end = existingBody.indexOf(UMBRELLA_FINAL_PR_END);
  if (start !== -1 && end !== -1 && end >= start) {
    const afterEnd = end + UMBRELLA_FINAL_PR_END.length;
    return `${existingBody.slice(0, start).trimEnd()}\n\n${managedSection}\n\n${existingBody.slice(afterEnd).trimStart()}`.trim();
  }
  if (existingBody.trim() === "") return managedSection;
  return `${existingBody.trimEnd()}\n\n${managedSection}`;
}

function normalizeTicketRef(externalRef: string): string | null {
  const trimmed = externalRef.trim();
  if (trimmed === "") return null;
  const match = trimmed.match(/^([A-Za-z]+)-(\d+)$/);
  if (match === null) return trimmed;
  const prefix = match[1]!.toUpperCase() === "ITRY" ? "BRIX" : match[1]!.toUpperCase();
  return `${prefix}-${match[2]}`;
}

function extractObjectiveTitle(path: string | null): string | null {
  if (path === null || path === "") return null;
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
      const title = trimmed.replace(/^#+\s*/, "").trim();
      return title === "" ? null : title;
    }
  }
  const first = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (first === undefined) return null;
  return first.length > 80 ? `${first.slice(0, 77)}...` : first;
}

function ensureUmbrellaFinalPrTask(
  deps: TickDeps,
  workflow: ReadyUmbrellaFinalPrWorkflowRow,
  pr: OpenBranchPr,
  managedSection: string,
): string {
  const canonicalTaskId = umbrellaFinalPrTaskId(workflow.umbrella_workflow_id);
  const existingTaskId =
    workflow.final_pr_task_id ??
    lookupUmbrellaFinalTaskId(
      deps.db,
      workflow.repo_id,
      canonicalTaskId,
      workflow.external_ref,
    );
  const now = deps.clock.nowISO();
  const taskId = existingTaskId ?? canonicalTaskId;
  if (existingTaskId === null) {
    const worktreesRoot = inferUmbrellaWorktreesRoot(
      deps.db,
      workflow.umbrella_workflow_id,
    );
    const worktreePath = join(worktreesRoot, taskId);
    let worktreeCreated = false;
    const preambleId = ensurePreambleIdForAttemptReason(
      deps.db,
      deps.clock,
      "initial",
      { repoId: workflow.repo_id },
    );
    worktreeCreated = ensureUmbrellaFinalPrWorktree(
      deps,
      workflow,
      worktreePath,
    );
    deps.db.exec("BEGIN");
    try {
      deps.db
        .query(
          `INSERT INTO tasks (
             task_id, repo_id, external_ref, state, authoring_mode,
             branch_name, base_branch, tmux_id, worktree_path,
             pr_number, pr_url, head_sha, base_sha, retry_budget,
             created_at, updated_at
           ) VALUES (?, ?, ?, 'pr-open', 'quay_owned', ?, ?, ?, ?, ?, ?, ?, ?, 5, ?, ?)`,
        )
        .run(
          taskId,
          workflow.repo_id,
          workflow.external_ref,
          workflow.feature_branch,
          workflow.base_branch,
          `quay-umbrella-final-${workflow.umbrella_workflow_id}`,
          worktreePath,
          pr.number,
          pr.url,
          pr.headSha,
          pr.baseSha,
          now,
          now,
        );
      const attempt = deps.db
        .query<{ attempt_id: number }, [string, number, string, string, string | null]>(
          `INSERT INTO attempts (
             task_id, attempt_number, preamble_id, reason, consumed_budget,
             spawned_at, ended_at, exit_kind, remote_sha_at_exit,
             pr_existed_at_spawn
           ) VALUES (?, 1, ?, 'umbrella_final_pr', 0, ?, ?, 'pr_opened', ?, 1)
           RETURNING attempt_id`,
        )
        .get(taskId, preambleId, now, now, pr.headSha);
      if (!attempt) throw new Error("umbrella final PR attempt insert returned no row");
      deps.artifactStore.writeArtifact({
        taskId,
        attemptId: null,
        kind: "task_objective",
        content: managedSection,
        extension: "md",
      });
      deps.artifactStore.writeArtifact({
        taskId,
        attemptId: attempt.attempt_id,
        kind: "brief",
        content: managedSection,
        extension: "md",
      });
      deps.artifactStore.writeArtifact({
        taskId,
        attemptId: attempt.attempt_id,
        kind: "final_prompt",
        content: managedSection,
        extension: "md",
      });
      deps.db
        .query(
          `INSERT INTO events (
             task_id, attempt_id, event_type, to_state, occurred_at, event_data
           ) VALUES (?, ?, 'umbrella_final_pr_reconciled', 'pr-open', ?, ?)`,
        )
        .run(
          taskId,
          attempt.attempt_id,
          now,
          JSON.stringify({
            umbrella_workflow_id: workflow.umbrella_workflow_id,
            pr_number: pr.number,
            source_branch: workflow.feature_branch,
            target_branch: workflow.base_branch,
          }),
        );
      deps.db.exec("COMMIT");
    } catch (err) {
      try {
        deps.db.exec("ROLLBACK");
      } catch {}
      if (worktreeCreated) {
        removeUmbrellaFinalPrWorktreeBestEffort(deps, worktreePath);
      }
      throw err;
    }
    return taskId;
  }

  const existingWorktreePath = loadTaskWorktreePath(deps.db, existingTaskId);
  let recoveredWorktree = false;
  if (existingWorktreePath !== null) {
    recoveredWorktree = ensureUmbrellaFinalPrWorktree(
      deps,
      workflow,
      existingWorktreePath,
    );
  }
  try {
    const preambleId = ensurePreambleIdForAttemptReason(
      deps.db,
      deps.clock,
      "initial",
      { repoId: workflow.repo_id },
    );
    const attemptId = ensureUmbrellaFinalPrReconcileAttempt(
      deps,
      existingTaskId,
      preambleId,
      pr.headSha,
      now,
    );
    deps.db
      .query(
        `UPDATE tasks
            SET external_ref = ?,
                state = 'pr-open',
                authoring_mode = 'quay_owned',
                branch_name = ?,
                base_branch = ?,
                tmux_id = ?,
                pr_number = ?,
                pr_url = COALESCE(?, pr_url),
                head_sha = COALESCE(?, head_sha),
                base_sha = COALESCE(?, base_sha),
                tick_error = NULL,
                updated_at = ?
          WHERE task_id = ?`,
      )
      .run(
        workflow.external_ref,
        workflow.feature_branch,
        workflow.base_branch,
        `quay-umbrella-final-${workflow.umbrella_workflow_id}`,
        pr.number,
        pr.url,
        pr.headSha,
        pr.baseSha,
        now,
        existingTaskId,
      );
    ensureUmbrellaFinalPrArtifacts(
      deps,
      existingTaskId,
      attemptId,
      managedSection,
    );
  } catch (err) {
    if (recoveredWorktree && existingWorktreePath !== null) {
      removeUmbrellaFinalPrWorktreeBestEffort(deps, existingWorktreePath);
    }
    throw err;
  }
  return existingTaskId;
}

function umbrellaFinalPrTaskId(umbrellaWorkflowId: number): string {
  return `umbrella-final-pr-${umbrellaWorkflowId}`;
}

function ensureUmbrellaFinalPrWorktree(
  deps: TickDeps,
  workflow: ReadyUmbrellaFinalPrWorkflowRow,
  worktreePath: string,
): boolean {
  const repo = loadWorktreeDependencyRepo(deps.db, workflow.repo_id);
  if (existsSync(worktreePath)) {
    const currentBranch = deps.git.worktreeCurrentBranch(worktreePath);
    if (currentBranch === workflow.feature_branch) {
      installWorktreeDependencies(deps.commandRunner, repo, worktreePath);
      return false;
    }
    deps.git.worktreeRemove(worktreePath);
  }
  try {
    deps.git.fetch(workflow.repo_id, workflow.feature_branch);
    deps.git.worktreeAddExistingBranch(
      workflow.repo_id,
      worktreePath,
      workflow.feature_branch,
      `origin/${workflow.feature_branch}`,
    );
    installWorktreeDependencies(deps.commandRunner, repo, worktreePath);
    return true;
  } catch (err) {
    if (existsSync(worktreePath)) {
      removeUmbrellaFinalPrWorktreeBestEffort(deps, worktreePath);
    }
    throw err;
  }
}

function removeUmbrellaFinalPrWorktreeBestEffort(
  deps: Pick<TickDeps, "git">,
  worktreePath: string,
): void {
  try {
    deps.git.worktreeRemove(worktreePath);
  } catch {
    try {
      rmSync(worktreePath, { recursive: true, force: true });
    } catch {}
  }
}

function loadTaskWorktreePath(db: DB, taskId: string): string | null {
  const row = db
    .query<{ worktree_path: string }, [string]>(
      `SELECT worktree_path FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  return row?.worktree_path ?? null;
}

function lookupUmbrellaFinalTaskId(
  db: DB,
  repoId: string,
  canonicalTaskId: string,
  externalRef: string,
): string | null {
  const row = db
    .query<{ task_id: string }, [string, string]>(
      `SELECT task_id
         FROM tasks
        WHERE repo_id = ?
          AND task_id = ?
        LIMIT 1`,
    )
    .get(repoId, canonicalTaskId);
  if (row !== null && row !== undefined) return row.task_id;
  const externalRefRow = db
    .query<{ task_id: string }, [string, string]>(
      `SELECT task_id
         FROM tasks
        WHERE repo_id = ?
          AND external_ref = ?
        ORDER BY created_at, task_id
        LIMIT 1`,
    )
    .get(repoId, externalRef);
  return externalRefRow?.task_id ?? null;
}

function ensureUmbrellaFinalPrReconcileAttempt(
  deps: Pick<TickDeps, "db">,
  taskId: string,
  preambleId: number,
  headSha: string | null,
  now: string,
): number {
  const existing = deps.db
    .query<{ attempt_id: number }, [string]>(
      `SELECT attempt_id
         FROM attempts
        WHERE task_id = ?
          AND reason = 'umbrella_final_pr'
        ORDER BY attempt_id
        LIMIT 1`,
    )
    .get(taskId);
  if (existing !== null && existing !== undefined) return existing.attempt_id;

  const next = deps.db
    .query<{ attempt_number: number }, [string]>(
      `SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt_number
         FROM attempts
        WHERE task_id = ?`,
    )
    .get(taskId);
  const attemptNumber = next?.attempt_number ?? 1;
  const inserted = deps.db
    .query<{ attempt_id: number }, [string, number, number, string, string, string | null]>(
      `INSERT INTO attempts (
         task_id, attempt_number, preamble_id, reason, consumed_budget,
         spawned_at, ended_at, exit_kind, remote_sha_at_exit,
         pr_existed_at_spawn
       ) VALUES (?, ?, ?, 'umbrella_final_pr', 0, ?, ?, 'pr_opened', ?, 1)
       RETURNING attempt_id`,
    )
    .get(taskId, attemptNumber, preambleId, now, now, headSha);
  if (!inserted) throw new Error("umbrella final PR attempt insert returned no row");
  return inserted.attempt_id;
}

function ensureUmbrellaFinalPrArtifacts(
  deps: Pick<TickDeps, "db" | "artifactStore">,
  taskId: string,
  attemptId: number,
  managedSection: string,
): void {
  ensureUmbrellaFinalPrArtifact(deps, taskId, null, "task_objective", managedSection);
  ensureUmbrellaFinalPrArtifact(deps, taskId, attemptId, "brief", managedSection);
  ensureUmbrellaFinalPrArtifact(deps, taskId, attemptId, "final_prompt", managedSection);
}

function ensureUmbrellaFinalPrArtifact(
  deps: Pick<TickDeps, "db" | "artifactStore">,
  taskId: string,
  attemptId: number | null,
  kind: string,
  content: string,
): void {
  const existing =
    attemptId === null
      ? deps.db
          .query<{ artifact_id: number }, [string, string]>(
            `SELECT artifact_id
               FROM artifacts
              WHERE task_id = ?
                AND kind = ?
                AND attempt_id IS NULL
              LIMIT 1`,
          )
          .get(taskId, kind)
      : deps.db
          .query<{ artifact_id: number }, [string, number, string]>(
            `SELECT artifact_id
               FROM artifacts
              WHERE task_id = ?
                AND attempt_id = ?
                AND kind = ?
              LIMIT 1`,
          )
          .get(taskId, attemptId, kind);
  if (existing !== null && existing !== undefined) return;
  deps.artifactStore.writeArtifact({
    taskId,
    attemptId,
    kind,
    content,
    extension: "md",
  });
}

function inferUmbrellaWorktreesRoot(db: DB, umbrellaWorkflowId: number): string {
  const row = db
    .query<{ worktree_path: string }, [number]>(
      `SELECT t.worktree_path
         FROM umbrella_tasks ut
         JOIN tasks t ON t.task_id = ut.task_id
        WHERE ut.umbrella_workflow_id = ?
        ORDER BY ut.umbrella_task_id
        LIMIT 1`,
    )
    .get(umbrellaWorkflowId);
  if (row === undefined || row === null) return "/tmp";
  return dirname(row.worktree_path);
}

function releaseDependentsForMergedTask(
  deps: Pick<TickDeps, "db">,
  taskId: string,
  now: string,
): void {
  const satisfiedDependencies = satisfyDependenciesForMergedTask(
    deps.db,
    taskId,
    now,
  );
  const dependentTaskIds = new Set(
    satisfiedDependencies.map((dep) => dep.dependent_task_id),
  );
  for (const dependentTaskId of dependentTaskIds) {
    releaseTaskIfDependenciesSatisfied(deps.db, dependentTaskId, now);
  }
}

function releaseDependentsForMergedToFeatureBranchTask(
  deps: Pick<TickDeps, "db">,
  taskId: string,
  now: string,
): void {
  const satisfiedDependencies = satisfyDependenciesForMergedToFeatureBranchTask(
    deps.db,
    taskId,
    now,
  );
  const dependentTaskIds = new Set(
    satisfiedDependencies.map((dep) => dep.dependent_task_id),
  );
  for (const dependentTaskId of dependentTaskIds) {
    releaseTaskIfDependenciesSatisfied(deps.db, dependentTaskId, now);
  }
}

interface ActiveReviewerAttemptRow {
  attempt_id: number;
  tmux_session: string | null;
}

function loadActiveReviewersForTask(
  db: DB,
  taskId: string,
): ActiveReviewerAttemptRow[] {
  return db
    .query<ActiveReviewerAttemptRow, [string]>(
      `SELECT attempt_id, tmux_session
         FROM attempts
        WHERE task_id = ?
          AND reason = 'review_only'
          AND ended_at IS NULL`,
    )
    .all(taskId);
}

function collectReviewAttemptArtifactsForRows(
  deps: TickDeps,
  task: PrTerminalRow,
  attempts: ActiveReviewerAttemptRow[],
): void {
  for (const attempt of attempts) {
    const usageResult = collectUsageArtifact(
      deps,
      task.task_id,
      attempt.attempt_id,
      task.worktree_path,
    );
    persistResolvedAttemptModel(deps.db, attempt.attempt_id, usageResult.resolvedModel);
    collectToolTraceArtifact(
      deps,
      task.task_id,
      attempt.attempt_id,
      task.worktree_path,
    );
  }
}

function applyTerminalCleanup(
  deps: TickDeps,
  task: PrTerminalRow,
  terminal: "merged" | "closed_unmerged",
): void {
  // Worktree removal (best-effort) per §5 cleanup matrix.
  try {
    if (existsSync(task.worktree_path)) {
      deps.git.worktreeRemove(task.worktree_path);
    }
  } catch {}

  // Local branch is deleted in both terminals.
  try {
    deps.git.branchDelete(task.repo_id, task.branch_name);
  } catch {}

  // Remote branch: delete Quay-owned branches only on closed_unmerged. Adopted
  // external PR branches are human-owned and must be retained by default.
  if (
    terminal === "closed_unmerged" &&
    task.authoring_mode !== "adopted_external_pr"
  ) {
    try {
      deps.git.deleteRemoteBranch(task.repo_id, task.branch_name);
    } catch {}
  }
}

function transitionCiPassed(
  deps: TickDeps,
  task: PrOpenTaskRow,
  attempt: CurrentAttemptRow,
): TickTaskResult | null {
  const now = deps.clock.nowISO();
  deps.db.exec("BEGIN");
  try {
    const transition = transitionTaskState(deps, {
      taskId: task.task_id,
      from: "pr-open",
      to: "done",
      eventType: "ci_passed",
      attemptId: attempt.attempt_id,
      now,
      updates: { clearTickError: true },
    });
    if (!transition.applied) {
      deps.db.exec("ROLLBACK");
      return null;
    }
    enqueuePrReadyApprovedOutboxItem(deps, {
      taskId: task.task_id,
      sourceEventId: transition.eventId,
    });
    deps.db.exec("COMMIT");
    return { task_id: task.task_id, action: "ci_passed" };
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

function scheduleCiFailRetry(
  deps: TickDeps,
  taskId: string,
  prevAttempt: RetryAttemptRef,
  snapshot: PrSnapshot,
  fromState: "pr-open" | "pr-review",
): TickTaskResult {
  const now = deps.clock.nowISO();
  deps.db.exec("BEGIN");
  try {
    applyCiFailRetryInOpenTxn(
      deps,
      taskId,
      prevAttempt,
      snapshot,
      fromState,
      now,
    );
    deps.db.exec("COMMIT");
    return { task_id: taskId, action: "ci_failed" };
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

function applyCiFailRetryInOpenTxn(
  deps: TickDeps,
  taskId: string,
  prevAttempt: RetryAttemptRef,
  snapshot: PrSnapshot,
  fromState: "pr-open" | "pr-review",
  now: string,
): void {
  const failureExcerpt = composeCiFailureExcerpt(snapshot);
  const excerpt = deps.artifactStore.writeArtifact({
    taskId,
    attemptId: prevAttempt.attempt_id,
    kind: "ci_failure_excerpt",
    content: failureExcerpt,
    extension: "txt",
  });
  scheduleDeterministicRetry(deps, {
    taskId,
    prevAttempt,
    reason: "ci_fail",
    diagnostics: failureExcerpt,
    fromState,
  });
  deps.db
    .query(
      `INSERT INTO events (
         task_id, attempt_id, event_type, from_state, to_state,
         payload_artifact_id, occurred_at
       ) VALUES (?, ?, 'ci_failed', ?, (SELECT state FROM tasks WHERE task_id = ?), ?, ?)`,
    )
    .run(
      taskId,
      prevAttempt.attempt_id,
      fromState,
      taskId,
      excerpt.artifactId,
      now,
    );
}

function composeCiFailureExcerpt(snapshot: PrSnapshot): string {
  if (snapshot.checks.failureExcerpt) return snapshot.checks.failureExcerpt;
  const fails = snapshot.checks.items
    .filter((c) => c.bucket === "fail" || c.bucket === "cancelled")
    .map((c) => `${c.workflow ?? "<no-workflow>"}/${c.name} = ${c.bucket}`);
  if (fails.length === 0) return "CI failed.";
  return ["CI failed:", ...fails.map((s) => `  - ${s}`)].join("\n");
}

function hasActionableReviewFeedback(
  task: { last_review_id_acted_on: string | null },
  snapshot: PrSnapshot,
): boolean {
  return (
    snapshot.latestReview.decision === "CHANGES_REQUESTED" &&
    snapshot.latestReview.latestReviewId !== null &&
    (snapshot.latestReview.submittedHeadSha === undefined ||
      snapshot.latestReview.submittedHeadSha === null ||
      snapshot.latestReview.submittedHeadSha === snapshot.headSha) &&
    task.last_review_id_acted_on !== snapshot.latestReview.latestReviewId
  );
}

function conflictSliceContent(snapshot: PrSnapshot): string {
  return JSON.stringify({
    head_sha: snapshot.headSha,
    base_sha: snapshot.baseSha,
    mergeable: snapshot.mergeable,
  });
}

function reviewCommentsContent(snapshot: PrSnapshot, reviewId: string): string {
  return JSON.stringify({
    review_id: reviewId,
    decision: snapshot.latestReview.decision,
    comments: snapshot.latestReview.comments,
  });
}

function conflictDiagnostics(snapshot: PrSnapshot): string {
  return `GitHub reports mergeable=${snapshot.mergeable} for head=${snapshot.headSha} base=${snapshot.baseSha ?? "<unknown>"}.`;
}

function scheduleConflictNonBudget(
  deps: TickDeps,
  taskId: string,
  attempt: CurrentAttemptRow,
  snapshot: PrSnapshot,
  observation: string,
  fromState: "pr-open" | "done",
  options: TickOptions,
): TickTaskResult {
  const cap = options.maxNonBudgetRespawns ?? DEFAULT_MAX_NON_BUDGET_RESPAWNS;
  const result = scheduleNonBudgetRespawn(deps, {
    taskId,
    prevAttempt: attempt,
    reason: "conflict",
    diagnostics: conflictDiagnostics(snapshot),
    fromState,
    snapshotKind: "conflict_slice",
    snapshotContent: conflictSliceContent(snapshot),
    snapshotExtension: "json",
    dedupeColumn: "last_conflict_observation",
    dedupeValue: observation,
    maxNonBudgetRespawns: cap,
  });
  if (result.outcome === "parked") {
    return { task_id: taskId, action: "non_budget_loop_parked" };
  }
  if (result.outcome === "scheduled") {
    return { task_id: taskId, action: "conflict_respawn_scheduled" };
  }
  return { task_id: taskId, action: "skipped_predicate" };
}

function scheduleConflictReviewNonBudget(
  deps: TickDeps,
  taskId: string,
  attempt: CurrentAttemptRow,
  snapshot: PrSnapshot,
  observation: string,
  fromState: "done",
  options: TickOptions,
): TickTaskResult {
  const cap = options.maxNonBudgetRespawns ?? DEFAULT_MAX_NON_BUDGET_RESPAWNS;
  const reviewId = snapshot.latestReview.latestReviewId!;
  const reviewComments =
    snapshot.latestReview.comments.trim() === ""
      ? "(No review comments captured.)"
      : snapshot.latestReview.comments;
  const result = scheduleNonBudgetRespawn(deps, {
    taskId,
    prevAttempt: attempt,
    reason: "conflict",
    diagnostics: [
      conflictDiagnostics(snapshot),
      `Reviewer marked CHANGES_REQUESTED in review ${reviewId}.`,
      "",
      "Required actions:",
      "1. Resolve the merge conflict against the base branch.",
      "2. Address the CHANGES_REQUESTED review comments.",
      "3. Push the existing branch and update the existing PR.",
      "",
      "Review comments:",
      reviewComments,
    ].join("\n"),
    fromState,
    snapshotKind: "conflict_slice",
    snapshotContent: conflictSliceContent(snapshot),
    snapshotExtension: "json",
    dedupeColumn: "last_conflict_observation",
    dedupeValue: observation,
    extraSnapshots: [
      {
        snapshotKind: "review_comments",
        snapshotContent: reviewCommentsContent(snapshot, reviewId),
        snapshotExtension: "json",
      },
    ],
    extraDedupeUpdates: [
      {
        dedupeColumn: "last_review_id_acted_on",
        dedupeValue: reviewId,
      },
    ],
    maxNonBudgetRespawns: cap,
  });
  if (result.outcome === "parked") {
    return { task_id: taskId, action: "non_budget_loop_parked" };
  }
  if (result.outcome === "scheduled") {
    return { task_id: taskId, action: "conflict_respawn_scheduled" };
  }
  return { task_id: taskId, action: "skipped_predicate" };
}

function scheduleReviewNonBudget(
  deps: TickDeps,
  taskId: string,
  attempt: CurrentAttemptRow,
  snapshot: PrSnapshot,
  fromState: "done",
  options: TickOptions,
): TickTaskResult {
  const cap = options.maxNonBudgetRespawns ?? DEFAULT_MAX_NON_BUDGET_RESPAWNS;
  const reviewId = snapshot.latestReview.latestReviewId!;
  const result = scheduleNonBudgetRespawn(deps, {
    taskId,
    prevAttempt: attempt,
    reason: "review",
    diagnostics: `Reviewer marked CHANGES_REQUESTED in review ${reviewId}.`,
    fromState,
    snapshotKind: "review_comments",
    snapshotContent: reviewCommentsContent(snapshot, reviewId),
    snapshotExtension: "json",
    dedupeColumn: "last_review_id_acted_on",
    dedupeValue: reviewId,
    maxNonBudgetRespawns: cap,
  });
  if (result.outcome === "parked") {
    return { task_id: taskId, action: "non_budget_loop_parked" };
  }
  if (result.outcome === "scheduled") {
    return { task_id: taskId, action: "review_respawn_scheduled" };
  }
  return { task_id: taskId, action: "skipped_predicate" };
}

function guardApprovedReviewCi(
  deps: TickDeps,
  task: ReviewAttemptTaskRow,
  posted: PostedReview,
  exitInfo: PaneExitInfo,
  options: TickOptions,
  rawReviewResult: string,
): TickTaskResult | null {
  const snapshot = deps.github.prSnapshot(task.repo_id, task.branch_name);
  if (snapshot === null) {
    finalizeApprovedReviewBackToPrOpen(
      deps,
      task,
      posted,
      exitInfo,
      "approved",
      rawReviewResult,
    );
    return recordTickError(
      deps,
      task.task_id,
      new Error(
        `PR snapshot unavailable for branch ${task.branch_name}; cannot finalize approved review`,
      ),
    );
  }
  persistPrMetadata(deps, task.task_id, snapshot);
  if (snapshot.headSha !== task.head_sha) {
    return handleStaleApprovedReview(
      deps,
      task,
      posted,
      exitInfo,
      snapshot,
      options,
      rawReviewResult,
    );
  }

  const repo = loadRepoForTask(deps.db, task.task_id);
  const ci = classifyCi(
    snapshot,
    repo?.ci_workflow_name ?? null,
    resolveCiIgnorePolicy(options.ciIgnorePolicy ?? EMPTY_CI_IGNORE_POLICY, repo),
  );
  if (ci === "stale") {
    finalizeApprovedReviewBackToPrOpen(
      deps,
      task,
      posted,
      exitInfo,
      "approved",
      rawReviewResult,
    );
    return recordTickError(
      deps,
      task.task_id,
      new Error(
        `PR head SHA (${snapshot.headSha}) and check-run SHA (${snapshot.checks.checkSha}) disagree; cannot finalize approved review`,
      ),
    );
  }
  if (ci === "pending") {
    finalizeApprovedReviewBackToPrOpen(
      deps,
      task,
      posted,
      exitInfo,
      "approved",
      rawReviewResult,
    );
    return { task_id: task.task_id, action: "ci_pending" };
  }
  if (ci === "fail") {
    return finalizeApprovedReviewBlockedByCi(
      deps,
      task,
      posted,
      exitInfo,
      snapshot,
      rawReviewResult,
    );
  }
  return null;
}

function handleStaleApprovedReview(
  deps: TickDeps,
  task: ReviewAttemptTaskRow,
  posted: PostedReview,
  exitInfo: PaneExitInfo,
  snapshot: PrSnapshot,
  options: TickOptions,
  rawReviewResult: string,
): TickTaskResult {
  const repo = loadRepoForTask(deps.db, task.task_id);
  const ci = classifyCi(
    snapshot,
    repo?.ci_workflow_name ?? null,
    resolveCiIgnorePolicy(options.ciIgnorePolicy ?? EMPTY_CI_IGNORE_POLICY, repo),
  );
  if (ci === "stale") {
    finalizeApprovedReviewBackToPrOpen(
      deps,
      task,
      posted,
      exitInfo,
      "superseded",
      rawReviewResult,
    );
    return recordTickError(
      deps,
      task.task_id,
      new Error(
        `PR head SHA (${snapshot.headSha}) and check-run SHA (${snapshot.checks.checkSha}) disagree; cannot re-gate stale approved review`,
      ),
    );
  }
  if (ci === "pending") {
    finalizeApprovedReviewBackToPrOpen(
      deps,
      task,
      posted,
      exitInfo,
      "superseded",
      rawReviewResult,
    );
    return { task_id: task.task_id, action: "ci_pending" };
  }
  if (ci === "fail") {
    return finalizeStaleApprovedReviewBlockedByCi(
      deps,
      task,
      posted,
      exitInfo,
      snapshot,
      rawReviewResult,
    );
  }

  finalizeApprovedReviewBackToPrOpen(
    deps,
    task,
    posted,
    exitInfo,
    "superseded",
    rawReviewResult,
  );
  if (snapshot.prNumber === undefined || snapshot.prNumber === null) {
    return recordTickError(
      deps,
      task.task_id,
      new Error(
        `PR snapshot for ${task.branch_name} did not include a PR number; cannot schedule a fresh review for ${snapshot.headSha}`,
      ),
    );
  }
  const result = enterReview(
    {
      db: deps.db,
      clock: deps.clock,
      github: deps.github,
      artifactStore: deps.artifactStore,
      tmux: deps.tmux,
    },
    {
      repoId: task.repo_id,
      prNumber: snapshot.prNumber,
      headSha: snapshot.headSha,
      reviewerEnabled: true,
      gateQuayOwnedDone: true,
      referenceReposRoot: deps.referenceReposRoot,
      ciIgnorePolicy: options.ciIgnorePolicy,
    },
  );
  return {
    task_id: task.task_id,
    action: result.scheduled ? "review_requested" : "skipped_predicate",
  };
}

function finalizeApprovedReviewBlockedByCi(
  deps: TickDeps,
  task: ReviewAttemptTaskRow,
  posted: PostedReview,
  exitInfo: PaneExitInfo,
  snapshot: PrSnapshot,
  rawReviewResult: string,
): TickTaskResult {
  collectReviewAttemptArtifacts(deps, task);
  const now = deps.clock.nowISO();
  const content = reviewArtifactContent(posted, task.head_sha);

  deps.db.exec("BEGIN IMMEDIATE");
  try {
    deps.db
      .query(
        `UPDATE attempts
            SET ended_at = ?,
                exit_kind = 'review_approved',
                exit_code = ?,
                exit_signal = ?,
                review_verdict = 'approved',
                review_id = ?
          WHERE attempt_id = ? AND ended_at IS NULL`,
      )
      .run(
        now,
        exitInfo.exitCode,
        exitInfo.exitSignal,
        posted.reviewId,
        task.attempt_id,
      );
    deps.db
      .query(
        `UPDATE tasks
            SET review_infra_failures_consecutive = 0,
                review_infra_failure_head_sha = NULL,
                tick_error = NULL,
                updated_at = ?
          WHERE task_id = ?`,
      )
      .run(now, task.task_id);
    deps.artifactStore.writeArtifact({
      taskId: task.task_id,
      attemptId: task.attempt_id,
      kind: "review_result",
      content: rawReviewResult,
      extension: "json",
    });
    deps.artifactStore.writeArtifact({
      taskId: task.task_id,
      attemptId: task.attempt_id,
      kind: "review_comments",
      content,
      extension: "json",
    });
    applyCiFailRetryInOpenTxn(
      deps,
      task.task_id,
      {
        attempt_id: task.attempt_id,
        attempt_number: task.attempt_number,
        preamble_id: task.preamble_id,
      },
      snapshot,
      "pr-review",
      now,
    );
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }

  return { task_id: task.task_id, action: "ci_failed" };
}

function finalizeStaleApprovedReviewBlockedByCi(
  deps: TickDeps,
  task: ReviewAttemptTaskRow,
  posted: PostedReview,
  exitInfo: PaneExitInfo,
  snapshot: PrSnapshot,
  rawReviewResult: string,
): TickTaskResult {
  collectReviewAttemptArtifacts(deps, task);
  const now = deps.clock.nowISO();

  deps.db.exec("BEGIN IMMEDIATE");
  try {
    markReviewAttemptEndedInOpenTxn(
      deps,
      task,
      posted,
      exitInfo,
      "superseded",
      now,
      rawReviewResult,
    );
    applyCiFailRetryInOpenTxn(
      deps,
      task.task_id,
      {
        attempt_id: task.attempt_id,
        attempt_number: task.attempt_number,
        preamble_id: task.preamble_id,
      },
      snapshot,
      "pr-review",
      now,
    );
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }

  return { task_id: task.task_id, action: "ci_failed" };
}

function finalizeApprovedReviewBackToPrOpen(
  deps: TickDeps,
  task: ReviewAttemptTaskRow,
  posted: PostedReview,
  exitInfo: PaneExitInfo,
  verdict: "approved" | "superseded",
  rawReviewResult: string,
): void {
  collectReviewAttemptArtifacts(deps, task);
  const now = deps.clock.nowISO();
  deps.db.exec("BEGIN IMMEDIATE");
  try {
    const artifactId = markReviewAttemptEndedInOpenTxn(
      deps,
      task,
      posted,
      exitInfo,
      verdict,
      now,
      rawReviewResult,
    );
    transitionTaskState(deps, {
      taskId: task.task_id,
      from: "pr-review",
      to: "pr-open",
      eventType: verdict === "approved" ? "review_approved" : "review_superseded",
      attemptId: task.attempt_id,
      payloadArtifactId: artifactId,
      now,
      updates: { clearTickError: true },
    });
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

function markReviewAttemptEndedInOpenTxn(
  deps: TickDeps,
  task: ReviewAttemptTaskRow,
  posted: PostedReview,
  exitInfo: PaneExitInfo,
  verdict: "approved" | "superseded",
  now: string,
  rawReviewResult: string,
): number {
  const content = reviewArtifactContent(posted, task.head_sha);
  deps.db
    .query(
      `UPDATE attempts
          SET ended_at = ?,
              exit_kind = ?,
              exit_code = ?,
              exit_signal = ?,
              review_verdict = ?,
              review_id = ?
        WHERE attempt_id = ? AND ended_at IS NULL`,
    )
    .run(
      now,
      verdict === "approved" ? "review_approved" : "review_superseded",
      exitInfo.exitCode,
      exitInfo.exitSignal,
      verdict,
      posted.reviewId,
      task.attempt_id,
    );
  deps.db
    .query(
      `UPDATE tasks
          SET review_infra_failures_consecutive = 0,
              review_infra_failure_head_sha = NULL,
              tick_error = NULL,
              updated_at = ?
        WHERE task_id = ?`,
    )
    .run(now, task.task_id);
  deps.artifactStore.writeArtifact({
    taskId: task.task_id,
    attemptId: task.attempt_id,
    kind: "review_result",
    content: rawReviewResult,
    extension: "json",
  });
  const artifact = deps.artifactStore.writeArtifact({
    taskId: task.task_id,
    attemptId: task.attempt_id,
    kind: "review_comments",
    content,
    extension: "json",
  });
  return artifact.artifactId;
}

function finalizePostedReview(
  deps: TickDeps,
  task: ReviewAttemptTaskRow,
  posted: PostedReview,
  exitInfo: PaneExitInfo,
  options: TickOptions,
  rawReviewResult: string,
): TickTaskResult {
  collectReviewAttemptArtifacts(deps, task);
  const verdict =
    posted.decision === "APPROVED" ? "approved" : "changes_requested";
  const content = reviewArtifactContent(posted, task.head_sha);
  const now = deps.clock.nowISO();
  // CHANGES_REQUESTED on a Quay-owned task hands the rest of the work off to
  // scheduleNonBudgetRespawn (its own transaction). For every other case the
  // attempt-end, counter-reset, artifact write, task transition, and event
  // insert must all commit atomically: a crash between two transactions
  // would otherwise strand the task in pr-review with no active reviewer.
  const handOffToRespawn =
    verdict === "changes_requested" &&
    task.authoring_mode !== "synthetic_review";

  if (handOffToRespawn) {
    const snapshot = refreshPrMetadataBeforeReviewRespawn(deps, task);
    if (snapshot === null) {
      return recordTickError(
        deps,
        task.task_id,
        new Error(
          `PR snapshot unavailable for branch ${task.branch_name}; cannot schedule review respawn with the current PR base`,
        ),
      );
    }
    persistPrMetadata(deps, task.task_id, snapshot);
  }

  deps.db.exec("BEGIN IMMEDIATE");
  try {
    deps.db
      .query(
        `UPDATE attempts
            SET ended_at = ?,
                exit_kind = ?,
                exit_code = ?,
                exit_signal = ?,
                review_verdict = ?,
                review_id = ?
          WHERE attempt_id = ? AND ended_at IS NULL`,
      )
      .run(
        now,
        verdict === "approved" ? "review_approved" : "review_changes_requested",
        exitInfo.exitCode,
        exitInfo.exitSignal,
        verdict,
        posted.reviewId,
        task.attempt_id,
      );
    deps.db
      .query(
        `UPDATE tasks
            SET review_infra_failures_consecutive = 0,
                review_infra_failure_head_sha = NULL,
                tick_error = NULL,
                updated_at = ?
          WHERE task_id = ?`,
      )
      .run(now, task.task_id);

    deps.artifactStore.writeArtifact({
      taskId: task.task_id,
      attemptId: task.attempt_id,
      kind: "review_result",
      content: rawReviewResult,
      extension: "json",
    });

    if (!handOffToRespawn) {
      // Artifact write joins this transaction (the INSERT into `artifacts`
      // participates in the open BEGIN); a ROLLBACK below also rolls back
      // the artifact row. The file on disk is harmless orphan content with
      // a hash-derived name — it would be re-written byte-identical on a
      // retry of the same review.
      const artifact = deps.artifactStore.writeArtifact({
        taskId: task.task_id,
        attemptId: task.attempt_id,
        kind: "review_comments",
        content,
        extension: "json",
      });
      const toState =
        verdict === "approved" ? "done" : "waiting_external_changes";
      const eventType =
        verdict === "approved" ? "review_approved" : "changes_requested";
      const transition = transitionTaskState(deps, {
        taskId: task.task_id,
        from: "pr-review",
        to: toState,
        eventType,
        attemptId: task.attempt_id,
        payloadArtifactId: artifact.artifactId,
        now,
        updates: { clearTickError: true },
      });
      if (transition.applied && toState === "done") {
        enqueuePrReadyApprovedOutboxItem(deps, {
          taskId: task.task_id,
          sourceEventId: transition.eventId,
        });
      }
    }

    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }

  if (handOffToRespawn) {
    const cap = options.maxNonBudgetRespawns ?? DEFAULT_MAX_NON_BUDGET_RESPAWNS;
    const result = scheduleNonBudgetRespawn(deps, {
      taskId: task.task_id,
      prevAttempt: {
        attempt_id: task.attempt_id,
        attempt_number: task.attempt_number,
      },
      reason: "review",
      diagnostics: `Quay reviewer marked CHANGES_REQUESTED in review ${posted.reviewId}.`,
      fromState: "pr-review",
      snapshotKind: "review_comments",
      snapshotContent: content,
      snapshotExtension: "json",
      dedupeColumn: "last_review_id_acted_on",
      dedupeValue: posted.reviewId,
      maxNonBudgetRespawns: cap,
    });
    if (result.outcome === "parked") {
      return { task_id: task.task_id, action: "non_budget_loop_parked" };
    }
    if (result.outcome === "scheduled") {
      return { task_id: task.task_id, action: "review_respawn_scheduled" };
    }
    return { task_id: task.task_id, action: "skipped_predicate" };
  }

  return {
    task_id: task.task_id,
    action:
      verdict === "approved" ? "review_approved" : "review_changes_requested",
  };
}

function refreshPrMetadataBeforeReviewRespawn(
  deps: TickDeps,
  task: ReviewAttemptTaskRow,
): PrSnapshot | null {
  if (task.pr_number !== null) {
    const byNumber = deps.github.prLightweightSnapshotByNumber(
      task.repo_id,
      task.pr_number,
    );
    if (byNumber !== null) return byNumber;
  }
  return deps.github.prLightweightSnapshot(task.repo_id, task.branch_name);
}

function markReviewInfraFailure(
  deps: TickDeps,
  task: ReviewAttemptTaskRow,
  diagnostic: string,
  exitInfo: PaneExitInfo,
  options: TickOptions,
  rawReviewResult?: string,
): TickTaskResult {
  collectReviewAttemptArtifacts(deps, task);
  const now = deps.clock.nowISO();
  const sameSha = task.review_infra_failure_head_sha === task.head_sha;
  const failures = sameSha ? task.review_infra_failures_consecutive + 1 : 1;
  const parking = failures >= 3;
  const priorBrief = loadAttemptArtifactContent(
    deps.db,
    task.task_id,
    task.attempt_id,
    "brief",
  );
  const priorPrompt = loadAttemptArtifactContent(
    deps.db,
    task.task_id,
    task.attempt_id,
    "final_prompt",
  );

  deps.db.exec("BEGIN IMMEDIATE");
  try {
    deps.artifactStore.writeArtifact({
      taskId: task.task_id,
      attemptId: task.attempt_id,
      kind: "review_blocker",
      content: diagnostic,
      extension: "md",
    });
    if (rawReviewResult !== undefined) {
      deps.artifactStore.writeArtifact({
        taskId: task.task_id,
        attemptId: task.attempt_id,
        kind: "review_result",
        content: rawReviewResult,
        extension: "json",
      });
    }
    deps.db
      .query(
        `UPDATE attempts
            SET ended_at = ?,
                exit_kind = 'review_errored',
                exit_code = ?,
                exit_signal = ?,
                review_verdict = 'errored'
          WHERE attempt_id = ? AND ended_at IS NULL`,
      )
      .run(now, exitInfo.exitCode, exitInfo.exitSignal, task.attempt_id);
    deps.db
      .query(
        `UPDATE tasks
            SET review_infra_failures_consecutive = ?,
                review_infra_failure_head_sha = ?,
                state = ?,
                tick_error = ?,
                updated_at = ?
          WHERE task_id = ? AND state = 'pr-review'
            AND cancel_requested_at IS NULL`,
      )
      .run(
        failures,
        task.head_sha,
        parking ? "non_budget_loop" : "pr-review",
        parking ? diagnostic : null,
        now,
        task.task_id,
      );

    if (!parking) {
      const retryAttempt = deps.db
        .query<{ attempt_id: number }, [string, number, number, string, number, string]>(
          `INSERT INTO attempts (
             task_id, attempt_number, preamble_id, reason, consumed_budget, head_sha
           ) VALUES (?, ?, ?, ?, ?, ?)
           RETURNING attempt_id`,
        )
        .get(
          task.task_id,
          task.attempt_number + 1,
          task.preamble_id,
          "review_only",
          0,
          task.head_sha,
        );
      if (!retryAttempt) throw new Error("review retry insert returned no row");
      deps.artifactStore.writeArtifact({
        taskId: task.task_id,
        attemptId: retryAttempt.attempt_id,
        kind: "brief",
        content: priorBrief,
        extension: "md",
      });
      deps.artifactStore.writeArtifact({
        taskId: task.task_id,
        attemptId: retryAttempt.attempt_id,
        kind: "final_prompt",
        content: priorPrompt,
        extension: "md",
      });
    }

    deps.db
      .query(
        `INSERT INTO events (
           task_id, attempt_id, event_type, from_state, to_state, occurred_at
         ) VALUES (?, ?, 'review_infra_failed', 'pr-review', ?, ?)`,
      )
      .run(
        task.task_id,
        task.attempt_id,
        parking ? "non_budget_loop" : "pr-review",
        now,
      );
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }

  return {
    task_id: task.task_id,
    action: parking ? "non_budget_loop_parked" : "review_retry_scheduled",
  };
}

function collectReviewAttemptArtifacts(
  deps: TickDeps,
  task: ReviewAttemptTaskRow,
): void {
  const usageResult = collectUsageArtifact(
    deps,
    task.task_id,
    task.attempt_id,
    task.worktree_path,
  );
  persistResolvedAttemptModel(deps.db, task.attempt_id, usageResult.resolvedModel);
  collectToolTraceArtifact(
    deps,
    task.task_id,
    task.attempt_id,
    task.worktree_path,
  );
}

function reviewArtifactContent(posted: PostedReview, headSha: string): string {
  return JSON.stringify({
    review_id: posted.reviewId,
    decision: posted.decision,
    head_sha: headSha,
    body: posted.body,
    comments: posted.comments,
  });
}

function loadAttemptArtifactContent(
  db: DB,
  taskId: string,
  attemptId: number,
  kind: "brief" | "final_prompt",
): string {
  const row = db
    .query<{ file_path: string }, [string, number, string]>(
      `SELECT file_path FROM artifacts
        WHERE task_id = ? AND attempt_id = ? AND kind = ?
        ORDER BY artifact_id DESC
        LIMIT 1`,
    )
    .get(taskId, attemptId, kind);
  if (!row) return "";
  try {
    return readFileSync(row.file_path, "utf8");
  } catch {
    return "";
  }
}

function formatConflictObservation(snapshot: PrSnapshot): string {
  // Key on the base ref *tip*, not `baseSha` (which is the merge-base — stable
  // across base advances by construction). Keying on the tip means a base
  // advance that may have worsened the conflict re-enters the respawn path
  // even when head is unchanged. Fall back to `baseSha` when the tip is
  // unavailable (unfetched base, older gh) so the key still has *some* base
  // component rather than collapsing to head-only.
  const base = snapshot.baseTipSha ?? snapshot.baseSha ?? "";
  return `${snapshot.headSha}:${base}`;
}

// COALESCE-write so a snapshot with a missing field (older gh, transient
// failure of the merge-base shell-out) never overwrites a previously
// captured value with NULL. head_sha follows the same pattern: if the
// snapshot returns it, we accept the new value (force-pushes legitimately
// rotate it); if not, we keep what's there.
function persistPrMetadata(
  deps: TickDeps,
  taskId: string,
  snapshot: PrSnapshot,
): void {
  const prNumber = snapshot.prNumber ?? null;
  const prUrl = snapshot.prUrl ?? null;
  const prTitle = snapshot.prTitle ?? null;
  const headSha = snapshot.headSha === "" ? null : snapshot.headSha;
  const baseSha = snapshot.baseSha;
  const baseRef = normalizePrBaseRef(snapshot.baseRef);
  if (
    prNumber === null &&
    prUrl === null &&
    prTitle === null &&
    headSha === null &&
    baseSha === null &&
    baseRef === null
  ) {
    return;
  }
  try {
    deps.db
      .query(
        `UPDATE tasks
            SET pr_number = COALESCE(?, pr_number),
                pr_url    = COALESCE(?, pr_url),
                pr_title  = COALESCE(?, pr_title),
                head_sha  = COALESCE(?, head_sha),
                base_sha  = COALESCE(?, base_sha),
                base_branch = COALESCE(?, base_branch)
          WHERE task_id = ?`,
      )
      .run(prNumber, prUrl, prTitle, headSha, baseSha, baseRef, taskId);
  } catch {
    // Best-effort: PR-metadata observability never blocks the state
    // machine. A SQL failure here will be retried on the next tick.
  }
}

function normalizePrBaseRef(baseRef: string | null | undefined): string | null {
  const trimmed = baseRef?.trim();
  if (trimmed === undefined || trimmed.length === 0) return null;
  return baseBranchNameSchema.safeParse(trimmed).success ? trimmed : null;
}

function loadRepoForTask(
  db: DB,
  taskId: string,
): ({ ci_workflow_name: string | null } & RepoCiIgnorePolicy) | null {
  const row = db
    .query<{
      ci_workflow_name: string | null;
      ci_ignore_mode: CiIgnoreMode;
      ci_ignored_check_names: string;
      ci_ignored_workflow_names: string;
    }, [string]>(
      `SELECT r.ci_workflow_name AS ci_workflow_name,
              r.ci_ignore_mode AS ci_ignore_mode,
              r.ci_ignored_check_names AS ci_ignored_check_names,
              r.ci_ignored_workflow_names AS ci_ignored_workflow_names
         FROM tasks t JOIN repos r ON r.repo_id = t.repo_id
        WHERE t.task_id = ?`,
    )
    .get(taskId);
  if (row === undefined || row === null) return null;
  return {
    ci_workflow_name: row.ci_workflow_name,
    ci_ignore_mode: row.ci_ignore_mode,
    ignored_check_names: parseCiIgnoreListJson(row.ci_ignored_check_names),
    ignored_workflow_names: parseCiIgnoreListJson(row.ci_ignored_workflow_names),
  };
}

function processClaimedTask(
  deps: TickDeps,
  task: ClaimedTaskRow,
  options: TickOptions,
): TickTaskResult | null {
  // Cancel intent is the slice-7 finalizer's responsibility; skip cleanly.
  if (task.cancel_requested_at !== null) return null;
  if (task.claimed_at === null) return null;

  const claimTimeoutSeconds =
    options.claimTimeoutSeconds ?? DEFAULT_CLAIM_TIMEOUT_SECONDS;
  const maxClaimExpirations =
    options.maxClaimExpirations ?? DEFAULT_MAX_CLAIM_EXPIRATIONS;

  const nowMs = Date.parse(deps.clock.nowISO());
  const claimedMs = Date.parse(task.claimed_at);
  if (nowMs - claimedMs <= claimTimeoutSeconds * 1000) return null;

  const now = deps.clock.nowISO();
  const newCount = task.claim_expirations_consecutive + 1;
  const parking = newCount >= maxClaimExpirations;
  const targetState = parking ? "orchestrator_loop" : "awaiting-next-brief";

  deps.db.exec("BEGIN IMMEDIATE");
  try {
    const upd = deps.db
      .query(
        `UPDATE tasks
            SET state = ?,
                claim_id = NULL,
                claimed_at = NULL,
                claim_expirations_consecutive = ?,
                tick_error = NULL,
                updated_at = ?
          WHERE task_id = ?
            AND state = 'claimed-by-orchestrator'
            AND cancel_requested_at IS NULL`,
      )
      .run(targetState, newCount, now, task.task_id);
    const changes = (upd as { changes?: number }).changes ?? 0;
    if (changes === 0) {
      deps.db.exec("ROLLBACK");
      return null;
    }
    deps.db
      .query(
        `INSERT INTO events (
           task_id, event_type, from_state, to_state, occurred_at
         ) VALUES (?, 'claim_expired', 'claimed-by-orchestrator', ?, ?)`,
      )
      .run(task.task_id, targetState, now);
    if (parking) {
      cancelOpenOrchestratorHandoffs(deps, task.task_id);
      deps.db
        .query(
          `INSERT INTO events (
             task_id, event_type, from_state, to_state, occurred_at
           ) VALUES (?, 'orchestrator_loop_parked', 'claimed-by-orchestrator', 'orchestrator_loop', ?)`,
        )
        .run(task.task_id, now);
    } else {
      reopenClaimedOrchestratorHandoffs(deps, {
        taskId: task.task_id,
        claimId: task.claim_id,
      });
    }
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }

  return {
    task_id: task.task_id,
    action: parking ? "orchestrator_loop_parked" : "claim_expired",
  };
}

interface EscalationArtifactRow {
  artifact_id: number;
  attempt_id: number | null;
  task_id: string;
  escalation_seq: number | null;
  escalation_nonce: string | null;
  content_hash: string | null;
  slack_pre_post_fence_ts: string | null;
  slack_post_ts: string | null;
  slack_recovered_post_ts: string | null;
  file_path: string;
}

function loadLatestEscalationArtifact(
  db: DB,
  taskId: string,
): EscalationArtifactRow | null {
  return (
    db
      .query<EscalationArtifactRow, [string]>(
        `SELECT artifact_id, attempt_id, task_id, escalation_seq,
                escalation_nonce, content_hash, slack_pre_post_fence_ts,
                slack_post_ts, slack_recovered_post_ts, file_path
           FROM artifacts
          WHERE task_id = ? AND kind = 'slack_escalation_post'
          ORDER BY artifact_id DESC LIMIT 1`,
      )
      .get(taskId) ?? null
  );
}

async function processWaitingHumanTask(
  deps: TickDeps,
  task: WaitingHumanTaskRow,
  linearSyncs: LinearSyncQueue,
): Promise<TickTaskResult[]> {
  if (task.cancel_requested_at !== null) return [];
  if (task.claim_id !== null) {
    // New human-advice flow: the orchestrator owns Slack posting, waiting,
    // reply capture, and follow-up brief submission while holding the claim.
    return [];
  }

  const art = loadLatestEscalationArtifact(deps.db, task.task_id);
  if (task.slack_thread_ref === null) {
    const migrated = requeueLegacyWaitingHumanWithoutThread(
      deps,
      task,
      art,
      linearSyncs,
    );
    return migrated === null ? [] : [migrated];
  }

  if (!art || art.attempt_id === null || art.escalation_nonce === null) {
    return [];
  }

  const results: TickTaskResult[] = [];
  const threadRef = task.slack_thread_ref;

  // Step 1: capture the pre-post fence if not yet captured.
  if (art.slack_pre_post_fence_ts === null) {
    const fenceTs = await deps.slack.fenceTs(threadRef);
    const upd = deps.db
      .query(
        `UPDATE artifacts
            SET slack_pre_post_fence_ts = ?
          WHERE artifact_id = ?
            AND slack_pre_post_fence_ts IS NULL`,
      )
      .run(fenceTs, art.artifact_id);
    const changed = (upd as { changes?: number }).changes ?? 0;
    if (changed > 0) {
      art.slack_pre_post_fence_ts = fenceTs;
      results.push({ task_id: task.task_id, action: "slack_fence_captured" });
    }
  }

  // Step 2: try to recover an existing post via the nonce.
  if (art.slack_recovered_post_ts === null) {
    const match = await deps.slack.searchByNonce(threadRef, art.escalation_nonce);
    if (match !== null) {
      // Persist recovered ts (and slack_post_ts if NULL) in one txn.
      // Predicate: cancel_requested_at IS NULL on the task row.
      deps.db.exec("BEGIN IMMEDIATE");
      try {
        const guard = deps.db
          .query<{ n: number }, [string]>(
            `SELECT 1 AS n FROM tasks
              WHERE task_id = ?
                AND state = 'waiting_human'
                AND claim_id IS NULL
                AND cancel_requested_at IS NULL`,
          )
          .get(task.task_id);
        if (!guard) {
          deps.db.exec("ROLLBACK");
          return results;
        }
        deps.db
          .query(
            `UPDATE artifacts
                SET slack_recovered_post_ts = ?,
                    slack_post_ts = COALESCE(slack_post_ts, ?)
              WHERE artifact_id = ?
                AND slack_recovered_post_ts IS NULL`,
          )
          .run(match.ts, match.ts, art.artifact_id);
        deps.db.exec("COMMIT");
        art.slack_recovered_post_ts = match.ts;
        if (art.slack_post_ts === null) art.slack_post_ts = match.ts;
        clearTickError(deps, task.task_id);
        results.push({ task_id: task.task_id, action: "slack_post_recovered" });
        fireFailpoint("after_slack_recovery_ts_commit");
      } catch (err) {
        try {
          deps.db.exec("ROLLBACK");
        } catch {}
        throw err;
      }
    }
  }

  // Step 3: post if no recovery match and no post yet.
  if (art.slack_post_ts === null && art.slack_recovered_post_ts === null) {
    const body = readEscalationBody(art.file_path);
    const mentionPrefix = buildMentionPrefix(task.authors_json);
    const composedBody = `${mentionPrefix}${body}\n\n_${art.escalation_nonce}_`;
    let postTs: string;
    try {
      postTs = (await deps.slack.post({ threadRef, body: composedBody })).ts;
    } catch (err) {
      // Slack API failure: log tick_error and skip; next tick retries.
      // The artifact stays without slack_post_ts so the recovery loop
      // re-enters here on the next tick.
      results.push(recordTickError(deps, task.task_id, err));
      return results;
    }
    fireFailpoint("after_slack_post");
    deps.db.exec("BEGIN IMMEDIATE");
    try {
      const guard = deps.db
        .query<{ n: number }, [string]>(
          `SELECT 1 AS n FROM tasks
            WHERE task_id = ?
              AND state = 'waiting_human'
              AND claim_id IS NULL
              AND cancel_requested_at IS NULL`,
        )
        .get(task.task_id);
      if (!guard) {
        deps.db.exec("ROLLBACK");
        return results;
      }
      deps.db
        .query(
          `UPDATE artifacts
              SET slack_post_ts = ?,
                  slack_recovered_post_ts = ?
            WHERE artifact_id = ?
              AND slack_post_ts IS NULL`,
        )
        .run(postTs, postTs, art.artifact_id);
      deps.db.exec("COMMIT");
      art.slack_post_ts = postTs;
      art.slack_recovered_post_ts = postTs;
      clearTickError(deps, task.task_id);
      results.push({ task_id: task.task_id, action: "slack_posted" });
    } catch (err) {
      try {
        deps.db.exec("ROLLBACK");
      } catch {}
      throw err;
    }
    return results;
  }

  // Step 4: ingest replies. Lower bound is recovered ts when known, else
  // the pre-post fence.
  const lowerBound =
    art.slack_recovered_post_ts !== null
      ? art.slack_recovered_post_ts
      : art.slack_pre_post_fence_ts;
  if (lowerBound === null) {
    return results;
  }
  const replies = await deps.slack.listReplies(threadRef, lowerBound);
  const lb = Number(lowerBound);
  const firstNonBot = replies.find(
    (r) => !r.authorBot && Number(r.ts) > lb,
  );
  if (!firstNonBot) {
    clearTickError(deps, task.task_id);
    if (results.length === 0) results.push({ task_id: task.task_id, action: "slack_skipped" });
    return results;
  }

  ingestSlackReply(deps, task, art, firstNonBot, linearSyncs);
  results.push({ task_id: task.task_id, action: "slack_reply_ingested" });
  return results;
}

function requeueLegacyWaitingHumanWithoutThread(
  deps: TickDeps,
  task: WaitingHumanTaskRow,
  art: EscalationArtifactRow | null,
  linearSyncs: LinearSyncQueue,
): TickTaskResult | null {
  const now = deps.clock.nowISO();
  deps.db.exec("BEGIN IMMEDIATE");
  try {
    const upd = deps.db
      .query(
        `UPDATE tasks
            SET state = 'awaiting-next-brief',
                tick_error = NULL,
                updated_at = ?
          WHERE task_id = ?
            AND state = 'waiting_human'
            AND claim_id IS NULL
            AND slack_thread_ref IS NULL
            AND cancel_requested_at IS NULL`,
      )
      .run(now, task.task_id);
    const changed = (upd as { changes?: number }).changes ?? 0;
    if (changed === 0) {
      deps.db.exec("ROLLBACK");
      return null;
    }

    const eventRow = deps.db
      .query<{ event_id: number }, [string, number | null, string]>(
        `INSERT INTO events (
           task_id, event_type, from_state, to_state,
           payload_artifact_id, occurred_at
         ) VALUES (?, 'waiting_human_requeued', 'waiting_human', 'awaiting-next-brief', ?, ?)
         RETURNING event_id`,
      )
      .get(task.task_id, art?.artifact_id ?? null, now);
    if (!eventRow) throw new Error("waiting_human_requeued event insert returned no row");

    enqueueOrchestratorHandoff(deps, {
      taskId: task.task_id,
      reason: "manual_resume",
      stateEventId: eventRow.event_id,
      payload: {
        previous_state: "waiting_human",
        reason: "missing_slack_thread_ref",
        ...(art === null ? {} : { escalation_artifact_id: art.artifact_id }),
      },
    });

    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }

  linearSyncs.enqueue(task.external_ref, LINEAR_STATE_IN_PROGRESS);
  return { task_id: task.task_id, action: "waiting_human_requeued" };
}

// Bare Slack user-ID format, identical to the parser's check
// (src/core/quay_config_block.ts). Re-validated at the sink: `authors_json`
// is opaque text in the DB, so a tampered or future-malformed payload must
// not reach Slack mrkdwn — `<@!channel>` and similar shapes would render
// as a different control directive than a user mention.
const SLACK_USER_ID = /^U[A-Z0-9]+$/;

// Prepend `<@slack_id>` mentions for every author the adapter recorded on
// enqueue. Returns "" for legacy tasks (`authors_json IS NULL`), an empty
// array, or any malformed payload — the post path falls back to the
// unprefixed body in those cases. IDs that don't match the bare Slack
// user-ID shape are dropped (defense-in-depth against persisted-data
// tampering); if every ID is invalid, the prefix collapses to "".
function buildMentionPrefix(authorsJson: string | null): string {
  if (authorsJson === null) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(authorsJson);
  } catch {
    return "";
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return "";
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const a of parsed) {
    if (
      a === null ||
      typeof a !== "object" ||
      typeof (a as { slack_id?: unknown }).slack_id !== "string"
    ) {
      continue;
    }
    const id = (a as { slack_id: string }).slack_id;
    if (!SLACK_USER_ID.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length === 0) return "";
  return `${ids.map((id) => `<@${id}>`).join(" ")}\n\n`;
}

function readEscalationBody(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `unable to read slack_escalation_post artifact at ${filePath}: ${message}`,
    );
  }
}

function ingestSlackReply(
  deps: TickDeps,
  task: WaitingHumanTaskRow,
  art: EscalationArtifactRow,
  reply: { ts: string; authorBot: boolean; text: string },
  linearSyncs: LinearSyncQueue,
): void {
  const attemptId = art.attempt_id!;
  const replyContent = JSON.stringify({
    ts: reply.ts,
    text: reply.text,
    authorBot: reply.authorBot,
  });
  const replyContentHash = createHash("sha256").update(replyContent).digest("hex");

  const now = deps.clock.nowISO();
  deps.db.exec("BEGIN IMMEDIATE");
  try {
    const guard = deps.db
      .query<{ n: number }, [string]>(
        `SELECT 1 AS n FROM tasks
          WHERE task_id = ?
            AND state = 'waiting_human'
            AND claim_id IS NULL
            AND cancel_requested_at IS NULL`,
      )
      .get(task.task_id);
    if (!guard) {
      deps.db.exec("ROLLBACK");
      return;
    }

    const artifact = deps.artifactStore.writeArtifact({
      taskId: task.task_id,
      attemptId,
      kind: "slack_reply",
      content: replyContent,
      extension: "json",
    });
    // Set the explicit content_hash so it matches what the recovery-path
    // partial unique index expects (the artifact store already wrote it,
    // but content_hash can also act as the cursor for downstream reads).
    deps.db
      .query(`UPDATE artifacts SET content_hash = ? WHERE artifact_id = ?`)
      .run(replyContentHash, artifact.artifactId);

    const upd = deps.db
      .query(
        `UPDATE tasks
            SET state = 'awaiting-next-brief',
                tick_error = NULL,
                updated_at = ?
          WHERE task_id = ?
            AND state = 'waiting_human'
            AND claim_id IS NULL
            AND cancel_requested_at IS NULL`,
      )
      .run(now, task.task_id);
    const changed = (upd as { changes?: number }).changes ?? 0;
    if (changed === 0) {
      deps.db.exec("ROLLBACK");
      return;
    }

    const eventRow = deps.db
      .query<{ event_id: number }, [string, number, number, string]>(
        `INSERT INTO events (
           task_id, attempt_id, event_type, from_state, to_state,
           payload_artifact_id, occurred_at
         ) VALUES (?, ?, 'slack_reply_ingested', 'waiting_human', 'awaiting-next-brief', ?, ?)
         RETURNING event_id`,
      )
      .get(task.task_id, attemptId, artifact.artifactId, now);
    if (!eventRow) throw new Error("slack_reply_ingested event insert returned no row");
    enqueueOrchestratorHandoff(deps, {
      taskId: task.task_id,
      reason: "human_reply_ingested",
      stateEventId: eventRow.event_id,
      payload: {
        attempt_id: attemptId,
        artifact_id: artifact.artifactId,
        slack_reply_content_hash: replyContentHash,
      },
    });

    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }

  // Reaching this line implies the commit landed: every early-return guard
  // above exits before this point, and the catch block re-throws. Concurrent
  // writers that lose the UPDATE race took the early-return branch and
  // never get here.
  linearSyncs.enqueue(task.external_ref, LINEAR_STATE_IN_PROGRESS);
}

function loadLatestAttempt(db: DB, taskId: string): CurrentAttemptRow | null {
  return (
    db
      .query<CurrentAttemptRow, [string]>(
        `SELECT attempt_id, attempt_number, preamble_id,
                template_id, reason, consumed_budget,
                remote_sha_at_spawn, pr_existed_at_spawn, tmux_session,
                spawned_at, kill_intent, goal_id, goal_report_processed_at
           FROM attempts
          WHERE task_id = ?
          ORDER BY attempt_id DESC
          LIMIT 1`,
      )
      .get(taskId) ?? null
  );
}

function detectKillIntent(
  deps: TickDeps,
  task: { worktree_path: string },
  attempt: {
    spawned_at: string | null;
    tmux_session: string | null;
  },
  options: TickOptions,
): "wall_clock" | "stale" | null {
  if (attempt.spawned_at === null || attempt.tmux_session === null) return null;
  const nowMs = Date.parse(deps.clock.nowISO());
  const spawnedMs = Date.parse(attempt.spawned_at);
  const maxAttemptSeconds =
    options.maxAttemptDurationSeconds ?? DEFAULT_MAX_ATTEMPT_DURATION_SECONDS;
  if (nowMs - spawnedMs > maxAttemptSeconds * 1000) return "wall_clock";

  const freshMs = Date.parse(
    deps.tmux.logFreshness(
      attempt.tmux_session,
      task.worktree_path,
      attempt.spawned_at,
    ),
  );
  const stalenessSeconds =
    options.stalenessThresholdSeconds ?? DEFAULT_STALENESS_THRESHOLD_SECONDS;
  if (nowMs - freshMs > stalenessSeconds * 1000) return "stale";
  return null;
}

function setKillIntent(
  deps: TickDeps,
  task: { task_id: string; worktree_path: string },
  attempt: {
    attempt_id: number;
    spawned_at: string | null;
    tmux_session: string | null;
  },
  intent: "wall_clock" | "stale",
): void {
  const now = deps.clock.nowISO();
  // Spawned-at is non-null on every running attempt (promotion sets it
  // before tmux_session); fall back to `now` defensively to keep the
  // event_data fields populated even if invariants slip in the future.
  const spawnedAt = attempt.spawned_at ?? now;
  const spawnedSecondsAgo = Math.max(
    0,
    Math.floor((Date.parse(now) - Date.parse(spawnedAt)) / 1000),
  );
  // For stale, the operator's diagnostic question is "what was the most
  // recent log byte mtime when we decided?" — captured here so the event
  // row is self-sufficient without a separate journal lookup.
  const lastLogAt =
    intent === "stale" && attempt.tmux_session !== null
      ? safeLogFreshness(deps, attempt.tmux_session, task.worktree_path, spawnedAt)
      : null;
  const eventData = JSON.stringify({
    intent,
    spawned_seconds_ago: spawnedSecondsAgo,
    ...(lastLogAt !== null ? { last_log_at: lastLogAt } : {}),
  });
  deps.db.exec("BEGIN");
  try {
    deps.db
      .query(
        `UPDATE attempts SET kill_intent = ? WHERE attempt_id = ? AND kill_intent IS NULL`,
      )
      .run(intent, attempt.attempt_id);
    deps.db
      .query(
        `INSERT INTO events (task_id, attempt_id, event_type, occurred_at, event_data)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        task.task_id,
        attempt.attempt_id,
        intent === "wall_clock" ? "wall_clock_exceeded" : "stale_detected",
        now,
        eventData,
      );
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

function safeLogFreshness(
  deps: TickDeps,
  sessionName: string,
  worktreePath: string,
  spawnedAt: string,
): string | null {
  try {
    return deps.tmux.logFreshness(sessionName, worktreePath, spawnedAt);
  } catch {
    return null;
  }
}

function finalizeKillIntent(
  deps: TickDeps,
  task: RunningTaskRow,
  attempt: CurrentAttemptRow,
  reason: "wall_clock" | "stale",
  exitInfo: PaneExitInfo,
): void {
  if (attempt.tmux_session) {
    try {
      const log = deps.tmux.collectLog(
        attempt.tmux_session,
        task.worktree_path,
      );
      if (log !== null) {
        deps.artifactStore.writeArtifact({
          taskId: task.task_id,
          attemptId: attempt.attempt_id,
          kind: "session_log",
          content: log,
          extension: "txt",
        });
      }
    } catch {}
  }
  // Best-effort usage + tool-trace capture. A wall-clock kill mid-run
  // typically truncates `--output-format json` output (malformed
  // envelope, dropped), but the streaming `--debug-file` log already
  // has whatever events landed before the kill — so even killed
  // attempts usually produce a useful tool_trace. Clean exits racing
  // with a kill window produce a complete envelope and trace.
  const usageResult = collectUsageArtifact(
    deps,
    task.task_id,
    attempt.attempt_id,
    task.worktree_path,
  );
  persistResolvedAttemptModel(deps.db, attempt.attempt_id, usageResult.resolvedModel);
  collectToolTraceArtifact(deps, task.task_id, attempt.attempt_id, task.worktree_path);

  const now = deps.clock.nowISO();
  deps.db.exec("BEGIN");
  try {
    deps.db
      .query(
        `UPDATE attempts
            SET exit_kind = ?,
                ended_at = ?,
                kill_intent = NULL,
                exit_code = ?,
                exit_signal = ?
          WHERE attempt_id = ? AND ended_at IS NULL`,
      )
      .run(
        reason === "wall_clock" ? "killed_wall_clock" : "killed_stale",
        now,
        exitInfo.exitCode,
        exitInfo.exitSignal,
        attempt.attempt_id,
      );
    const diagnostics =
      reason === "wall_clock"
        ? "The live worker exceeded max_attempt_duration_seconds and was killed."
        : "The live worker stopped producing fresh logs past staleness_threshold_seconds and was killed.";
    const goalLimit = accountGoalFailureAndMaybeLimit(deps, {
      taskId: task.task_id,
      attemptId: attempt.attempt_id,
      goalId: attempt.goal_id,
      spawnedAt: attempt.spawned_at,
      endedAt: now,
      fromState: "running",
      diagnostics,
    });
    if (goalLimit.budgetLimited) {
      deps.db.exec("COMMIT");
      return;
    }
    scheduleDeterministicRetry(deps, {
      taskId: task.task_id,
      prevAttempt: attempt,
      reason,
      diagnostics,
      fromState: "running",
    });
    deps.db
      .query(
        `INSERT INTO events (
           task_id, attempt_id, event_type, from_state, to_state, occurred_at
         ) VALUES (?, ?, ?, 'running', (SELECT state FROM tasks WHERE task_id = ?), ?)`,
      )
      .run(
        task.task_id,
        attempt.attempt_id,
        reason === "wall_clock" ? "wall_clock_killed" : "stale_killed",
        task.task_id,
        now,
      );
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

function handleSpawnFailure(
  deps: TickDeps,
  task: RunningTaskRow,
  attempt: CurrentAttemptRow,
  options: TickOptions,
): TickTaskResult {
  const now = deps.clock.nowISO();
  const maxSpawnFailures =
    options.maxSpawnFailures ?? DEFAULT_MAX_SPAWN_FAILURES;
  deps.db.exec("BEGIN");
  try {
    deps.db
      .query(
        `UPDATE attempts
            SET exit_kind = 'spawn_failed',
                ended_at = ?
          WHERE attempt_id = ? AND ended_at IS NULL`,
      )
      .run(now, attempt.attempt_id);
    const updated = deps.db
      .query<{ n: number }, [number, string, string]>(
        `UPDATE tasks
            SET attempts_consumed = attempts_consumed - ?,
                spawn_failures_consecutive = spawn_failures_consecutive + 1,
                tick_error = NULL,
                updated_at = ?
          WHERE task_id = ?
          RETURNING spawn_failures_consecutive AS n`,
      )
      .get(attempt.consumed_budget, now, task.task_id);
    const failures = updated?.n ?? 0;
    if (failures >= maxSpawnFailures) {
      deps.db
        .query(`UPDATE tasks SET state = 'worktree_error' WHERE task_id = ?`)
        .run(task.task_id);
      deps.db
        .query(
          `INSERT INTO events (
             task_id, attempt_id, event_type, from_state, to_state, occurred_at
           ) VALUES (?, ?, 'worktree_error', 'running', 'worktree_error', ?)`,
        )
        .run(task.task_id, attempt.attempt_id, now);
    } else {
      scheduleCleanSpawnRetry(deps, { taskId: task.task_id, prevAttempt: attempt });
      deps.db
        .query(
          `INSERT INTO events (
             task_id, attempt_id, event_type, from_state, to_state, occurred_at
           ) VALUES (?, ?, 'spawn_failed', 'running', 'queued', ?)`,
        )
        .run(task.task_id, attempt.attempt_id, now);
    }
    deps.db.exec("COMMIT");
    return { task_id: task.task_id, action: "spawn_failed" };
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

function countRunning(db: DB): number {
  const row = db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM tasks WHERE state = 'running'`,
    )
    .get();
  return row?.n ?? 0;
}

function countRunningReviewers(db: DB): number {
  const row = db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM attempts
        WHERE reason = 'review_only'
          AND spawned_at IS NOT NULL
          AND ended_at IS NULL`,
    )
    .get();
  return row?.n ?? 0;
}

// Closes the crash window between enterReview's COMMIT (which marks the
// attempt ended + kill_intent='superseded') and its tmux.kill call. After
// COMMIT the row falls out of every active-attempt view, so without this
// sweep the worker would keep running and could still post a review for the
// stale head SHA. We scan every tick for review-only attempts that have a
// recorded tmux session, a non-null kill_intent, and ended_at IS NOT NULL,
// then kill any session that's still alive. Idempotent: a dead session is a
// no-op, and once killed the row stays ended.
function reapAbandonedReviewers(deps: TickDeps): void {
  const rows = deps.db
    .query<{ tmux_session: string }, []>(
      `SELECT tmux_session FROM attempts
        WHERE reason = 'review_only'
          AND tmux_session IS NOT NULL
          AND kill_intent IS NOT NULL
          AND ended_at IS NOT NULL`,
    )
    .all();
  for (const row of rows) {
    if (!deps.tmux.isAlive(row.tmux_session)) continue;
    try {
      deps.tmux.kill(row.tmux_session);
    } catch {}
  }
}

function loadPendingAttempt(db: DB, taskId: string): PendingAttemptRow | null {
  return (
    db
      .query<PendingAttemptRow, [string]>(
        `SELECT attempt_id, attempt_number, consumed_budget, preamble_id
           FROM attempts
          WHERE task_id = ? AND spawned_at IS NULL AND ended_at IS NULL`,
      )
      .get(taskId) ?? null
  );
}

function loadFinalPrompt(db: DB, taskId: string, attemptId: number): string {
  const row = db
    .query<{ file_path: string }, [string, number]>(
      `SELECT file_path FROM artifacts
         WHERE task_id = ? AND attempt_id = ? AND kind = 'final_prompt'
         ORDER BY artifact_id DESC LIMIT 1`,
    )
    .get(taskId, attemptId);
  if (!row) {
    throw new Error(`missing final_prompt artifact for task ${taskId} attempt ${attemptId}`);
  }
  try {
    return readFileSync(row.file_path, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`unable to read final_prompt artifact for task ${taskId} attempt ${attemptId}: ${message}`);
  }
}

function wasReleasedFromDependencies(db: DB, taskId: string): boolean {
  const row = db
    .query<{ n: number }, [string]>(
      `SELECT 1 AS n
         FROM events
        WHERE task_id = ?
          AND event_type IN ('dependencies_satisfied', 'dependency_satisfied')
        LIMIT 1`,
    )
    .get(taskId);
  return row != null;
}

function refreshDependencyReleasedWorktreeIfNeeded(
  deps: TickDeps,
  task: QueuedTaskRow,
  pending: PendingAttemptRow,
  remoteSha: string | null,
  prExisted: 0 | 1,
  now: string,
): TickTaskResult | null {
  if (pending.attempt_number !== 1) return null;
  if (remoteSha !== null || prExisted !== 0) return null;
  if (!wasReleasedFromDependencies(deps.db, task.task_id)) return null;

  try {
    const repo = loadWorktreeDependencyRepo(deps.db, task.repo_id);
    deps.git.fetch(task.repo_id, task.base_branch);
    deps.git.worktreeRemove(task.worktree_path);
    deps.git.worktreeAddExistingBranch(
      task.repo_id,
      task.worktree_path,
      task.branch_name,
      `origin/${task.base_branch}`,
    );
    installWorktreeDependencies(deps.commandRunner, repo, task.worktree_path);
  } catch (err) {
    return {
      task_id: task.task_id,
      action: "spawn_substrate_failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  deps.db
    .query(
      `INSERT INTO events (task_id, event_type, occurred_at, event_data)
       VALUES (?, 'worktree_refreshed', ?, ?)`,
    )
    .run(
      task.task_id,
      now,
      JSON.stringify({
        reason: "dependencies_satisfied",
        branch_name: task.branch_name,
        base_ref: `origin/${task.base_branch}`,
        worktree_path: task.worktree_path,
      }),
    );
  return null;
}

function promoteAndSpawn(
  deps: TickDeps,
  task: QueuedTaskRow,
  agentResolver: AgentResolver,
  linearSyncs: LinearSyncQueue,
  options: TickOptions,
): TickTaskResult {
  const {
    agent: agentName,
    model: agentModel,
    invocation: agentInvocation,
  } = agentResolver.resolve(task.repo_id, "worker", {
    agent: task.worker_agent,
    model: task.worker_model,
  });
  if (task.cancel_requested_at !== null) {
    return { task_id: task.task_id, action: "skipped_predicate" };
  }

  const pending = loadPendingAttempt(deps.db, task.task_id);
  if (!pending) {
    return { task_id: task.task_id, action: "skipped_no_pending_attempt" };
  }
  const promptContent = loadFinalPrompt(deps.db, task.task_id, pending.attempt_id);

  // Refresh the remote branch ref and snapshot spawn-time inputs *before* the
  // promotion transaction. These reads are external; we don't want them inside
  // the SQL transaction that flips state.
  //
  // For a brand-new task the worker has not pushed `quay/<slug>` yet, so the
  // remote ref legitimately doesn't exist. `fetchBranchIfExists` tolerates
  // that case and lets `remoteHeadSha` return null — the spec records
  // `remote_sha_at_spawn = null` for the first attempt, so a missing remote
  // is the *expected* state, not a tick error.
  // Probe agent identity and compute the canonical session name BEFORE the
  // promotion transaction so the `spawned` event can carry both in
  // `event_data`. The probe is documented as in-process and never throws;
  // computing the session name from `tmux_id` + `attempt_number` is pure.
  // Persisting `attempts.agent_identity` still happens AFTER spawn succeeds
  // (paired with `tmux_session`) — this earlier probe is event-only.
  const sessionName = `quay-task-${task.tmux_id}-${pending.attempt_number}`;
  const agentIdentity = probeAgentIdentity(agentInvocation);
  const githubToken = resolveGithubActorToken("worker", deps, task.repo_id, options);
  if (!githubToken.ok) {
    return {
      task_id: task.task_id,
      action: "spawn_substrate_failed",
      error: githubToken.error,
    };
  }
  deps.git.fetchBranchIfExists(task.repo_id, task.branch_name);
  const remoteSha = deps.git.remoteHeadSha(task.repo_id, task.branch_name);
  const prExisted = deps.github.prExistsForBranchWithToken(
    task.repo_id,
    task.branch_name,
    githubToken.token,
  )
    ? 1
    : 0;
  const now = deps.clock.nowISO();
  const refreshResult = refreshDependencyReleasedWorktreeIfNeeded(
    deps,
    task,
    pending,
    remoteSha,
    prExisted,
    now,
  );
  if (refreshResult !== null) return refreshResult;

  const spawnEnv = addCodexLaunchIsolation(
    githubToken.env,
    task.worktree_path,
    task.task_id,
    agentName,
    agentInvocation,
    options.env ?? process.env,
  ) ?? {};

  const promoted = runPromotionTransaction(deps.db, {
    taskId: task.task_id,
    attemptId: pending.attempt_id,
    attemptNumber: pending.attempt_number,
    branchName: task.branch_name,
    worktreePath: task.worktree_path,
    plannedSession: sessionName,
    agentIdentity,
    agentName,
    agentModel,
    consumedBudget: pending.consumed_budget,
    spawnedAt: now,
    remoteSha,
    prExisted,
    githubTokenSource: githubToken.source,
  });
  if (!promoted) {
    return { task_id: task.task_id, action: "skipped_predicate" };
  }

  // Substrate work happens outside the transaction. If spawn throws, the row
  // stays in (state = running, tmux_session = NULL); the slice-4 spawn-window
  // classifier recovers via the canonical session name.
  try {
    deps.tmux.spawn({
      sessionName,
      worktreePath: task.worktree_path,
      promptContent,
      agentInvocation,
      env: spawnEnv,
      ...(githubToken.envFiles !== undefined
        ? { envFiles: githubToken.envFiles }
        : {}),
    });
  } catch (err) {
    return {
      task_id: task.task_id,
      action: "spawn_substrate_failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Test-only failpoint: tmux session created, attempts.tmux_session not yet
  // recorded. Lets tests exercise the spawn-window recovery branch
  // deterministically.
  fireFailpoint("after_tmux_session_created");

  // Record session AFTER successful substrate spawn so the spawn-failure
  // window (running + tmux_session NULL) is real. Resetting
  // spawn_failures_consecutive here (and not inside the promotion txn) is
  // load-bearing: a substrate failure between promotion and this point must
  // leave the consecutive counter intact so it can accumulate across ticks.
  //
  // agent_identity is paired with tmux_session — both columns reflect what
  // the substrate actually accepted, so they're written together. The
  // earlier probe at promotion time only feeds the `spawned` event_data;
  // a spawn-failure leaves the column NULL.
  deps.db
    .query(
      `UPDATE attempts
          SET tmux_session = ?, agent_identity = ?, agent_name = ?, agent_model = ?
        WHERE attempt_id = ?`,
    )
    .run(sessionName, agentIdentity, agentName, agentModel, pending.attempt_id);
  deps.db
    .query(`UPDATE tasks SET spawn_failures_consecutive = 0 WHERE task_id = ?`)
    .run(task.task_id);

  linearSyncs.enqueue(task.external_ref, LINEAR_STATE_IN_PROGRESS);

  return { task_id: task.task_id, action: "spawned" };
}

type GithubActor = "worker" | "reviewer";

type GithubActorTokenResult =
  | {
      ok: true;
      env?: TmuxSpawnInput["env"];
      envFiles?: TmuxSpawnInput["envFiles"];
      token: string;
      source: string;
    }
  | { ok: false; error: string };

type GithubActorTokenProbeResult = { ok: true } | { ok: false; error: string };

function resolveGithubActorToken(
  actor: GithubActor,
  deps: TickDeps,
  repoId: string,
  options: TickOptions,
): GithubActorTokenResult {
  const env = options.env ?? process.env;
  const envName =
    actor === "worker" ? WORKER_GH_TOKEN_ENV : REVIEWER_GH_TOKEN_ENV;
  const fileOption =
    actor === "worker" ? options.workerGhTokenFile : options.reviewerGhTokenFile;
  const fileConfigName = `${actor}.gh_token_file`;

  const envToken = env[envName];
  if (envToken !== undefined) {
    if (envToken.trim().length === 0) {
      return {
        ok: false,
        error: `${actor} GitHub token env ${envName} is empty`,
      };
    }
    const probed = probeGithubActorToken(deps, repoId, actor, envName, envToken);
    if (!probed.ok) return probed;
    return {
      ok: true,
      env: githubActorPaneEnv(envToken),
      token: envToken,
      source: `env:${envName}`,
    };
  }

  if (fileOption === undefined) {
    // Unit tests use FakeGitHub without constructing operator auth config in
    // every spawn fixture. Production adapters do not expose this property.
    const testDefaultWorkerToken =
      actor === "worker" && options.env === undefined
        ? (deps.github as { defaultWorkerToken?: string }).defaultWorkerToken
        : undefined;
    if (testDefaultWorkerToken !== undefined) {
      const probed = probeGithubActorToken(
        deps,
        repoId,
        actor,
        "test:defaultWorkerToken",
        testDefaultWorkerToken,
      );
      if (!probed.ok) return probed;
      return {
        ok: true,
        env: githubActorPaneEnv(testDefaultWorkerToken),
        token: testDefaultWorkerToken,
        source: "test:defaultWorkerToken",
      };
    }
    return {
      ok: false,
      error: `${actor} GitHub token missing: set ${envName} or ${fileConfigName} before spawning ${actor} attempts`,
    };
  }

  let token: string;
  try {
    token = readFileSync(fileOption, "utf8").trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `${actor} gh_token_file (${fileOption}) missing or unreadable: ${message}`,
    };
  }

  if (token.length === 0) {
    return {
      ok: false,
      error: `${actor} gh_token_file (${fileOption}) is empty`,
    };
  }

  const probed = probeGithubActorToken(deps, repoId, actor, fileConfigName, token);
  if (!probed.ok) return probed;

  return {
    ok: true,
    env: githubActorPaneEnv(),
    envFiles: [{ name: "GH_TOKEN", path: fileOption }],
    token,
    source: `file:${fileConfigName}`,
  };
}

function githubActorPaneEnv(token?: string): NonNullable<TmuxSpawnInput["env"]> {
  return {
    GH_TOKEN: token,
    GITHUB_TOKEN: undefined,
    [WORKER_GH_TOKEN_ENV]: undefined,
    [REVIEWER_GH_TOKEN_ENV]: undefined,
  };
}

function probeGithubActorToken(
  deps: TickDeps,
  repoId: string,
  actor: GithubActor,
  source: string,
  token: string,
): GithubActorTokenProbeResult {
  try {
    deps.github.probeTokenAccess(repoId, token, actor);
  } catch (err) {
    const message = redactSecret(
      err instanceof Error ? err.message : String(err),
      token,
    );
    return {
      ok: false,
      error: `${actor} GitHub token ${source} is invalid, expired, or cannot access the repository: ${message}`,
    };
  }
  return { ok: true };
}

function addCodexLaunchIsolation(
  env: TmuxSpawnInput["env"],
  worktreePath: string,
  taskId: string,
  agentName: string,
  agentInvocation: string,
  sourceEnv: NodeJS.ProcessEnv,
): TmuxSpawnInput["env"] {
  if (!usesCodexRuntime(agentName, agentInvocation)) return env;
  const sourceHome = codexSourceHome(sourceEnv);
  return {
    ...(env ?? {}),
    CODEX_HOME: isolatedCodexHome(worktreePath, taskId),
    [CODEX_SOURCE_HOME_ENV]: sourceHome ?? "",
  };
}

function isolatedCodexHome(worktreePath: string, taskId: string): string {
  const digest = createHash("sha256").update(taskId).digest("hex");
  return join(dirname(worktreePath), ".quay-codex-home", digest);
}

function codexSourceHome(env: NodeJS.ProcessEnv): string | null {
  const configured = env.CODEX_HOME?.trim();
  if (configured !== undefined && configured.length > 0) return configured;
  const home = env.HOME?.trim();
  if (home === undefined || home.length === 0) return null;
  return join(home, ".codex");
}

function usesCodexRuntime(agentName: string, agentInvocation: string): boolean {
  const normalizedAgent = agentName.toLowerCase();
  if (normalizedAgent === "codex") return true;
  if (normalizedAgent.startsWith("hermes_codex")) return true;
  const binary = parseAgentBinary(agentInvocation);
  if (binary === null) return false;
  const slash = binary.lastIndexOf("/");
  const basename = slash === -1 ? binary : binary.slice(slash + 1);
  return basename.toLowerCase() === "codex";
}

function redactSecret(message: string, secret: string): string {
  if (secret.length === 0) return message;
  return message.split(secret).join("[redacted]");
}

function promoteAndSpawnReviewer(
  deps: TickDeps,
  task: ReviewAttemptTaskRow,
  agentResolver: AgentResolver,
  options: TickOptions,
): TickTaskResult {
  const {
    agent: agentName,
    model: agentModel,
    invocation: agentInvocation,
  } = agentResolver.resolve(task.repo_id, "reviewer", {
    agent: task.reviewer_agent,
    model: task.reviewer_model,
  });
  if (task.cancel_requested_at !== null) {
    return { task_id: task.task_id, action: "skipped_predicate" };
  }
  if (task.pr_number === null) {
    return markReviewInfraFailure(
      deps,
      task,
      "review task has no pr_number",
      EXIT_INFO_NONE,
      options,
    );
  }

  const tokenPreflight = resolveGithubActorToken(
    "reviewer",
    deps,
    task.repo_id,
    options,
  );
  if (!tokenPreflight.ok) {
    return {
      task_id: task.task_id,
      action: "spawn_substrate_failed",
      error: tokenPreflight.error,
    };
  }

  if (task.authoring_mode === "synthetic_review") {
    try {
      deps.git.checkoutPullRequest(
        task.repo_id,
        task.worktree_path,
        task.pr_number,
        task.head_sha,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return markReviewInfraFailure(deps, task, message, EXIT_INFO_NONE, options);
    }
  }

  const promptContent = loadFinalPrompt(deps.db, task.task_id, task.attempt_id);
  const now = deps.clock.nowISO();
  const sessionName = `quay-review-${task.tmux_id}-${task.attempt_number}`;
  const agentIdentity = probeAgentIdentity(agentInvocation);
  deps.db.exec("BEGIN");
  try {
    // For code workers `remote_sha_at_spawn` records what the remote looked
    // like when we spawned; for reviewer attempts the SHA we promised to
    // review is the only meaningful "remote SHA at spawn," so we reuse the
    // column to point at `attempts.head_sha`. `pr_existed_at_spawn` is 1 by
    // definition: there's nothing to review until a PR exists.
    const upd = deps.db
      .query(
        `UPDATE attempts
            SET spawned_at = ?,
                remote_sha_at_spawn = ?,
                pr_existed_at_spawn = 1
          WHERE attempt_id = ?
            AND spawned_at IS NULL
            AND ended_at IS NULL`,
      )
      .run(now, task.head_sha, task.attempt_id);
    const changes = (upd as { changes?: number }).changes ?? 0;
    if (changes === 0) {
      deps.db.exec("ROLLBACK");
      return { task_id: task.task_id, action: "skipped_predicate" };
    }
    const eventData = JSON.stringify({
      tmux_session: sessionName,
      worktree_path: task.worktree_path,
      attempt_number: task.attempt_number,
      agent_identity: agentIdentity,
      github_token_source: tokenPreflight.source,
      pr_number: task.pr_number,
      head_sha: task.head_sha,
    });
    deps.db
      .query(
        `INSERT INTO events (
           task_id, attempt_id, event_type, from_state, to_state, occurred_at, event_data
         ) VALUES (?, ?, 'review_spawned', 'pr-review', 'pr-review', ?, ?)`,
      )
      .run(task.task_id, task.attempt_id, now, eventData);
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }

  try {
    const reviewerEnv = addCodexLaunchIsolation(
      tokenPreflight.env,
      task.worktree_path,
      task.task_id,
      agentName,
      agentInvocation,
      options.env ?? process.env,
    );
    deps.tmux.spawn({
      sessionName,
      worktreePath: task.worktree_path,
      promptContent,
      agentInvocation,
      ...(reviewerEnv !== undefined ? { env: reviewerEnv } : {}),
      ...(tokenPreflight.envFiles !== undefined
        ? { envFiles: tokenPreflight.envFiles }
        : {}),
    });
  } catch (err) {
    return {
      task_id: task.task_id,
      action: "spawn_substrate_failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }

  fireFailpoint("after_tmux_session_created");
  deps.db
    .query(
      `UPDATE attempts
          SET tmux_session = ?, agent_identity = ?, agent_name = ?, agent_model = ?
        WHERE attempt_id = ?`,
    )
    .run(sessionName, agentIdentity, agentName, agentModel, task.attempt_id);

  return { task_id: task.task_id, action: "spawned" };
}

// Bridge between the test-friendly `agentInvocation` shorthand and the
// production `agentResolver`. When the caller supplies a full resolver
// we use it directly; otherwise we wrap the single invocation string
// (test default, or the legacy `agent_invocation =` config key) in a
// trivial resolver that ignores repo and role. The wrapped resolver
// reports the registered agent name as "claude" because the legacy key
// is documented as the claude template — the schema migration treats
// it as `[agents.invocations.claude]`.
function resolveTickAgentResolver(options: TickOptions): AgentResolver {
  if (options.agentResolver !== undefined) return options.agentResolver;
  const invocation = options.agentInvocation ?? DEFAULT_CLAUDE_WORKER_INVOCATION;
  const resolved: ResolvedAgent = {
    agent: DEFAULT_AGENT_NAME,
    model: null,
    invocation,
    capabilities: [],
  };
  return {
    resolve: (_repoId: string, _role: AgentRole) => resolved,
    registeredAgents: () => [DEFAULT_AGENT_NAME],
  };
}

function recordTickError(deps: TickDeps, taskId: string, err: unknown): TickTaskResult {
  const message = err instanceof Error ? err.message : String(err);
  const now = deps.clock.nowISO();
  try {
    deps.db.exec("BEGIN");
    deps.db
      .query(`UPDATE tasks SET tick_error = ?, updated_at = ? WHERE task_id = ?`)
      .run(message, now, taskId);
    deps.db
      .query(
        `INSERT INTO events (task_id, event_type, occurred_at)
         VALUES (?, 'tick_error', ?)`,
      )
      .run(taskId, now);
    deps.db.exec("COMMIT");
  } catch {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
  }
  return { task_id: taskId, action: "tick_error", error: message };
}

function clearTickError(deps: TickDeps, taskId: string): void {
  deps.db
    .query(
      `UPDATE tasks
          SET tick_error = NULL,
              updated_at = ?
        WHERE task_id = ?
          AND tick_error IS NOT NULL`,
    )
    .run(deps.clock.nowISO(), taskId);
}

interface PromotionInput {
  taskId: string;
  attemptId: number;
  attemptNumber: number;
  branchName: string;
  worktreePath: string;
  // Canonical tmux session name we'll attempt to spawn into. Recorded in
  // the `spawned` event_data even when substrate spawn ultimately fails —
  // the event captures intent, the column captures observed reality.
  plannedSession: string;
  agentIdentity: string;
  agentName: string;
  agentModel: string | null;
  consumedBudget: number;
  spawnedAt: string;
  remoteSha: string | null;
  prExisted: number;
  githubTokenSource: string;
}

function runPromotionTransaction(db: DB, p: PromotionInput): boolean {
  db.exec("BEGIN");
  try {
    // event_data captures the spawn-time intent: where the worker is going
    // to run (worktree, branch, tmux session), what we expect to invoke
    // (agent_identity), and the spawn-time progress predicate inputs. This
    // lets retro analysis correlate a spawn with later transitions without
    // having to join across multiple rows.
    const eventData = {
      tmux_session: p.plannedSession,
      worktree_path: p.worktreePath,
      branch_name: p.branchName,
      attempt_number: p.attemptNumber,
      agent_name: p.agentName,
      agent_model: p.agentModel,
      agent_identity: p.agentIdentity,
      github_token_source: p.githubTokenSource,
      remote_sha_at_spawn: p.remoteSha,
      pr_existed_at_spawn: p.prExisted === 1,
    };

    const transition = transitionTaskState(
      { db },
      {
        taskId: p.taskId,
        from: "queued",
        to: "running",
        eventType: "spawned",
        attemptId: p.attemptId,
        now: p.spawnedAt,
        updates: {
          clearTickError: true,
          incrementAttemptsConsumedBy: p.consumedBudget,
        },
        eventData,
      },
    );
    if (!transition.applied) {
      db.exec("ROLLBACK");
      return false;
    }

    db.query(
      `UPDATE attempts
          SET spawned_at = ?,
              remote_sha_at_spawn = ?,
              pr_existed_at_spawn = ?
        WHERE attempt_id = ? AND spawned_at IS NULL`,
    ).run(p.spawnedAt, p.remoteSha, p.prExisted, p.attemptId);

    db.exec("COMMIT");
    return true;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}
