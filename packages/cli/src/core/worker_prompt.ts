// Shared structured composer for code-worker prompts.
//
// Every code-worker attempt — initial, deterministic retry, non-budget
// respawn, orchestrator submit-brief — assembles its final prompt from the
// same conceptual sections so the task objective remains first-class across
// the whole lifecycle.
//
// Sections in render order:
//   1. Output contract        — the code-worker protocol preamble.
//   2. Stable task objective  — current brief, capped if oversized, with a
//                               pointer to the full `task_objective` artifact.
//   3. Reference repos        — optional deployment/runtime context for
//                               read-only sibling repo checkouts.
//   4. Attempt guidance       — what this specific attempt is asked to do
//                               (initial instruction, retry template body,
//                               orchestrator-submitted brief, review/conflict
//                               template body).
//   5. Diagnostics            — observed context (CI excerpt, crash details,
//                               review comments JSON, conflict slice, ...).
//                               Omitted on initial / orchestrator paths.
//
// The tagged sections wrap user-provided content, so the renderer escapes
// `&`, `<`, `>` inside the body and `&`, `<`, `>`, `"` inside attributes.

import { readFileSync } from "node:fs";
import type { DB } from "../db/connection.ts";
import { renderGoalContext, type GoalPromptContext } from "./goals.ts";
import {
  assertReviewerGuidanceProtocolSafe,
  REVIEWER_PROTOCOL_PREAMBLE_BODY,
} from "./preamble.ts";
import { renderReferenceReposPrompt } from "./reference_repos.ts";

export const DEFAULT_OBJECTIVE_RENDER_CAP_BYTES = 16_384;

export const INITIAL_ATTEMPT_GUIDANCE =
  "Begin the initial implementation of the task objective above. Follow the protocol preamble; complete the task or exit cleanly with a blocker.";

export interface TaskObjectiveRef {
  body: string;
  artifactId: number;
  filePath: string;
}

export interface AttemptGuidance {
  reason: string;
  body: string;
}

export interface DiagnosticsSection {
  kind: string;
  body: string;
}

export interface WorkerPromptInput {
  preambleBody: string;
  taskObjective: TaskObjectiveRef;
  prBaseBranch?: string | undefined;
  prScreenshotsRequested?: boolean | undefined;
  prScreenshotsRequired?: boolean | undefined;
  goalContext?: GoalPromptContext | undefined;
  referenceReposRoot?: string | undefined;
  attemptGuidance: AttemptGuidance;
  diagnostics?: DiagnosticsSection | undefined;
  renderCapBytes?: number | undefined;
}

export interface WorkerPromptResult {
  brief: string;
  finalPrompt: string;
}

export interface ReviewerPromptInput {
  reviewerGuidanceBody: string;
  brief: string;
}

export function composeWorkerPrompt(
  input: WorkerPromptInput,
): WorkerPromptResult {
  const cap = input.renderCapBytes ?? DEFAULT_OBJECTIVE_RENDER_CAP_BYTES;
  const sections: string[] = [
    renderTaskObjective(input.taskObjective, cap),
  ];
  if (input.prBaseBranch !== undefined) {
    sections.push(renderPrTarget(input.prBaseBranch));
  }
  if (input.prScreenshotsRequired === true) {
    sections.push(renderPrScreenshotRequirement());
  } else if (input.prScreenshotsRequested === true) {
    sections.push(renderPrScreenshotRequest());
  }
  if (input.goalContext !== undefined) {
    sections.push(renderGoalContext(input.goalContext));
  }
  const referenceRepos = renderReferenceReposPrompt(
    input.referenceReposRoot,
    "worker",
  );
  if (referenceRepos !== null) {
    sections.push(referenceRepos);
  }
  sections.push(renderAttemptGuidance(input.attemptGuidance));
  if (input.diagnostics !== undefined) {
    sections.push(renderDiagnostics(input.diagnostics));
  }
  const brief = sections.join("\n\n");
  const finalPrompt = `${input.preambleBody}\n\n${brief}`;
  return { brief, finalPrompt };
}

export function composeReviewerPrompt(
  input: ReviewerPromptInput,
): WorkerPromptResult {
  const guidance = input.reviewerGuidanceBody.trim();
  assertReviewerGuidanceProtocolSafe(guidance, "configured reviewer guidance");
  const reviewerGuidanceSection = [
    "## Configurable Reviewer Guidance",
    "",
    "The following guidance is configurable. If it conflicts with the static reviewer protocol above, follow the static reviewer protocol.",
    "",
    guidance.length > 0 ? guidance : "(No additional reviewer guidance configured.)",
  ].join("\n");
  return {
    brief: input.brief,
    finalPrompt: [
      REVIEWER_PROTOCOL_PREAMBLE_BODY,
      reviewerGuidanceSection,
      input.brief,
    ].join("\n\n"),
  };
}

// Loads the current task objective for a task. Enqueue writes the first
// task-level artifact; task resnapshot can append a newer one when operators
// re-baseline the ticket.
export function loadOriginalTaskObjective(
  db: DB,
  taskId: string,
): TaskObjectiveRef {
  const row = db
    .query<{ artifact_id: number; file_path: string }, [string]>(
      `SELECT artifact_id, file_path
         FROM artifacts
        WHERE task_id = ?
          AND kind = 'task_objective'
          AND attempt_id IS NULL
        ORDER BY artifact_id DESC
        LIMIT 1`,
    )
    .get(taskId);
  if (!row) {
    throw new Error(
      `task_objective artifact not found for task ${taskId}; enqueue must write one on task creation`,
    );
  }
  let body: string;
  try {
    body = readFileSync(row.file_path, "utf8");
  } catch (err) {
    throw new Error(
      `task_objective artifact ${row.artifact_id} unreadable at ${row.file_path}: ${(err as Error).message}`,
    );
  }
  return { body, artifactId: row.artifact_id, filePath: row.file_path };
}

export function loadTaskPrBaseBranch(db: DB, taskId: string): string | undefined {
  const row = db
    .query<{ base_branch: string | null }, [string]>(
      `SELECT COALESCE(t.base_branch, r.base_branch) AS base_branch
         FROM tasks t JOIN repos r ON r.repo_id = t.repo_id
        WHERE t.task_id = ?`,
    )
    .get(taskId);
  return row?.base_branch ?? undefined;
}

export function loadTaskPrScreenshotsRequested(db: DB, taskId: string): boolean {
  const row = db
    .query<{ pr_screenshots_requested: number | null }, [string]>(
      `SELECT pr_screenshots_requested
         FROM tasks
        WHERE task_id = ?`,
    )
    .get(taskId);
  return row?.pr_screenshots_requested === 1;
}

export function loadTaskPrScreenshotsRequired(db: DB, taskId: string): boolean {
  const row = db
    .query<{ pr_screenshots_required: number | null }, [string]>(
      `SELECT pr_screenshots_required
         FROM tasks
        WHERE task_id = ?`,
    )
    .get(taskId);
  return row?.pr_screenshots_required === 1;
}

function renderTaskObjective(obj: TaskObjectiveRef, cap: number): string {
  const totalBytes = utf8ByteLength(obj.body);
  const truncated = totalBytes > cap;
  const rendered = truncated ? truncateToByteCap(obj.body, cap) : obj.body;
  const attrs = [
    `artifact-id="${escapeAttr(String(obj.artifactId))}"`,
    `source-path="${escapeAttr(obj.filePath)}"`,
    `objective-bytes="${totalBytes}"`,
    `truncated="${truncated ? "true" : "false"}"`,
  ];
  if (truncated) {
    attrs.push(`excerpt-bytes="${utf8ByteLength(rendered)}"`);
  }
  const inner = truncated
    ? `${escapeXmlText(rendered)}\n\n[Excerpt truncated. Read the full task objective from artifact #${obj.artifactId} at ${obj.filePath}.]`
    : escapeXmlText(obj.body);
  return `<quay-task-objective ${attrs.join(" ")}>\n${inner}\n</quay-task-objective>`;
}

function renderAttemptGuidance(g: AttemptGuidance): string {
  return `<quay-current-attempt-guidance reason="${escapeAttr(g.reason)}">\n${escapeXmlText(g.body)}\n</quay-current-attempt-guidance>`;
}

function renderPrTarget(baseBranch: string): string {
  return `<quay-pr-target base-branch="${escapeAttr(baseBranch)}">\nOpen or update the pull request against base branch ${escapeXmlText(baseBranch)}.\nThe effective PR base branch is ${escapeXmlText(baseBranch)}; if the PR already exists, treat the current GitHub PR base as authoritative unless a new human instruction says otherwise.\n</quay-pr-target>`;
}

function renderPrScreenshotRequest(): string {
  return [
    `<quay-pr-screenshot-request requested="true" required="false">`,
    "If this task affects UI, capture one or more screenshots of the changed UI state.",
    "Attach or link the screenshot(s) in the PR body or a PR comment when your runtime supports that.",
    "If screenshots cannot be captured or attached from this environment, state that limitation plainly in the PR body or PR comment.",
    "Do not block for interactive input while trying to satisfy this request.",
    `</quay-pr-screenshot-request>`,
  ].join("\n");
}

function renderPrScreenshotRequirement(): string {
  return [
    `<quay-pr-screenshot-request requested="true" required="true">`,
    "Screenshots are required for this task.",
    "If this task affects UI, capture one or more screenshots of the changed UI state.",
    "Attach or link the screenshot(s) in the PR body or a PR comment.",
    "If screenshots cannot be captured or attached from this environment, stop with a blocker instead of opening or updating the PR as complete.",
    "Do not block for interactive input while trying to satisfy this requirement.",
    `</quay-pr-screenshot-request>`,
  ].join("\n");
}

function renderDiagnostics(d: DiagnosticsSection): string {
  return `<quay-diagnostics kind="${escapeAttr(d.kind)}">\n${escapeXmlText(d.body)}\n</quay-diagnostics>`;
}

function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function truncateToByteCap(text: string, cap: number): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= cap) return text;
  let end = cap;
  // Walk back to a UTF-8 code-point boundary so we don't slice mid-codepoint.
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  return new TextDecoder("utf-8").decode(encoded.subarray(0, end));
}
