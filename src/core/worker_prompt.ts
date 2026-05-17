// Shared structured composer for code-worker prompts.
//
// Every code-worker attempt — initial, deterministic retry, non-budget
// respawn, orchestrator submit-brief — assembles its final prompt from the
// same conceptual sections so the original task objective remains first-class
// across the whole lifecycle. Reviewer (`review_only`) attempts are out of
// scope and continue to use ad-hoc composition in `pr_review.ts` / `tick.ts`.
//
// Sections in render order:
//   1. Output contract        — the code-worker protocol preamble.
//   2. Stable task objective  — original brief, capped if oversized, with a
//                               pointer to the full `task_objective` artifact.
//   3. Attempt guidance       — what this specific attempt is asked to do
//                               (initial instruction, retry template body,
//                               orchestrator-submitted brief, review/conflict
//                               template body).
//   4. Diagnostics            — observed context (CI excerpt, crash details,
//                               review comments JSON, conflict slice, ...).
//                               Omitted on initial / orchestrator paths.
//
// The tagged sections wrap user-provided content, so the renderer escapes
// `&`, `<`, `>` inside the body and `&`, `<`, `>`, `"` inside attributes.

import { readFileSync } from "node:fs";
import type { DB } from "../db/connection.ts";
import { renderGoalContext, type GoalPromptContext } from "./goals.ts";

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
  goalContext?: GoalPromptContext | undefined;
  attemptGuidance: AttemptGuidance;
  diagnostics?: DiagnosticsSection | undefined;
  renderCapBytes?: number | undefined;
}

export interface WorkerPromptResult {
  brief: string;
  finalPrompt: string;
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
  if (input.goalContext !== undefined) {
    sections.push(renderGoalContext(input.goalContext));
  }
  sections.push(renderAttemptGuidance(input.attemptGuidance));
  if (input.diagnostics !== undefined) {
    sections.push(renderDiagnostics(input.diagnostics));
  }
  const brief = sections.join("\n\n");
  const finalPrompt = `${input.preambleBody}\n\n${brief}`;
  return { brief, finalPrompt };
}

// Loads the canonical original task objective for a task. The objective is
// written once at enqueue time (kind='task_objective', attempt_id IS NULL) and
// referenced by every subsequent code-worker attempt.
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
        ORDER BY artifact_id ASC
        LIMIT 1`,
    )
    .get(taskId);
  if (!row) {
    throw new Error(
      `task_objective artifact not found for task ${taskId}; enqueue must write it once on task creation`,
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
    ? `${escapeXmlText(rendered)}\n\n[Excerpt truncated. Read the full original task objective from artifact #${obj.artifactId} at ${obj.filePath}.]`
    : escapeXmlText(obj.body);
  return `<quay-task-objective ${attrs.join(" ")}>\n${inner}\n</quay-task-objective>`;
}

function renderAttemptGuidance(g: AttemptGuidance): string {
  return `<quay-current-attempt-guidance reason="${escapeAttr(g.reason)}">\n${escapeXmlText(g.body)}\n</quay-current-attempt-guidance>`;
}

function renderPrTarget(baseBranch: string): string {
  return `<quay-pr-target base-branch="${escapeAttr(baseBranch)}">\nOpen or update the pull request against base branch ${escapeXmlText(baseBranch)}.\n</quay-pr-target>`;
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
