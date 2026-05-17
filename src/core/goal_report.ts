import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const GOAL_REPORT_FILENAME = ".quay-goal-report.json";
export const GOAL_REPORT_MAX_BYTES = 256 * 1024;

export type GoalReportStatus = "active" | "blocked" | "complete";

export interface GoalReport {
  status: GoalReportStatus;
  summary: string;
  evidence: string[];
  blocker: string | null;
  next_steps: string[];
}

export type GoalReportProbe =
  | {
      kind: "valid";
      path: string;
      raw: string;
      report: GoalReport;
      warnings: string[];
    }
  | {
      kind: "malformed";
      path: string;
      raw: Uint8Array;
      diagnostics: string;
    }
  | { kind: "absent"; path: string };

export function probeGoalReport(worktreePath: string): GoalReportProbe {
  const path = join(worktreePath, GOAL_REPORT_FILENAME);
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return { kind: "absent", path };
  }
  if (!stats.isFile()) return { kind: "absent", path };

  let rawBytes: Uint8Array;
  try {
    rawBytes = readFileSync(path);
  } catch {
    return { kind: "absent", path };
  }
  if (rawBytes.byteLength > GOAL_REPORT_MAX_BYTES) {
    return {
      kind: "malformed",
      path,
      raw: rawBytes.subarray(0, GOAL_REPORT_MAX_BYTES),
      diagnostics: `goal report exceeds ${GOAL_REPORT_MAX_BYTES} bytes`,
    };
  }

  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
  } catch {
    return {
      kind: "malformed",
      path,
      raw: rawBytes,
      diagnostics: "goal report is not valid UTF-8",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      kind: "malformed",
      path,
      raw: rawBytes,
      diagnostics: `goal report is not valid JSON: ${(err as Error).message}`,
    };
  }

  const validation = validateGoalReport(parsed);
  if (!validation.ok) {
    return {
      kind: "malformed",
      path,
      raw: rawBytes,
      diagnostics: validation.errors.join("; "),
    };
  }
  return {
    kind: "valid",
    path,
    raw,
    report: validation.report,
    warnings: validation.warnings,
  };
}

type ValidationResult =
  | { ok: true; report: GoalReport; warnings: string[] }
  | { ok: false; errors: string[] };

const REQUIRED_KEYS = new Set([
  "status",
  "summary",
  "evidence",
  "blocker",
  "next_steps",
]);

function validateGoalReport(value: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["goal report must be a JSON object"] };
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!REQUIRED_KEYS.has(key)) {
      errors.push(`unknown top-level field "${key}"`);
    }
  }
  for (const key of REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      errors.push(`missing required field "${key}"`);
    }
  }
  const status = obj.status;
  if (status !== "active" && status !== "blocked" && status !== "complete") {
    errors.push("status must be active, blocked, or complete");
  }
  if (typeof obj.summary !== "string") {
    errors.push("summary must be a string");
  }
  if (!Array.isArray(obj.evidence)) {
    errors.push("evidence must be an array");
  } else {
    for (let i = 0; i < obj.evidence.length; i++) {
      if (typeof obj.evidence[i] !== "string") {
        errors.push(`evidence[${i}] must be a string`);
      }
    }
  }
  if (!Array.isArray(obj.next_steps)) {
    errors.push("next_steps must be an array");
  } else {
    for (let i = 0; i < obj.next_steps.length; i++) {
      if (typeof obj.next_steps[i] !== "string") {
        errors.push(`next_steps[${i}] must be a string`);
      }
    }
  }
  if (obj.blocker !== null && typeof obj.blocker !== "string") {
    errors.push("blocker must be null or a string");
  }
  if (status !== "blocked" && obj.blocker !== null) {
    errors.push("blocker must be null unless status is blocked");
  }
  if (
    status === "blocked" &&
    (typeof obj.blocker !== "string" || obj.blocker.trim().length === 0)
  ) {
    errors.push("blocked reports require a non-empty blocker string");
  }
  if (
    status === "complete" &&
    (!Array.isArray(obj.evidence) || obj.evidence.length === 0)
  ) {
    errors.push("complete reports require non-empty evidence");
  }
  if (status === "active" && Array.isArray(obj.next_steps) && obj.next_steps.length === 0) {
    warnings.push("active goal report has empty next_steps");
  }
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    warnings,
    report: {
      status: status as GoalReportStatus,
      summary: obj.summary as string,
      evidence: obj.evidence as string[],
      blocker: obj.blocker as string | null,
      next_steps: obj.next_steps as string[],
    },
  };
}
