import { randomUUID } from "node:crypto";
import type { AgentAdapter, AgentEvent, AgentFetch, AgentSession, AgentUiContext } from "./agent_types.ts";

const DEFAULT_HERMES_API_BASE_URL = "http://127.0.0.1:8642";
const DEFAULT_HERMES_MODEL = "hermes-agent";
const DEFAULT_HERMES_SESSION_KEY_PREFIX = "quay";
const CONTEXT_MAX_STRING_LENGTH = 1000;
const CONTEXT_MAX_ARRAY_ITEMS = 50;
const CONTEXT_MAX_OBJECT_KEYS = 100;
const CONTEXT_MAX_DEPTH = 8;
const CONTEXT_OMITTED_VALUE = "[omitted: fetch by stable ID when needed]";
const QUAY_AGENT_INSTRUCTIONS =
  [
    "You are assisting inside Quay Admin UI.",
    "The user message includes a current UI context snapshot that describes what the operator is looking at.",
    "Treat the snapshot as grounding, not as the full data source or an access boundary.",
    "You may inspect broader Quay data through your available tools and Quay CLI access.",
    "Full logs, review threads, artifacts, prompt bodies, preamble bodies, diffs, and patches are not included in the snapshot by default; fetch those by stable ID when needed.",
    "When proposing a mutating Quay action, first explain the action and emit it in the agreed proposed-action format so Quay can render an approval card.",
  ].join(" ");

export interface HermesAgentConfig {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  sessionKeyPrefix: string;
}

export interface HermesSessionBinding {
  quaySessionId: string;
  hermesSessionId: string;
  hermesSessionKey: string;
  activeRunId: string | null;
  lastRunId: string | null;
}

interface HermesAgentAdapterOptions {
  config: HermesAgentConfig;
  fetch?: AgentFetch;
}

interface HermesRunResponse {
  runId: string;
}

class HermesConfigError extends Error {
  readonly code = "hermes_config_invalid";
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.name = "HermesConfigError";
    this.details = details;
  }
}

class HermesAdapterError extends Error {
  readonly code: string;
  readonly recoverable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: string,
    message: string,
    details?: Record<string, unknown>,
    recoverable = true,
  ) {
    super(message);
    this.name = "HermesAdapterError";
    this.code = code;
    this.details = details;
    this.recoverable = recoverable;
  }
}

export function hermesAgentConfigFromEnv(env: NodeJS.ProcessEnv): HermesAgentConfig {
  const apiBaseUrl = trimTrailingSlash(env.QUAY_HERMES_API_BASE_URL ?? DEFAULT_HERMES_API_BASE_URL);
  const apiKey = env.QUAY_HERMES_API_KEY ?? "";
  const model = env.QUAY_HERMES_MODEL ?? DEFAULT_HERMES_MODEL;
  const sessionKeyPrefix = env.QUAY_HERMES_SESSION_KEY_PREFIX ?? DEFAULT_HERMES_SESSION_KEY_PREFIX;

  const issues: string[] = [];
  if (apiBaseUrl.trim() === "") issues.push("QUAY_HERMES_API_BASE_URL must not be empty");
  if (apiKey.trim() === "") issues.push("QUAY_HERMES_API_KEY must be set when QUAY_AGENT_PROVIDER=hermes");
  if (model.trim() === "") issues.push("QUAY_HERMES_MODEL must not be empty");
  if (sessionKeyPrefix.trim() === "") issues.push("QUAY_HERMES_SESSION_KEY_PREFIX must not be empty");
  if (issues.length > 0) {
    throw new HermesConfigError("Hermes agent configuration is invalid", { issues });
  }

  return { apiBaseUrl, apiKey, model, sessionKeyPrefix };
}

export class HermesAgentAdapter implements AgentAdapter {
  readonly provider = "hermes";

  private readonly config: HermesAgentConfig;
  private readonly fetchImpl: AgentFetch;
  private ready: Promise<void> | null = null;

  constructor(options: HermesAgentAdapterOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async createSession({ session }: { session: AgentSession }): Promise<void> {
    session.binding = {
      quaySessionId: session.sessionId,
      hermesSessionId: `quay-ui:${session.sessionId}`,
      hermesSessionKey: `${this.config.sessionKeyPrefix}:${session.sessionId}`,
      activeRunId: null,
      lastRunId: null,
    } satisfies HermesSessionBinding;
  }

  async *sendMessage(input: {
    session: AgentSession;
    message: string;
    context: AgentUiContext;
  }): AsyncIterable<AgentEvent> {
    const messageId = `agent_${randomUUID()}`;
    let started = false;
    let done = false;
    try {
      await this.assertReady();
      const binding = hermesBinding(input.session);
      const run = await this.createRun(input.message, input.context, binding);
      binding.activeRunId = run.runId;
      binding.lastRunId = run.runId;

      yield { type: "message_start", messageId, role: "agent", model: this.config.model };
      started = true;

      for await (const rawEvent of this.runEvents(run.runId, binding)) {
        const mapped = mapHermesEvent(rawEvent, messageId);
        for (const event of mapped.events) {
          yield event;
        }
        if (mapped.done) {
          done = true;
          break;
        }
      }
    } catch (err) {
      input.session.unavailable = isAvailabilityError(err);
      yield errorEventFromHermesError(err, started ? messageId : undefined);
    } finally {
      const binding = maybeHermesBinding(input.session);
      if (binding !== null) binding.activeRunId = null;
      if (started && !done) {
        yield { type: "message_done", messageId };
      }
    }
  }

  async *decideApproval(input: {
    session: AgentSession;
    approvalId: string;
    decision: "approved" | "rejected";
  }): AsyncIterable<AgentEvent> {
    const messageId = `agent_${randomUUID()}`;
    yield { type: "message_start", messageId, role: "agent", model: this.config.model };
    yield {
      type: "approval_result",
      messageId,
      approvalId: input.approvalId,
      status: input.decision === "approved" ? "succeeded" : "rejected",
      ...(input.decision === "approved" ? { exitCode: 0 } : {}),
    };
    yield {
      type: "text_delta",
      messageId,
      text: input.decision === "approved"
        ? "Hermes adapter recorded operator approval. Native Hermes approval continuation is handled in the approval-flow slice."
        : "Hermes adapter recorded operator rejection. Native Hermes approval continuation is handled in the approval-flow slice.",
    };
    yield { type: "message_done", messageId };
  }

  async stop({ session }: { session: AgentSession }): Promise<void> {
    const binding = maybeHermesBinding(session);
    if (binding?.activeRunId === null || binding?.activeRunId === undefined) return;
    const runId = binding.activeRunId;
    await this.hermesFetch(`/v1/runs/${encodeURIComponent(runId)}/stop`, {
      method: "POST",
      headers: this.hermesHeaders(binding, { Accept: "application/json" }),
    }, "hermes_run_stop_failed");
    binding.activeRunId = null;
  }

  private async assertReady(): Promise<void> {
    this.ready ??= this.checkHealthAndCapabilities();
    try {
      await this.ready;
    } catch (err) {
      this.ready = null;
      throw err;
    }
  }

  private async checkHealthAndCapabilities(): Promise<void> {
    await this.hermesFetch("/health", {
      method: "GET",
      headers: this.hermesHeaders(null, { Accept: "application/json" }),
    }, "hermes_health_failed");

    const capabilitiesResponse = await this.hermesFetch("/v1/capabilities", {
      method: "GET",
      headers: this.hermesHeaders(null, { Accept: "application/json" }),
    }, "hermes_capabilities_failed");
    const capabilities = await capabilitiesResponse.json().catch(() => null);
    if (!supportsRunsApi(capabilities)) {
      throw new HermesAdapterError(
        "hermes_capabilities_unsupported",
        "Hermes API Server does not advertise Runs API event streaming support",
        { capabilities: summarizeCapabilities(capabilities) },
      );
    }
  }

  private async createRun(
    message: string,
    context: AgentUiContext,
    binding: HermesSessionBinding,
  ): Promise<HermesRunResponse> {
    const response = await this.hermesFetch("/v1/runs", {
      method: "POST",
      headers: this.hermesHeaders(binding, {
        Accept: "application/json",
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({
        input: hermesInput(message, context),
        session_id: binding.hermesSessionId,
        instructions: QUAY_AGENT_INSTRUCTIONS,
        model: this.config.model,
      }),
    }, "hermes_run_create_failed");
    const body = await response.json().catch(() => null);
    const runId = readString(body, "run_id") ?? readString(body, "runId") ?? readString(body, "id");
    if (runId === null) {
      throw new HermesAdapterError(
        "hermes_run_create_failed",
        "Hermes run creation response did not include a run id",
        { response_shape: describeJsonShape(body) },
      );
    }
    return { runId };
  }

  private async *runEvents(
    runId: string,
    binding: HermesSessionBinding,
  ): AsyncIterable<unknown> {
    const response = await this.hermesFetch(`/v1/runs/${encodeURIComponent(runId)}/events`, {
      method: "GET",
      headers: this.hermesHeaders(binding, { Accept: "text/event-stream" }),
    }, "hermes_stream_failed");
    if (response.body === null) {
      throw new HermesAdapterError("hermes_stream_failed", "Hermes event stream response did not include a body");
    }
    yield* parseHermesSse(response.body);
  }

  private async hermesFetch(
    path: string,
    init: RequestInit,
    errorCode: string,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.apiBaseUrl}${path}`, init);
    } catch (err) {
      throw new HermesAdapterError(
        errorCode,
        `Hermes request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new HermesAdapterError(
        errorCode,
        `Hermes request failed with HTTP ${response.status}`,
        { status: response.status },
        response.status >= 500,
      );
    }
    return response;
  }

  private hermesHeaders(
    binding: HermesSessionBinding | null,
    extra: Record<string, string>,
  ): Headers {
    const headers = new Headers(extra);
    headers.set("Authorization", `Bearer ${this.config.apiKey}`);
    if (binding !== null) headers.set("X-Hermes-Session-Key", binding.hermesSessionKey);
    return headers;
  }
}

export function isHermesConfigError(err: unknown): err is HermesConfigError {
  return err instanceof HermesConfigError;
}

async function* parseHermesSse(body: ReadableStream<Uint8Array>): AsyncIterable<unknown> {
  let buffer = "";
  for await (const chunk of readTextChunks(body)) {
    buffer = normalizeNewlines(`${buffer}${chunk}`);
    let blockIndex = buffer.indexOf("\n\n");
    while (blockIndex !== -1) {
      const block = buffer.slice(0, blockIndex);
      buffer = buffer.slice(blockIndex + 2);
      const event = parseSseBlock(block);
      if (event !== null) yield event;
      blockIndex = buffer.indexOf("\n\n");
    }
  }
  const tail = buffer.trim();
  if (tail !== "") {
    const event = parseSseBlock(tail);
    if (event !== null) yield event;
  }
}

async function* readTextChunks(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail !== "") yield tail;
  } finally {
    reader.releaseLock();
  }
}

function parseSseBlock(block: string): unknown | null {
  let eventName: string | undefined;
  const dataLines: string[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trimEnd();
    if (line === "" || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      const value = line.slice(6);
      eventName = value.startsWith(" ") ? value.slice(1) : value;
      continue;
    }
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5);
    dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  const data = dataLines.join("\n").trim();
  if (data === "" || data === "[DONE]") return null;
  try {
    const parsed = JSON.parse(data) as unknown;
    if (eventName === undefined || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return parsed;
    }
    return { event: eventName, ...(parsed as Record<string, unknown>) };
  } catch {
    return eventName === undefined ? { data } : { event: eventName, data };
  }
}

function mapHermesEvent(raw: unknown, messageId: string): {
  events: AgentEvent[];
  done: boolean;
} {
  const record = raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const type = readString(record, "type") ?? readString(record, "event") ?? "";
  const text = textDeltaFromHermesEvent(record, type);
  if (text !== null) {
    return { events: [{ type: "text_delta", messageId, text }], done: false };
  }
  if (type.includes("completed") || type === "run.done") {
    return { events: [{ type: "message_done", messageId }], done: true };
  }
  if (type.includes("cancelled") || type.includes("canceled")) {
    return {
      events: [
        {
          type: "error",
          messageId,
          code: "hermes_run_cancelled",
          message: "Hermes run was cancelled",
          recoverable: true,
        },
        { type: "message_done", messageId },
      ],
      done: true,
    };
  }
  if (type.includes("failed") || type.includes("error")) {
    return {
      events: [
        {
          type: "error",
          messageId,
          code: "hermes_run_failed",
          message: safeHermesEventMessage(record),
          recoverable: true,
          details: { event_type: type === "" ? "unknown" : type },
        },
        { type: "message_done", messageId },
      ],
      done: true,
    };
  }
  return { events: [], done: false };
}

function textDeltaFromHermesEvent(
  record: Record<string, unknown>,
  type: string,
): string | null {
  const direct = readString(record, "text") ??
    readString(record, "delta") ??
    readString(record, "content");
  if (
    direct !== null &&
    (type.includes("delta") || type.includes("text") || type.includes("assistant"))
  ) {
    return direct;
  }
  const data = record.data;
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const nested = data as Record<string, unknown>;
    return readString(nested, "text") ?? readString(nested, "delta") ?? readString(nested, "content");
  }
  return null;
}

function safeHermesEventMessage(record: Record<string, unknown>): string {
  const code = readString(record, "code") ?? readString(record, "error_code");
  return code === null ? "Hermes run failed" : `Hermes run failed: ${code}`;
}

function supportsRunsApi(capabilities: unknown): boolean {
  if (capabilities === null || typeof capabilities !== "object") return false;
  const features = capabilityFeatures(capabilities);
  const hasSubmission = features.has("run_submission") ||
    features.has("runs") ||
    features.has("runs.create") ||
    features.has("runs_api");
  const hasEvents = features.has("run_events_sse") ||
    features.has("run_events") ||
    features.has("runs.events") ||
    (features.has("events") && features.has("runs"));
  const hasStop = features.has("run_stop") ||
    features.has("runs.stop") ||
    (features.has("stop") && features.has("runs"));
  return hasSubmission && hasEvents && hasStop;
}

function capabilityFeatures(value: unknown): Set<string> {
  const out = new Set<string>();
  collectCapabilityFeatures(value, out, []);
  return out;
}

function collectCapabilityFeatures(
  value: unknown,
  out: Set<string>,
  path: string[],
): void {
  if (typeof value === "string") {
    out.add(value.toLowerCase());
    return;
  }
  if (typeof value === "boolean" || typeof value === "number") {
    if (value) out.add(path.join(".").toLowerCase());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCapabilityFeatures(item, out, path);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out.add(key.toLowerCase());
    collectCapabilityFeatures(child, out, [...path, key]);
  }
}

function summarizeCapabilities(capabilities: unknown): Record<string, unknown> {
  return { advertised: summarizeJson(capabilities) };
}

function errorEventFromHermesError(err: unknown, messageId?: string): AgentEvent {
  if (err instanceof HermesAdapterError) {
    return {
      type: "error",
      ...(messageId === undefined ? {} : { messageId }),
      code: err.code,
      message: err.message,
      recoverable: err.recoverable,
      ...(err.details === undefined ? {} : { details: err.details }),
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    type: "error",
    ...(messageId === undefined ? {} : { messageId }),
    code: "hermes_adapter_failed",
    message,
    recoverable: true,
  };
}

function isAvailabilityError(err: unknown): boolean {
  return err instanceof HermesAdapterError &&
    (err.code === "hermes_health_failed" ||
      err.code === "hermes_capabilities_failed" ||
      err.code === "hermes_capabilities_unsupported" ||
      err.code === "hermes_adapter_failed");
}

function hermesInput(message: string, context: AgentUiContext): string {
  return `${message}\n\n<quay-ui-context>${escapedContextJson(sanitizeAgentUiContext(context))}</quay-ui-context>`;
}

function sanitizeAgentUiContext(context: AgentUiContext): AgentUiContext {
  return {
    view: context.view,
    scope: truncateContextString(context.scope),
    urlPath: truncateContextString(context.urlPath),
    capturedAt: truncateContextString(context.capturedAt),
    summary: truncateContextString(context.summary),
    payload: sanitizeContextObject(context.payload, 0),
  };
}

function escapedContextJson(context: AgentUiContext): string {
  return JSON.stringify(context).replace(/[<>&]/g, (char) => {
    if (char === "<") return "\\u003c";
    if (char === ">") return "\\u003e";
    return "\\u0026";
  });
}

function sanitizeContextValue(value: unknown, depth: number, key?: string): unknown {
  if (key !== undefined && shouldOmitContextKey(key)) return CONTEXT_OMITTED_VALUE;
  if (typeof value === "string") return truncateContextString(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    if (depth >= CONTEXT_MAX_DEPTH) return "[truncated: maximum context depth reached]";
    return value
      .slice(0, CONTEXT_MAX_ARRAY_ITEMS)
      .map((item) => sanitizeContextValue(item, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    if (depth >= CONTEXT_MAX_DEPTH) return "[truncated: maximum context depth reached]";
    return sanitizeContextObject(value as Record<string, unknown>, depth + 1);
  }
  return undefined;
}

function sanitizeContextObject(
  value: Record<string, unknown>,
  depth: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, CONTEXT_MAX_OBJECT_KEYS)) {
    const sanitized = sanitizeContextValue(child, depth, key);
    if (sanitized !== undefined) out[key] = sanitized;
  }
  return out;
}

function truncateContextString(value: string): string {
  return value.length <= CONTEXT_MAX_STRING_LENGTH
    ? value
    : `${value.slice(0, CONTEXT_MAX_STRING_LENGTH)}...[truncated]`;
}

function shouldOmitContextKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return [
    "log",
    "logs",
    "fulllog",
    "fulllogs",
    "rawlog",
    "rawlogs",
    "reviewthread",
    "reviewthreads",
    "fullreviewthread",
    "fullreviewthreads",
    "reviewthreadbody",
    "artifact",
    "artifacts",
    "fullartifact",
    "fullartifacts",
    "diff",
    "diffs",
    "fulldiff",
    "fulldiffs",
    "rawdiff",
    "rawdiffs",
    "patch",
    "patches",
    "preamblebody",
    "preamblebodies",
    "promptbody",
    "promptbodies",
    "body",
  ].includes(normalized);
}

function hermesBinding(session: AgentSession): HermesSessionBinding {
  const binding = maybeHermesBinding(session);
  if (binding === null) {
    throw new HermesAdapterError(
      "hermes_session_missing",
      "Hermes session binding is missing",
      { session_id: session.sessionId },
    );
  }
  return binding;
}

function maybeHermesBinding(session: AgentSession): HermesSessionBinding | null {
  if (session.binding === null || typeof session.binding !== "object") return null;
  const binding = session.binding as Partial<HermesSessionBinding>;
  return typeof binding.quaySessionId === "string" &&
      typeof binding.hermesSessionId === "string" &&
      typeof binding.hermesSessionKey === "string"
    ? binding as HermesSessionBinding
    : null;
}

function readString(value: unknown, key: string): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : null;
}

function summarizeJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const text = JSON.stringify(value);
    return text.length > 500 ? `${text.slice(0, 497)}...` : value;
  } catch {
    return String(value);
  }
}

function describeJsonShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value !== "object") return typeof value;
  const keys = Object.keys(value as Record<string, unknown>)
    .filter((key) => !isSecretLikeKey(key))
    .sort();
  return keys.length === 0 ? "object" : `object:${keys.slice(0, 8).join(",")}`;
}

function isSecretLikeKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.includes("authorization") ||
    normalized.includes("token") ||
    normalized.includes("key") ||
    normalized.includes("secret") ||
    normalized.includes("cookie");
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
