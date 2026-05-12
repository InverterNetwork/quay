import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";
import type { GitHubPort, PullRequestView } from "../ports/github.ts";
import { ensureReviewerPreambleId, loadPreambleBody } from "./preamble.ts";

export const SYNTHETIC_PR_REVIEW_PREFIX = "pr-review-";

export type ReviewVerdict = "approved" | "changes_requested" | "errored" | "superseded";

export type EnterReviewSkippedReason =
  | "active_attempt_exists"
  | "terminal_verdict_exists"
  | "quay_owned_gate_disabled";

export interface EnterReviewDeps {
  db: DB;
  clock: Clock;
  github: GitHubPort;
  artifactStore: ArtifactStore;
  paths: { worktreesRoot: string };
}

export interface EnterReviewInput {
  repoId: string;
  prNumber: number;
  headSha?: string;
  tags?: string[];
  reviewerEnabled: boolean;
  gateQuayOwnedDone: boolean;
}

export interface EnterReviewResult {
  task_id: string;
  attempt_id: number | null;
  state: string;
  review_verdict: ReviewVerdict | null;
  scheduled: boolean;
  skipped_reason: EnterReviewSkippedReason | null;
}

interface TaskLookupRow {
  task_id: string;
  state: string;
  branch_name: string;
  worktree_path: string;
  tmux_id: string;
  pr_number: number | null;
  review_infra_failures_consecutive: number;
  review_infra_failure_head_sha: string | null;
}

interface AttemptLookupRow {
  attempt_id: number;
  review_verdict: ReviewVerdict | null;
}

interface InsertAttemptRow {
  attempt_id: number;
}

export function enterReview(
  deps: EnterReviewDeps,
  input: EnterReviewInput,
): EnterReviewResult {
  if (!input.reviewerEnabled) {
    throw new Error("reviewer subsystem is disabled");
  }
  const pr = deps.github.prView(input.repoId, input.prNumber);
  if (pr === null) {
    throw new Error(`PR ${input.repoId}:${input.prNumber} not found`);
  }
  const headSha = input.headSha ?? pr.headSha;
  if (headSha.trim() === "") {
    throw new Error(`PR ${input.repoId}:${input.prNumber} has no head SHA`);
  }

  const existing =
    findTaskByPr(deps.db, input.repoId, input.prNumber) ??
    findTaskByBranch(deps.db, input.repoId, pr.headRefName);
  const isQuayOwned = existing !== null && !isSyntheticTaskId(existing.task_id);
  if (isQuayOwned && !input.gateQuayOwnedDone) {
    return {
      task_id: existing.task_id,
      attempt_id: null,
      state: existing.state,
      review_verdict: null,
      scheduled: false,
      skipped_reason: "quay_owned_gate_disabled",
    };
  }

  const now = deps.clock.nowISO();
  const task =
    existing ?? createSyntheticTask(deps, input.repoId, input.prNumber, pr, now);
  const synthetic = isSyntheticTaskId(task.task_id);
  const tags = dedupeTags(input.tags ?? []);
  const preambleId = ensureReviewerPreambleId(deps.db, deps.clock);
  const preamble = loadPreambleBody(deps.db, preambleId);
  const brief = synthetic ? composeSyntheticBrief(pr) : loadMostRecentBrief(deps.db, task.task_id);

  deps.db.exec("BEGIN IMMEDIATE");
  try {
    if (tags.length > 0) {
      const insertTag = deps.db.query(
        `INSERT OR IGNORE INTO task_tags (task_id, tag, created_at) VALUES (?, ?, ?)`,
      );
      for (const tag of tags) insertTag.run(task.task_id, tag, now);
    }

    deps.db
      .query(
        `UPDATE attempts
            SET ended_at = ?,
                review_verdict = 'superseded'
          WHERE task_id = ?
            AND reason = 'review_only'
            AND head_sha IS NOT NULL
            AND head_sha <> ?
            AND ended_at IS NULL`,
      )
      .run(now, task.task_id, headSha);

    const active = deps.db
      .query<AttemptLookupRow, [string, string]>(
        `SELECT attempt_id, review_verdict
           FROM attempts
          WHERE task_id = ?
            AND reason = 'review_only'
            AND head_sha = ?
            AND ended_at IS NULL
          ORDER BY attempt_id DESC
          LIMIT 1`,
      )
      .get(task.task_id, headSha);
    if (active) {
      deps.db.exec("COMMIT");
      return {
        task_id: task.task_id,
        attempt_id: active.attempt_id,
        state: readTaskState(deps.db, task.task_id) ?? task.state,
        review_verdict: active.review_verdict,
        scheduled: false,
        skipped_reason: "active_attempt_exists",
      };
    }

    const terminalVerdict = deps.db
      .query<AttemptLookupRow, [string, string]>(
        `SELECT attempt_id, review_verdict
           FROM attempts
          WHERE task_id = ?
            AND reason = 'review_only'
            AND head_sha = ?
            AND review_verdict IN ('approved', 'changes_requested')
          ORDER BY attempt_id DESC
          LIMIT 1`,
      )
      .get(task.task_id, headSha);
    if (terminalVerdict) {
      deps.db.exec("COMMIT");
      return {
        task_id: task.task_id,
        attempt_id: terminalVerdict.attempt_id,
        state: readTaskState(deps.db, task.task_id) ?? task.state,
        review_verdict: terminalVerdict.review_verdict,
        scheduled: false,
        skipped_reason: "terminal_verdict_exists",
      };
    }

    const nextAttemptNumber = nextAttemptNumberForTask(deps.db, task.task_id);
    const attempt = deps.db
      .query<
        InsertAttemptRow,
        [string, number, number, string, number, string]
      >(
        `INSERT INTO attempts (
           task_id, attempt_number, preamble_id, reason, consumed_budget, head_sha
         ) VALUES (?, ?, ?, ?, ?, ?)
         RETURNING attempt_id`,
      )
      .get(task.task_id, nextAttemptNumber, preambleId, "review_only", 0, headSha);
    if (!attempt) throw new Error("review attempt insert returned no row");

    deps.artifactStore.writeArtifact({
      taskId: task.task_id,
      attemptId: attempt.attempt_id,
      kind: "brief",
      content: brief,
      extension: "md",
    });
    deps.artifactStore.writeArtifact({
      taskId: task.task_id,
      attemptId: attempt.attempt_id,
      kind: "final_prompt",
      content: `${preamble}\n\n${brief}`,
      extension: "md",
    });

    deps.db
      .query(
        `UPDATE tasks
            SET state = 'pr-review',
                pr_number = COALESCE(pr_number, ?),
                pr_url = COALESCE(pr_url, ?),
                head_sha = ?,
                tick_error = NULL,
                updated_at = ?
          WHERE task_id = ?
            AND cancel_requested_at IS NULL`,
      )
      .run(input.prNumber, pr.url, headSha, now, task.task_id);

    deps.db
      .query(
        `INSERT INTO events (
           task_id, attempt_id, event_type, from_state, to_state, occurred_at
         ) VALUES (?, ?, 'review_requested', ?, 'pr-review', ?)`,
      )
      .run(task.task_id, attempt.attempt_id, task.state, now);

    deps.db.exec("COMMIT");
    return {
      task_id: task.task_id,
      attempt_id: attempt.attempt_id,
      state: "pr-review",
      review_verdict: null,
      scheduled: true,
      skipped_reason: null,
    };
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

export function isSyntheticTaskId(taskId: string): boolean {
  return taskId.startsWith(SYNTHETIC_PR_REVIEW_PREFIX);
}

export function syntheticTaskId(repoId: string, prNumber: number): string {
  return `${SYNTHETIC_PR_REVIEW_PREFIX}${slugRepoId(repoId)}-${prNumber}`;
}

export function slugRepoId(repoId: string): string {
  const slug = repoId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "repo" : slug;
}

function createSyntheticTask(
  deps: EnterReviewDeps,
  repoId: string,
  prNumber: number,
  pr: PullRequestView,
  now: string,
): TaskLookupRow {
  const taskId = syntheticTaskId(repoId, prNumber);
  const existingById = findTaskById(deps.db, taskId);
  if (existingById) return existingById;

  const branchName = `quay-review/${prNumber}`;
  const tmuxId = `quay-review-${slugRepoId(repoId)}-${prNumber}`;
  const worktreePath = join(
    deps.paths.worktreesRoot,
    "quay-review",
    slugRepoId(repoId),
    String(prNumber),
  );
  deps.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, external_ref, state, branch_name, tmux_id,
         worktree_path, pr_number, pr_url, head_sha, retry_budget,
         created_at, updated_at
       ) VALUES (?, ?, NULL, 'pr-review', ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      taskId,
      repoId,
      branchName,
      tmuxId,
      worktreePath,
      prNumber,
      pr.url,
      pr.headSha,
      now,
      now,
    );
  return {
    task_id: taskId,
    state: "pr-review",
    branch_name: branchName,
    worktree_path: worktreePath,
    tmux_id: tmuxId,
    pr_number: prNumber,
    review_infra_failures_consecutive: 0,
    review_infra_failure_head_sha: null,
  };
}

function findTaskByPr(
  db: DB,
  repoId: string,
  prNumber: number,
): TaskLookupRow | null {
  return (
    db
      .query<TaskLookupRow, [string, number]>(
        `SELECT task_id, state, branch_name, worktree_path, tmux_id, pr_number,
                review_infra_failures_consecutive,
                review_infra_failure_head_sha
           FROM tasks
          WHERE repo_id = ? AND pr_number = ?
          ORDER BY created_at ASC, task_id ASC
          LIMIT 1`,
      )
      .get(repoId, prNumber) ?? null
  );
}

function findTaskByBranch(
  db: DB,
  repoId: string,
  branchName: string,
): TaskLookupRow | null {
  return (
    db
      .query<TaskLookupRow, [string, string]>(
        `SELECT task_id, state, branch_name, worktree_path, tmux_id, pr_number,
                review_infra_failures_consecutive,
                review_infra_failure_head_sha
           FROM tasks
          WHERE repo_id = ? AND branch_name = ?
          ORDER BY created_at ASC, task_id ASC
          LIMIT 1`,
      )
      .get(repoId, branchName) ?? null
  );
}

function findTaskById(db: DB, taskId: string): TaskLookupRow | null {
  return (
    db
      .query<TaskLookupRow, [string]>(
        `SELECT task_id, state, branch_name, worktree_path, tmux_id, pr_number,
                review_infra_failures_consecutive,
                review_infra_failure_head_sha
           FROM tasks
          WHERE task_id = ?`,
      )
      .get(taskId) ?? null
  );
}

function readTaskState(db: DB, taskId: string): string | null {
  const row = db
    .query<{ state: string }, [string]>(
      `SELECT state FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  return row?.state ?? null;
}

function nextAttemptNumberForTask(db: DB, taskId: string): number {
  const row = db
    .query<{ n: number | null }, [string]>(
      `SELECT MAX(attempt_number) AS n FROM attempts WHERE task_id = ?`,
    )
    .get(taskId);
  return (row?.n ?? 0) + 1;
}

function loadMostRecentBrief(db: DB, taskId: string): string {
  const row = db
    .query<{ file_path: string }, [string]>(
      `SELECT file_path FROM artifacts
         WHERE task_id = ? AND kind = 'brief'
         ORDER BY artifact_id DESC
         LIMIT 1`,
    )
    .get(taskId);
  if (!row) return `Review the pull request for task ${taskId}.`;
  return readFileSync(row.file_path, "utf8");
}

function composeSyntheticBrief(pr: PullRequestView): string {
  const body = pr.body.trim() === "" ? "<empty body>" : pr.body.trim();
  return [
    `Review PR #${pr.number}: ${pr.title}`,
    "",
    `URL: ${pr.url ?? "<unknown>"}`,
    `Head branch: ${pr.headRefName}`,
    `Head SHA: ${pr.headSha}`,
    "",
    "PR body:",
    body,
  ].join("\n");
}

function dedupeTags(tags: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    if (tag === "" || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}
