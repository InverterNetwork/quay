// Per-attempt token/cost/model envelope capture. Claude-style agent
// invocations redirect a single JSON stdout envelope into
// `<worktree>/.quay-usage.json`; this module reads the file at attempt
// end and persists its bytes verbatim as a `usage` artifact. Codex-style
// invocations can instead stream JSONL events into `.quay-tool-trace.log`;
// when no direct usage envelope exists, we synthesize the same normalized
// `usage` artifact from the trace while leaving the raw trace capture to
// `tool_trace`.
//
// Storage is content-addressed via the artifact store's content_hash
// idempotency: re-running the classifier on the same attempt (crash
// recovery) re-hashes the same bytes and the second insert is rejected
// by the partial unique index. Capture is best-effort — missing,
// empty, or malformed envelopes leave no artifact and never throw.

import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { DB } from "../db/connection.ts";

const USAGE_FILE = ".quay-usage.json";
const TOOL_TRACE_FILE = ".quay-tool-trace.log";
// Cap parses at 1 MiB. Claude's `--output-format json` envelope is a
// few KiB in practice; anything orders of magnitude beyond that
// indicates a misbehaving runtime and is more useful as a NULL row
// than as a multi-megabyte artifact bloating the store.
const MAX_USAGE_BYTES = 1 * 1024 * 1024;
// Codex JSONL can include the full event stream, not just a final usage
// summary. Match the raw tool_trace artifact's cap and parse from the
// tail for oversized traces because the final token-count events are
// emitted near the end of the run.
const MAX_CODEX_JSONL_BYTES = 4 * 1024 * 1024;

export interface UsageDeps {
  db: DB;
  artifactStore: ArtifactStore;
}

// Carries metadata derived from the captured envelope that callers may want to
// persist outside the artifact bytes. Today only `resolvedModel` is surfaced
// (Codex JSONL `turn_context.payload.model` and friends) so callers can fill
// in `attempts.agent_model` when the intended model was never set.
export interface UsageCollectionResult {
  resolvedModel?: string;
}

export function collectUsageArtifact(
  deps: UsageDeps,
  taskId: string,
  attemptId: number,
  worktreePath: string,
): UsageCollectionResult {
  if (collectDirectUsageArtifact(deps, taskId, attemptId, worktreePath) !== "missing") {
    return {};
  }
  return collectCodexJsonlUsageArtifact(deps, taskId, attemptId, worktreePath);
}

// Fills in `attempts.agent_model` from a resolved runtime model (typically the
// Codex JSONL session model) when the column is currently NULL. Never
// overwrites an explicitly recorded model: the intended-model snapshot taken
// at spawn time wins by definition.
export function persistResolvedAttemptModel(
  db: DB,
  attemptId: number,
  resolvedModel: string | undefined,
): void {
  if (resolvedModel === undefined) return;
  const trimmed = resolvedModel.trim();
  if (trimmed.length === 0) return;
  try {
    db.query(
      `UPDATE attempts
          SET agent_model = ?
        WHERE attempt_id = ?
          AND agent_model IS NULL`,
    ).run(trimmed, attemptId);
  } catch {
    // Best-effort, mirroring the rest of usage capture: never block the
    // terminal transition because of a metadata backfill.
  }
}

type DirectUsageResult = "captured" | "missing" | "present_unusable";

function collectDirectUsageArtifact(
  deps: UsageDeps,
  taskId: string,
  attemptId: number,
  worktreePath: string,
): DirectUsageResult {
  const path = join(worktreePath, USAGE_FILE);
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return "missing";
  }
  if (!stats.isFile()) return "present_unusable";
  if (stats.size === 0) return "present_unusable";
  if (stats.size > MAX_USAGE_BYTES) return "present_unusable";

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return "present_unusable";
  }

  // Validate before persisting: a malformed envelope (truncated by a
  // wall-clock kill mid-write, written by an agent that doesn't honour
  // --output-format json, etc.) is worse than no artifact, since
  // downstream queries assume the bytes are JSON.
  try {
    JSON.parse(raw);
  } catch {
    return "present_unusable";
  }

  try {
    deps.artifactStore.writeArtifact({
      taskId,
      attemptId,
      kind: "usage",
      content: raw,
      extension: "json",
    });
  } catch {
    // UNIQUE violation on (task_id, attempt_id, kind, content_hash) is
    // the crash-recovery idempotent-success case; any other failure is
    // also swallowed because usage capture must never block the
    // terminal transition.
  }
  return "captured";
}

function collectCodexJsonlUsageArtifact(
  deps: UsageDeps,
  taskId: string,
  attemptId: number,
  worktreePath: string,
): UsageCollectionResult {
  const path = join(worktreePath, TOOL_TRACE_FILE);
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return {};
  }
  if (!stats.isFile()) return {};
  if (stats.size === 0) return {};

  let raw: string;
  try {
    raw =
      stats.size <= MAX_CODEX_JSONL_BYTES
        ? readFileSync(path, "utf8")
        : dropFirstPossiblyPartialLine(
            tailRead(path, stats.size, MAX_CODEX_JSONL_BYTES),
          );
  } catch {
    return {};
  }
  if (raw.length === 0) return {};

  const scan = scanCodexJsonl(raw);
  if (scan === null) return {};

  if (scan.usage !== null) {
    try {
      deps.artifactStore.writeArtifact({
        taskId,
        attemptId,
        kind: "usage",
        content: JSON.stringify(scan.usage),
        extension: "json",
      });
    } catch {
      // Same best-effort/idempotent behaviour as direct usage capture.
    }
  }
  // Backfill the model whether or not the trace carried token totals — early
  // crashes, cancellations, and kill-window exits can flush
  // `turn_context.payload.model` to the trace without ever emitting a
  // `token_count` event, and the resolved model is still the right answer
  // for operator-facing attribution.
  return scan.model !== undefined ? { resolvedModel: scan.model } : {};
}

export interface NormalizedCodexUsage {
  source: "codex_jsonl";
  model?: string;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_creation_tokens?: number | null;
  reasoning_tokens?: number | null;
  total_tokens?: number | null;
}

interface TokenTotals {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_creation_tokens?: number | null;
  reasoning_tokens?: number | null;
  total_tokens?: number | null;
}

interface UsageCandidate {
  totals: TokenTotals;
  score: number;
}

type TokenValue = number | null | undefined;

// Single-pass scan of a Codex tool-trace JSONL stream. Returns the resolved
// model (when any event carried one) and the best-scoring token totals
// (`usage`) — or null when the trace is malformed (any non-JSON line, any
// non-object payload). Decoupling the two means an early-exit attempt that
// only flushed `turn_context.payload.model` before dying can still backfill
// `attempts.agent_model`, even though no `token_count` event ever fired.
interface CodexJsonlScanResult {
  model?: string;
  usage: NormalizedCodexUsage | null;
}

function scanCodexJsonl(jsonl: string): CodexJsonlScanResult | null {
  let model: string | undefined;
  let best: (UsageCandidate & { index: number }) | null = null;
  let parsedAnyLine = false;

  const lines = jsonl.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line.length === 0) continue;
    parsedAnyLine = true;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return null;
    }
    if (!isRecord(event)) return null;

    const eventModel = findModel(event);
    if (eventModel !== undefined) model = eventModel;

    for (const candidate of collectUsageCandidates(event)) {
      if (!hasNumericToken(candidate.totals)) continue;
      if (
        best === null ||
        candidate.score > best.score ||
        (candidate.score === best.score && index >= best.index)
      ) {
        best = { ...candidate, index };
      }
    }
  }

  if (!parsedAnyLine) return null;

  const usage = best === null ? null : finalizeNormalizedUsage(best.totals, model);
  return model !== undefined ? { model, usage } : { usage };
}

function finalizeNormalizedUsage(
  source: TokenTotals,
  model: string | undefined,
): NormalizedCodexUsage | null {
  const totals = { ...source };
  if (
    totals.total_tokens === undefined &&
    typeof totals.input_tokens === "number" &&
    typeof totals.output_tokens === "number"
  ) {
    totals.total_tokens = totals.input_tokens + totals.output_tokens;
  }

  const normalized: NormalizedCodexUsage = { source: "codex_jsonl" };
  if (model !== undefined) normalized.model = model;
  copyToken(normalized, "input_tokens", totals.input_tokens);
  copyToken(normalized, "output_tokens", totals.output_tokens);
  copyToken(normalized, "cache_read_tokens", totals.cache_read_tokens);
  copyToken(normalized, "cache_creation_tokens", totals.cache_creation_tokens);
  copyToken(normalized, "reasoning_tokens", totals.reasoning_tokens);
  copyToken(normalized, "total_tokens", totals.total_tokens);

  return hasNumericToken(normalized) ? normalized : null;
}

// Public wrapper retained for tests and external callers that just want the
// normalized usage envelope without the model-only backfill branch.
export function normalizeCodexJsonlUsage(
  jsonl: string,
): NormalizedCodexUsage | null {
  const scan = scanCodexJsonl(jsonl);
  return scan?.usage ?? null;
}

function collectUsageCandidates(value: unknown, path: string[] = []): UsageCandidate[] {
  if (!isRecord(value)) return [];

  const candidates: UsageCandidate[] = [];
  const totals = normalizeUsageObject(value);
  if (totals !== null) {
    candidates.push({ totals, score: scoreUsagePath(path) });
  }

  for (const [key, child] of Object.entries(value)) {
    if (isRecord(child)) {
      candidates.push(...collectUsageCandidates(child, [...path, key]));
    } else if (Array.isArray(child)) {
      for (let i = 0; i < child.length; i += 1) {
        candidates.push(...collectUsageCandidates(child[i], [...path, key]));
      }
    }
  }

  return candidates;
}

function normalizeUsageObject(value: Record<string, unknown>): TokenTotals | null {
  const inputDetails = firstRecord(value, [
    "input_tokens_details",
    "prompt_tokens_details",
  ]);
  const outputDetails = firstRecord(value, [
    "output_tokens_details",
    "completion_tokens_details",
  ]);

  const totals: TokenTotals = {};
  copyToken(
    totals,
    "input_tokens",
    chooseToken(
      readToken(value, "input_tokens"),
      readToken(value, "prompt_tokens"),
      readToken(value, "total_input_tokens"),
    ),
  );
  copyToken(
    totals,
    "output_tokens",
    chooseToken(
      readToken(value, "output_tokens"),
      readToken(value, "completion_tokens"),
      readToken(value, "total_output_tokens"),
    ),
  );
  copyToken(
    totals,
    "cache_read_tokens",
    chooseToken(
      readToken(value, "cache_read_tokens"),
      readToken(value, "cached_input_tokens"),
      readToken(value, "input_cached_tokens"),
      readToken(value, "prompt_cached_tokens"),
      inputDetails !== undefined ? readToken(inputDetails, "cached_tokens") : undefined,
    ),
  );
  copyToken(
    totals,
    "cache_creation_tokens",
    chooseToken(
      readToken(value, "cache_creation_tokens"),
      readToken(value, "cache_write_tokens"),
      readToken(value, "cache_written_tokens"),
      readToken(value, "cache_creation_input_tokens"),
      readToken(value, "cache_writing_input_tokens"),
    ),
  );
  copyToken(
    totals,
    "reasoning_tokens",
    chooseToken(
      readToken(value, "reasoning_tokens"),
      readToken(value, "reasoning_output_tokens"),
      readToken(value, "output_reasoning_tokens"),
      outputDetails !== undefined
        ? readToken(outputDetails, "reasoning_tokens")
        : undefined,
    ),
  );
  copyToken(totals, "total_tokens", readToken(value, "total_tokens"));

  return hasAnyToken(totals) ? totals : null;
}

function scoreUsagePath(path: string[]): number {
  const key = path[path.length - 1] ?? "";
  if (key === "total_token_usage" || key === "total_usage") return 60;
  if (key === "usage" || key === "token_usage") return 50;
  if (key === "last_token_usage" || key === "last_usage") return 30;
  return 10;
}

function findModel(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ["model", "model_id", "model_name"] as const) {
    const model = value[key];
    if (typeof model === "string" && model.trim().length > 0) {
      return model;
    }
  }
  for (const child of Object.values(value)) {
    if (isRecord(child) || Array.isArray(child)) {
      const model = findModelInContainer(child);
      if (model !== undefined) return model;
    }
  }
  return undefined;
}

function findModelInContainer(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const model = findModel(item);
      if (model !== undefined) return model;
    }
    return undefined;
  }
  return findModel(value);
}

function firstRecord(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  for (const key of keys) {
    const child = value[key];
    if (isRecord(child)) return child;
  }
  return undefined;
}

function readToken(value: Record<string, unknown>, key: string): TokenValue {
  if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
  const raw = value[key];
  if (raw === null) return null;
  if (typeof raw !== "number") return undefined;
  if (!Number.isFinite(raw) || raw < 0) return undefined;
  return raw;
}

function chooseToken(...values: TokenValue[]): TokenValue {
  let sawNull = false;
  for (const value of values) {
    if (typeof value === "number") return value;
    if (value === null) sawNull = true;
  }
  return sawNull ? null : undefined;
}

function copyToken<T extends TokenTotals | NormalizedCodexUsage>(
  target: T,
  key: keyof TokenTotals,
  value: TokenValue,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function hasAnyToken(value: TokenTotals): boolean {
  return [
    value.input_tokens,
    value.output_tokens,
    value.cache_read_tokens,
    value.cache_creation_tokens,
    value.reasoning_tokens,
    value.total_tokens,
  ].some((token) => token !== undefined);
}

function hasNumericToken(value: TokenTotals): boolean {
  return [
    value.input_tokens,
    value.output_tokens,
    value.cache_read_tokens,
    value.cache_creation_tokens,
    value.reasoning_tokens,
    value.total_tokens,
  ].some((token) => typeof token === "number");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dropFirstPossiblyPartialLine(raw: string): string {
  const firstNewline = raw.indexOf("\n");
  if (firstNewline === -1) return raw;
  return raw.slice(firstNewline + 1);
}

function tailRead(path: string, fileSize: number, cap: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(cap);
    const offset = fileSize - cap;
    let total = 0;
    while (total < cap) {
      const n = readSync(fd, buf, total, cap - total, offset + total);
      if (n === 0) break;
      total += n;
    }
    return buf.subarray(0, total).toString("utf8");
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
}
