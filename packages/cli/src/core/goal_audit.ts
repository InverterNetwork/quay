import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve, sep } from "node:path";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";
import type { GitHubPort, PrSnapshot } from "../ports/github.ts";
import {
  GOAL_AUDIT_REJECTED_ATTEMPT_REASON,
  goalBudgetIsExhausted,
  loadGoalPromptContext,
  loadTaskGoal,
} from "./goals.ts";
import type { GoalEvidence, GoalReport } from "./goal_report.ts";
import { enqueueOrchestratorHandoff } from "./orchestrator_handoffs.ts";
import { ensurePreambleIdForAttemptReason, loadPreambleBody } from "./preamble.ts";
import {
  composeWorkerPrompt,
  loadOriginalTaskObjective,
  loadTaskPrBaseBranch,
  loadTaskPrScreenshotsRequired,
  loadTaskPrScreenshotsRequested,
} from "./worker_prompt.ts";

export const MAX_GOAL_EVIDENCE_FILE_BYTES = 4 * 1024 * 1024;

export interface GoalEvidenceManifest {
  schema_version: 1;
  items: CapturedGoalEvidenceItem[];
}

export interface CapturedGoalEvidenceItem {
  index: number;
  kind: GoalEvidence["kind"];
  summary: string;
  durable: boolean;
  valid: boolean;
  artifact_id: number | null;
  source: string | number | null;
  error: string | null;
}

export interface CapturedGoalEvidence {
  manifestArtifactId: number;
  manifest: GoalEvidenceManifest;
}

interface GoalAuditArtifactDeps {
  db: DB;
  clock: Clock;
  artifactStore: ArtifactStore;
}

export interface GoalAuditDeps extends GoalAuditArtifactDeps {
  github: GitHubPort;
  referenceReposRoot?: string | undefined;
}

export interface GoalCompletionPendingTask {
  task_id: string;
  repo_id: string;
  branch_name: string;
  worktree_path: string;
  cancel_requested_at: string | null;
}

export type GoalCompletionAuditAction =
  | "goal_completion_accepted"
  | "goal_completion_rejected"
  | "goal_budget_limited"
  | "skipped_predicate";

export interface GoalCompletionAuditResult {
  task_id: string;
  action: GoalCompletionAuditAction;
}

interface GoalCompletionAttempt {
  attempt_id: number;
  attempt_number: number;
  preamble_id: number;
  goal_id: string | null;
  remote_sha_at_exit: string | null;
  diff_summary: string | null;
}

interface PendingEvent {
  event_id: number;
  payload_artifact_id: number | null;
  event_data: string | null;
}

interface PendingEventData {
  evidence_manifest_artifact_id?: unknown;
}

interface AuditDecision {
  decision: "accepted" | "rejected";
  reasons: string[];
  feedback: string[];
}

export function captureGoalEvidenceArtifacts(
  deps: GoalAuditArtifactDeps,
  input: {
    taskId: string;
    attemptId: number;
    worktreePath: string;
    report: GoalReport;
  },
): CapturedGoalEvidence {
  const items = input.report.evidence.map((evidence, index) =>
    captureEvidenceEntry(deps, input, evidence, index),
  );
  const manifest: GoalEvidenceManifest = { schema_version: 1, items };
  const manifestArtifact = writeArtifactDedup(deps, {
    taskId: input.taskId,
    attemptId: input.attemptId,
    kind: "goal_evidence_manifest",
    content: JSON.stringify(manifest, null, 2),
    extension: "json",
  });
  return {
    manifestArtifactId: manifestArtifact.artifactId,
    manifest,
  };
}

export function processGoalCompletionAudit(
  deps: GoalAuditDeps,
  task: GoalCompletionPendingTask,
): GoalCompletionAuditResult | null {
  if (task.cancel_requested_at !== null) return null;

  const attempt = loadGoalCompletionAttempt(deps.db, task.task_id);
  if (attempt === null) return null;
  if (attempt.goal_id === null) {
    throw new Error(`goal completion pending task ${task.task_id} has no goal_id`);
  }
  const pending = loadLatestPendingEvent(deps.db, task.task_id);
  if (pending === null || pending.payload_artifact_id === null) {
    throw new Error(`goal completion pending event not found for task ${task.task_id}`);
  }

  const report = readArtifactJson<GoalReport>(deps.db, pending.payload_artifact_id);
  const data = parsePendingEventData(pending.event_data);
  const manifestArtifactId = asPositiveInteger(data.evidence_manifest_artifact_id);
  if (manifestArtifactId === null) {
    throw new Error(
      `goal completion pending event for task ${task.task_id} is missing evidence_manifest_artifact_id`,
    );
  }
  const manifest = readArtifactJson<GoalEvidenceManifest>(
    deps.db,
    manifestArtifactId,
  );

  const snapshot = deps.github.prSnapshot(task.repo_id, task.branch_name);
  if (snapshot === null && deps.github.prExistsForBranch(task.repo_id, task.branch_name)) {
    throw new Error(
      `PR snapshot unavailable for branch ${task.branch_name}; goal completion audit will retry next cycle`,
    );
  }

  const decision = evaluateGoalCompletion({
    db: deps.db,
    report,
    manifest,
    snapshot,
  });
  const auditArtifact = writeGoalCompletionAuditArtifact(deps, {
    task,
    attempt,
    pendingEventId: pending.event_id,
    reportArtifactId: pending.payload_artifact_id,
    evidenceManifestArtifactId: manifestArtifactId,
    report,
    manifest,
    snapshot,
    decision,
  });

  if (decision.decision === "accepted" && snapshot !== null) {
    acceptGoalCompletion(deps, {
      task,
      attempt,
      snapshot,
      auditArtifactId: auditArtifact.artifactId,
      reportArtifactId: pending.payload_artifact_id,
      evidenceManifestArtifactId: manifestArtifactId,
      decision,
    });
    return { task_id: task.task_id, action: "goal_completion_accepted" };
  }

  const action = rejectGoalCompletion(deps, {
    task,
    attempt,
    auditArtifactId: auditArtifact.artifactId,
    reportArtifactId: pending.payload_artifact_id,
    evidenceManifestArtifactId: manifestArtifactId,
    decision,
  });
  return { task_id: task.task_id, action };
}

function captureEvidenceEntry(
  deps: GoalAuditArtifactDeps,
  input: {
    taskId: string;
    attemptId: number;
    worktreePath: string;
    report: GoalReport;
  },
  evidence: GoalEvidence,
  index: number,
): CapturedGoalEvidenceItem {
  if (evidence.kind === "note") {
    const artifact = writeArtifactDedup(deps, {
      taskId: input.taskId,
      attemptId: input.attemptId,
      kind: "goal_evidence",
      content: JSON.stringify({ index, ...evidence }, null, 2),
      extension: "json",
    });
    return evidenceItem(index, evidence, false, true, artifact.artifactId, null, null);
  }

  if (evidence.kind === "url") {
    const artifact = writeArtifactDedup(deps, {
      taskId: input.taskId,
      attemptId: input.attemptId,
      kind: "goal_evidence",
      content: JSON.stringify({ index, ...evidence }, null, 2),
      extension: "json",
    });
    return evidenceItem(index, evidence, true, true, artifact.artifactId, evidence.url, null);
  }

  if (evidence.kind === "artifact") {
    const exists = deps.db
      .query<{ artifact_id: number }, [string, number]>(
        `SELECT artifact_id FROM artifacts
          WHERE task_id = ? AND artifact_id = ?`,
      )
      .get(input.taskId, evidence.artifact_id);
    const artifact = writeArtifactDedup(deps, {
      taskId: input.taskId,
      attemptId: input.attemptId,
      kind: "goal_evidence",
      content: JSON.stringify(
        {
          index,
          ...evidence,
          referenced_artifact_exists: exists !== null && exists !== undefined,
        },
        null,
        2,
      ),
      extension: "json",
    });
    return evidenceItem(
      index,
      evidence,
      true,
      exists !== null && exists !== undefined,
      artifact.artifactId,
      evidence.artifact_id,
      exists ? null : `artifact #${evidence.artifact_id} does not belong to this task`,
    );
  }

  return captureFileEvidence(deps, input, evidence, index);
}

function captureFileEvidence(
  deps: GoalAuditArtifactDeps,
  input: {
    taskId: string;
    attemptId: number;
    worktreePath: string;
  },
  evidence: Extract<GoalEvidence, { kind: "file" }>,
  index: number,
): CapturedGoalEvidenceItem {
  const root = resolve(input.worktreePath);
  const path = isAbsolute(evidence.path) ? resolve(evidence.path) : resolve(root, evidence.path);
  if (!isPathInside(path, root)) {
    return evidenceItem(
      index,
      evidence,
      true,
      false,
      null,
      evidence.path,
      "file evidence path is outside the worktree",
    );
  }

  let realRoot;
  let realPath;
  try {
    realRoot = realpathSync(root);
    realPath = realpathSync(path);
  } catch {
    return evidenceItem(index, evidence, true, false, null, evidence.path, "file not found");
  }
  if (!isPathInside(realPath, realRoot)) {
    return evidenceItem(
      index,
      evidence,
      true,
      false,
      null,
      evidence.path,
      "file evidence path is outside the worktree",
    );
  }

  let stats;
  try {
    stats = statSync(realPath);
  } catch {
    return evidenceItem(index, evidence, true, false, null, evidence.path, "file not found");
  }
  if (!stats.isFile()) {
    return evidenceItem(index, evidence, true, false, null, evidence.path, "path is not a file");
  }
  if (stats.size > MAX_GOAL_EVIDENCE_FILE_BYTES) {
    return evidenceItem(
      index,
      evidence,
      true,
      false,
      null,
      evidence.path,
      `file exceeds ${MAX_GOAL_EVIDENCE_FILE_BYTES} bytes`,
    );
  }

  let content: Uint8Array;
  try {
    content = readFileSync(realPath);
  } catch (err) {
    return evidenceItem(
      index,
      evidence,
      true,
      false,
      null,
      evidence.path,
      `file could not be read: ${(err as Error).message}`,
    );
  }

  const artifact = writeArtifactDedup(deps, {
    taskId: input.taskId,
    attemptId: input.attemptId,
    kind: "goal_evidence",
    content,
    extension: extensionForPath(path),
  });
  return evidenceItem(
    index,
    evidence,
    true,
    true,
    artifact.artifactId,
    evidence.path,
    null,
  );
}

function isPathInside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function evidenceItem(
  index: number,
  evidence: GoalEvidence,
  durable: boolean,
  valid: boolean,
  artifactId: number | null,
  source: string | number | null,
  error: string | null,
): CapturedGoalEvidenceItem {
  return {
    index,
    kind: evidence.kind,
    summary: evidence.summary,
    durable,
    valid,
    artifact_id: artifactId,
    source,
    error,
  };
}

function evaluateGoalCompletion(input: {
  db: DB;
  report: GoalReport;
  manifest: GoalEvidenceManifest;
  snapshot: PrSnapshot | null;
}): AuditDecision {
  const reasons: string[] = [];
  const feedback: string[] = [];

  if (input.snapshot === null) {
    reasons.push("No pull request exists for the task branch.");
    feedback.push("Push the branch, open a non-draft PR, then write a fresh complete goal report.");
  } else if (input.snapshot.state === "closed_unmerged") {
    reasons.push("The pull request is closed without merge.");
    feedback.push("Reopen or recreate a reviewable PR before claiming completion.");
  } else if (input.snapshot.state === "open" && input.snapshot.isDraft === true) {
    reasons.push("The pull request is still a draft.");
    feedback.push("Mark the PR ready for review before claiming completion.");
  }

  const invalidEvidence = input.manifest.items.filter((item) => !item.valid);
  for (const item of invalidEvidence) {
    reasons.push(`Evidence item ${item.index} is invalid: ${item.error ?? "unknown error"}.`);
  }

  const durableEvidence = input.manifest.items.filter(
    (item) => item.valid && item.durable,
  );
  if (durableEvidence.length === 0) {
    reasons.push("Complete report does not cite any captured file, URL, or existing artifact evidence.");
    feedback.push("Add durable evidence such as a test log, screenshot file, command-output file, PR URL, or prior artifact reference.");
  }

  if (completionEvidenceContradictsClaim(input.report, input.manifest, input.db)) {
    reasons.push("The cited evidence says required verification could not run or failed.");
    feedback.push("Run the missing verification or report active/blocked with next steps instead of complete.");
  }

  if (reasons.length > 0) {
    return {
      decision: "rejected",
      reasons,
      feedback:
        feedback.length > 0
          ? feedback
          : ["Address the audit findings and write a fresh complete goal report."],
    };
  }

  return {
    decision: "accepted",
    reasons: ["Reviewable PR and durable non-contradictory evidence were present."],
    feedback: [],
  };
}

function completionEvidenceContradictsClaim(
  report: GoalReport,
  manifest: GoalEvidenceManifest,
  db: DB,
): boolean {
  const text = [
    report.summary,
    ...report.evidence.map((e) => e.summary),
    ...manifest.items.map((item) => item.error ?? ""),
    ...readEvidenceArtifactTextForAudit(db, manifest),
  ]
    .join("\n")
    .toLowerCase();
  const failure =
    /\b(could not|couldn't|unable|failed|failure|not available|missing|skipped|did not run|cannot|can't)\b/.test(
      text,
    );
  const verification =
    /\b(screenshot|browser|playwright|verification|verify|test|required|acceptance)\b/.test(
      text,
    );
  return failure && verification;
}

function readEvidenceArtifactTextForAudit(
  db: DB,
  manifest: GoalEvidenceManifest,
): string[] {
  const artifactIds = new Set<number>();
  for (const item of manifest.items) {
    if (item.artifact_id !== null) artifactIds.add(item.artifact_id);
    if (item.kind === "artifact" && typeof item.source === "number") {
      artifactIds.add(item.source);
    }
  }

  const texts: string[] = [];
  for (const artifactId of artifactIds) {
    const text = readArtifactTextForAudit(db, artifactId);
    if (text !== null) texts.push(text);
  }
  return texts;
}

function readArtifactTextForAudit(db: DB, artifactId: number): string | null {
  const row = db
    .query<{ file_path: string }, [number]>(
      `SELECT file_path FROM artifacts WHERE artifact_id = ?`,
    )
    .get(artifactId);
  if (!row) return null;
  try {
    return new TextDecoder("utf-8").decode(readFileSync(row.file_path));
  } catch {
    return null;
  }
}

function writeGoalCompletionAuditArtifact(
  deps: GoalAuditDeps,
  input: {
    task: GoalCompletionPendingTask;
    attempt: GoalCompletionAttempt;
    pendingEventId: number;
    reportArtifactId: number;
    evidenceManifestArtifactId: number;
    report: GoalReport;
    manifest: GoalEvidenceManifest;
    snapshot: PrSnapshot | null;
    decision: AuditDecision;
  },
): { artifactId: number } {
  const objective = loadOriginalTaskObjective(deps.db, input.task.task_id);
  const content = {
    schema_version: 1,
    decision: input.decision.decision,
    reasons: input.decision.reasons,
    feedback: input.decision.feedback,
    task_id: input.task.task_id,
    goal_id: input.attempt.goal_id,
    attempt_id: input.attempt.attempt_id,
    pending_event_id: input.pendingEventId,
    objective: {
      artifact_id: objective.artifactId,
      bytes: new TextEncoder().encode(objective.body).length,
    },
    report_artifact_id: input.reportArtifactId,
    evidence_manifest_artifact_id: input.evidenceManifestArtifactId,
    evidence: input.manifest.items,
    report: input.report,
    pr: input.snapshot === null
      ? null
      : {
          number: input.snapshot.prNumber ?? null,
          url: input.snapshot.prUrl ?? null,
          state: input.snapshot.state,
          is_draft: input.snapshot.isDraft ?? false,
          head_sha: input.snapshot.headSha,
          base_sha: input.snapshot.baseSha,
        },
    diff_summary_present: input.attempt.diff_summary !== null,
  };
  return writeArtifactDedup(deps, {
    taskId: input.task.task_id,
    attemptId: input.attempt.attempt_id,
    kind: "goal_completion_audit",
    content: JSON.stringify(content, null, 2),
    extension: "json",
  });
}

function acceptGoalCompletion(
  deps: GoalAuditDeps,
  input: {
    task: GoalCompletionPendingTask;
    attempt: GoalCompletionAttempt;
    snapshot: PrSnapshot;
    auditArtifactId: number;
    reportArtifactId: number;
    evidenceManifestArtifactId: number;
    decision: AuditDecision;
  },
): void {
  const now = deps.clock.nowISO();
  deps.db.exec("BEGIN IMMEDIATE");
  try {
    const taskUpd = deps.db
      .query(
        `UPDATE tasks
            SET state = 'pr-open',
                pr_number = COALESCE(?, pr_number),
                pr_url = COALESCE(?, pr_url),
                pr_title = COALESCE(?, pr_title),
                head_sha = COALESCE(?, head_sha),
                base_sha = COALESCE(?, base_sha),
                tick_error = NULL,
                updated_at = ?
          WHERE task_id = ?
            AND state = 'goal-completion-pending'
            AND cancel_requested_at IS NULL`,
      )
      .run(
        input.snapshot.prNumber ?? null,
        input.snapshot.prUrl ?? null,
        input.snapshot.prTitle ?? null,
        input.snapshot.headSha === "" ? null : input.snapshot.headSha,
        input.snapshot.baseSha,
        now,
        input.task.task_id,
      );
    const changes = (taskUpd as { changes?: number }).changes ?? 0;
    if (changes === 0) {
      deps.db.exec("ROLLBACK");
      return;
    }
    deps.db
      .query(
        `UPDATE task_goals
            SET status = 'complete',
                completed_at = ?,
                current_handoff_id = NULL,
                updated_at = ?
          WHERE task_id = ? AND goal_id = ?`,
      )
      .run(now, now, input.task.task_id, input.attempt.goal_id);
    deps.db
      .query(
        `UPDATE attempts
            SET exit_kind = 'pr_opened'
          WHERE attempt_id = ?`,
      )
      .run(input.attempt.attempt_id);
    deps.db
      .query(
        `INSERT INTO events (
           task_id, attempt_id, event_type, from_state, to_state,
           payload_artifact_id, occurred_at, event_data
         ) VALUES (?, ?, 'goal_completion_accepted', 'goal-completion-pending', 'pr-open', ?, ?, ?)`,
      )
      .run(
        input.task.task_id,
        input.attempt.attempt_id,
        input.auditArtifactId,
        now,
        JSON.stringify({
          goal_id: input.attempt.goal_id,
          report_artifact_id: input.reportArtifactId,
          evidence_manifest_artifact_id: input.evidenceManifestArtifactId,
          reasons: input.decision.reasons,
          pr_number: input.snapshot.prNumber ?? null,
          head_sha: input.snapshot.headSha,
        }),
      );
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

function rejectGoalCompletion(
  deps: GoalAuditDeps,
  input: {
    task: GoalCompletionPendingTask;
    attempt: GoalCompletionAttempt;
    auditArtifactId: number;
    reportArtifactId: number;
    evidenceManifestArtifactId: number;
    decision: AuditDecision;
  },
): "goal_completion_rejected" | "goal_budget_limited" {
  const now = deps.clock.nowISO();

  deps.db.exec("BEGIN IMMEDIATE");
  try {
    const goal = loadTaskGoal(deps.db, input.task.task_id);
    if (goal !== null && goalBudgetIsExhausted(goal)) {
      transitionRejectedGoalBudgetLimitedInOpenTxn(deps, input, now);
      deps.db.exec("COMMIT");
      return "goal_budget_limited";
    }

    deps.db
      .query(
        `UPDATE task_goals
            SET status = 'active',
                completed_at = NULL,
                current_handoff_id = NULL,
                updated_at = ?
          WHERE task_id = ? AND goal_id = ?`,
      )
      .run(now, input.task.task_id, input.attempt.goal_id);

    const preambleId = ensurePreambleIdForAttemptReason(
      deps.db,
      deps.clock,
      GOAL_AUDIT_REJECTED_ATTEMPT_REASON,
      { repoId: input.task.repo_id },
    );
    const objective = loadOriginalTaskObjective(deps.db, input.task.task_id);
    const goalContext = loadGoalPromptContext(deps.db, input.task.task_id);
    const prBaseBranch = loadTaskPrBaseBranch(deps.db, input.task.task_id);
    const prScreenshotsRequested = loadTaskPrScreenshotsRequested(
      deps.db,
      input.task.task_id,
    );
    const prScreenshotsRequired = loadTaskPrScreenshotsRequired(
      deps.db,
      input.task.task_id,
    );
    const preambleBody = loadPreambleBody(deps.db, preambleId);
    const guidance = [
      "The goal completion audit rejected the previous complete report.",
      "",
      "Audit reasons:",
      ...input.decision.reasons.map((reason) => `- ${reason}`),
      "",
      "Required next steps:",
      ...input.decision.feedback.map((step) => `- ${step}`),
      "",
      "Continue the original goal. When you exit, write a fresh valid .quay-goal-report.json.",
    ].join("\n");
    const composed = composeWorkerPrompt({
      preambleBody,
      taskObjective: objective,
      prBaseBranch,
      prScreenshotsRequested,
      prScreenshotsRequired,
      goalContext,
      referenceReposRoot: deps.referenceReposRoot,
      attemptGuidance: {
        reason: GOAL_AUDIT_REJECTED_ATTEMPT_REASON,
        body: guidance,
      },
      diagnostics: {
        kind: "goal_completion_audit",
        body: `Audit artifact #${input.auditArtifactId} rejected completion.`,
      },
    });

    const attemptRow = deps.db
      .query<
        { attempt_id: number },
        [string, number, number, string, string | null]
      >(
        `INSERT INTO attempts (
           task_id, attempt_number, preamble_id, reason, consumed_budget, goal_id
         ) VALUES (?, ?, ?, ?, 0, ?)
         RETURNING attempt_id`,
      )
      .get(
        input.task.task_id,
        input.attempt.attempt_number + 1,
        preambleId,
        GOAL_AUDIT_REJECTED_ATTEMPT_REASON,
        input.attempt.goal_id,
      );
    if (!attemptRow) throw new Error("goal audit retry attempt insert returned no row");
    deps.artifactStore.writeArtifact({
      taskId: input.task.task_id,
      attemptId: attemptRow.attempt_id,
      kind: "brief",
      content: composed.brief,
      extension: "md",
    });
    deps.artifactStore.writeArtifact({
      taskId: input.task.task_id,
      attemptId: attemptRow.attempt_id,
      kind: "final_prompt",
      content: composed.finalPrompt,
      extension: "md",
    });

    const taskUpd = deps.db
      .query(
        `UPDATE tasks
            SET state = 'queued',
                tick_error = NULL,
                updated_at = ?
          WHERE task_id = ?
            AND state = 'goal-completion-pending'
            AND cancel_requested_at IS NULL`,
      )
      .run(now, input.task.task_id);
    const changes = (taskUpd as { changes?: number }).changes ?? 0;
    if (changes === 0) {
      deps.db.exec("ROLLBACK");
      return "goal_completion_rejected";
    }
    deps.db
      .query(
        `UPDATE attempts
            SET exit_kind = 'goal_completion_rejected'
          WHERE attempt_id = ?`,
      )
      .run(input.attempt.attempt_id);
    deps.db
      .query(
        `INSERT INTO events (
           task_id, attempt_id, event_type, from_state, to_state,
           payload_artifact_id, occurred_at, event_data
         ) VALUES (?, ?, 'goal_completion_rejected', 'goal-completion-pending', 'queued', ?, ?, ?)`,
      )
      .run(
        input.task.task_id,
        input.attempt.attempt_id,
        input.auditArtifactId,
        now,
        JSON.stringify({
          goal_id: input.attempt.goal_id,
          next_attempt_id: attemptRow.attempt_id,
          report_artifact_id: input.reportArtifactId,
          evidence_manifest_artifact_id: input.evidenceManifestArtifactId,
          reasons: input.decision.reasons,
          feedback: input.decision.feedback,
        }),
      );
    deps.db.exec("COMMIT");
    return "goal_completion_rejected";
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

function transitionRejectedGoalBudgetLimitedInOpenTxn(
  deps: GoalAuditDeps,
  input: {
    task: GoalCompletionPendingTask;
    attempt: GoalCompletionAttempt;
    auditArtifactId: number;
    reportArtifactId: number;
    evidenceManifestArtifactId: number;
    decision: AuditDecision;
  },
  now: string,
): void {
  deps.db
    .query(
      `UPDATE task_goals
          SET status = 'budget_limited',
              last_attempt_id = ?,
              completed_at = NULL,
              updated_at = ?
        WHERE task_id = ? AND goal_id = ?`,
    )
    .run(input.attempt.attempt_id, now, input.task.task_id, input.attempt.goal_id);
  const taskUpd = deps.db
    .query(
      `UPDATE tasks
          SET state = 'awaiting-next-brief',
              tick_error = NULL,
              updated_at = ?
        WHERE task_id = ?
          AND state = 'goal-completion-pending'
          AND cancel_requested_at IS NULL`,
    )
    .run(now, input.task.task_id);
  const changes = (taskUpd as { changes?: number }).changes ?? 0;
  if (changes === 0) return;
  deps.db
    .query(
      `UPDATE attempts
          SET exit_kind = 'goal_completion_rejected'
        WHERE attempt_id = ?`,
    )
    .run(input.attempt.attempt_id);
  const eventRow = deps.db
    .query<{ event_id: number }, [string, number, number, string, string]>(
      `INSERT INTO events (
         task_id, attempt_id, event_type, from_state, to_state,
         payload_artifact_id, occurred_at, event_data
       ) VALUES (?, ?, 'goal_budget_limited', 'goal-completion-pending', 'awaiting-next-brief', ?, ?, ?)
       RETURNING event_id`,
    )
    .get(
      input.task.task_id,
      input.attempt.attempt_id,
      input.auditArtifactId,
      now,
      JSON.stringify({
        goal_id: input.attempt.goal_id,
        report_artifact_id: input.reportArtifactId,
        evidence_manifest_artifact_id: input.evidenceManifestArtifactId,
        audit_reasons: input.decision.reasons,
      }),
    );
  if (!eventRow) throw new Error("goal_budget_limited event insert returned no row");
  const goal = loadTaskGoal(deps.db, input.task.task_id);
  const handoffId = enqueueOrchestratorHandoff(deps, {
    taskId: input.task.task_id,
    reason: "budget_exhausted",
    stateEventId: eventRow.event_id,
    payload: {
      goal_id: input.attempt.goal_id,
      attempt_id: input.attempt.attempt_id,
      audit_artifact_id: input.auditArtifactId,
      report_artifact_id: input.reportArtifactId,
      evidence_manifest_artifact_id: input.evidenceManifestArtifactId,
      tokens_used: goal?.tokens_used ?? null,
      token_budget: goal?.token_budget ?? null,
      audit_reasons: input.decision.reasons,
    },
  });
  deps.db
    .query(
      `UPDATE task_goals SET current_handoff_id = ?, updated_at = ?
        WHERE task_id = ? AND goal_id = ?`,
    )
    .run(handoffId, now, input.task.task_id, input.attempt.goal_id);
}

function loadGoalCompletionAttempt(
  db: DB,
  taskId: string,
): GoalCompletionAttempt | null {
  return (
    db
      .query<GoalCompletionAttempt, [string]>(
        `SELECT attempt_id, attempt_number, preamble_id, goal_id,
                remote_sha_at_exit, diff_summary
           FROM attempts
          WHERE task_id = ?
          ORDER BY attempt_id DESC
          LIMIT 1`,
      )
      .get(taskId) ?? null
  );
}

function loadLatestPendingEvent(db: DB, taskId: string): PendingEvent | null {
  return (
    db
      .query<PendingEvent, [string]>(
        `SELECT event_id, payload_artifact_id, event_data
           FROM events
          WHERE task_id = ?
            AND event_type = 'goal_completion_pending'
          ORDER BY event_id DESC
          LIMIT 1`,
      )
      .get(taskId) ?? null
  );
}

function readArtifactJson<T>(db: DB, artifactId: number): T {
  const row = db
    .query<{ file_path: string }, [number]>(
      `SELECT file_path FROM artifacts WHERE artifact_id = ?`,
    )
    .get(artifactId);
  if (!row) throw new Error(`artifact #${artifactId} not found`);
  return JSON.parse(readFileSync(row.file_path, "utf8")) as T;
}

function parsePendingEventData(raw: string | null): PendingEventData {
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as PendingEventData;
    }
  } catch {}
  return {};
}

function asPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

interface WriteDedupInput {
  taskId: string;
  attemptId: number;
  kind: string;
  content: string | Uint8Array;
  extension: string;
}

function writeArtifactDedup(
  deps: GoalAuditArtifactDeps,
  input: WriteDedupInput,
): { artifactId: number } {
  const bytes =
    typeof input.content === "string"
      ? new TextEncoder().encode(input.content)
      : input.content;
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const existing = deps.db
    .query<{ artifact_id: number }, [string, number, string, string]>(
      `SELECT artifact_id FROM artifacts
         WHERE task_id = ? AND attempt_id = ? AND kind = ? AND content_hash = ?`,
    )
    .get(input.taskId, input.attemptId, input.kind, contentHash);
  if (existing) return { artifactId: existing.artifact_id };
  const artifact = deps.artifactStore.writeArtifact(input);
  return { artifactId: artifact.artifactId };
}

function extensionForPath(path: string): string {
  const ext = extname(path).replace(/^\./, "");
  if (/^[A-Za-z0-9]{1,12}$/.test(ext)) return ext;
  return "bin";
}
