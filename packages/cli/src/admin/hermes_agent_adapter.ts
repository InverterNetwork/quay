import { randomUUID } from "node:crypto";
import type { AgentAdapter, AgentApproval, AgentEvent, AgentFetch, AgentSession, AgentUiContext } from "./agent_types.ts";

const DEFAULT_HERMES_API_BASE_URL = "http://127.0.0.1:8642";
const DEFAULT_HERMES_MODEL = "hermes-agent";
const DEFAULT_HERMES_SESSION_KEY_PREFIX = "quay";
const CONTEXT_MAX_STRING_LENGTH = 1000;
const CONTEXT_MAX_ARRAY_ITEMS = 50;
const CONTEXT_MAX_OBJECT_KEYS = 100;
const CONTEXT_MAX_DEPTH = 8;
const CONTEXT_OMITTED_VALUE = "[omitted: fetch by stable ID when needed]";
const PROPOSED_ACTION_BUFFER_LIMIT = 8000;
const EVENT_DETAIL_MAX_LENGTH = 500;
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

interface ProposedAction {
  approvalId: string;
  command: string;
  description: string;
  affects: Array<{ label: string; value: string }>;
  note?: string;
}

interface ProposedActionMatch {
  start: number;
  end: number;
  actions: ProposedAction[];
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
    const mapper = new HermesEventMapper(messageId, this.config.model);
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
        const mapped = mapper.map(rawEvent, { allowMessageStart: !started });
        for (const event of mapped.events) {
          if (event.type === "message_start") started = true;
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
        for (const event of mapper.flush()) {
          yield event;
        }
      }
      if (started && !done) {
        yield { type: "message_done", messageId };
      }
    }
  }

  async *decideApproval(input: {
    session: AgentSession;
    approvalId: string;
    decision: "approved" | "rejected";
    approval?: AgentApproval;
  }): AsyncIterable<AgentEvent> {
    const messageId = input.approval?.messageId ?? `agent_${randomUUID()}`;
    const mapper = new HermesEventMapper(messageId, this.config.model);
    let done = false;
    let continuationFailed = false;
    yield { type: "message_start", messageId, role: "agent", model: this.config.model };
    yield {
      type: "approval_result",
      messageId,
      approvalId: input.approvalId,
      status: input.decision === "approved" ? "running" : "rejected",
    };

    try {
      await this.assertReady();
      const binding = hermesBinding(input.session);
      // Trusted-Hermes v1 records operator consent and continues the Hermes conversation.
      // Hermes may still have direct Quay CLI access; gateway-enforced mutation control is future hardening.
      const run = await this.createRun(approvalDecisionFollowUp(input), input.session.lastContext, binding);
      binding.activeRunId = run.runId;
      binding.lastRunId = run.runId;

      for await (const rawEvent of this.runEvents(run.runId, binding)) {
        const mapped = mapper.map(rawEvent, { allowMessageStart: false });
        if (mapped.events.some((event) => event.type === "error")) {
          continuationFailed = true;
        }
        for (const event of mapped.events) {
          yield event;
        }
        if (mapped.done) {
          done = true;
          break;
        }
      }
      if (done && input.decision === "approved") {
        yield {
          type: "approval_result",
          messageId,
          approvalId: input.approvalId,
          status: continuationFailed ? "failed" : "succeeded",
        };
      }
    } catch (err) {
      input.session.unavailable = isAvailabilityError(err);
      if (input.decision === "approved") {
        yield {
          type: "approval_result",
          messageId,
          approvalId: input.approvalId,
          status: "failed",
        };
      }
      yield errorEventFromHermesError(err, messageId);
    } finally {
      const binding = maybeHermesBinding(input.session);
      if (binding !== null) binding.activeRunId = null;
      if (!done) {
        for (const event of mapper.flush()) {
          yield event;
        }
        yield { type: "message_done", messageId };
      }
    }
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

class HermesEventMapper {
  private readonly messageId: string;
  private readonly model: string;
  private pendingText = "";

  constructor(messageId: string, model: string) {
    this.messageId = messageId;
    this.model = model;
  }

  map(raw: unknown, options: { allowMessageStart: boolean }): {
    events: AgentEvent[];
    done: boolean;
  } {
    const record = raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {};
    const rawType = readString(record, "type") ?? readString(record, "event") ?? "";
    const type = normalizeHermesEventType(rawType);

    if (isRunStartEvent(type)) {
      return {
        events: options.allowMessageStart
          ? [{ type: "message_start", messageId: this.messageId, role: "agent", model: this.model }]
          : [],
        done: false,
      };
    }

    const commandOutput = commandOutputFromHermesEvent(record, type, this.messageId);
    if (commandOutput !== null) {
      return { events: [commandOutput], done: false };
    }

    const toolCall = toolCallFromHermesEvent(record, type, this.messageId);
    if (toolCall !== null) {
      return {
        events: [toolCall, ...approvalEventsFromHermesEvent(record, type, this.messageId)],
        done: false,
      };
    }

    const text = textDeltaFromHermesEvent(record, type);
    if (text !== null) {
      return { events: this.mapText(text), done: false };
    }

    const approvals = approvalEventsFromHermesEvent(record, type, this.messageId);
    if (approvals.length > 0) {
      return { events: approvals, done: false };
    }

    if (isRunCompletedEvent(type)) {
      return { events: [...this.flush(), { type: "message_done", messageId: this.messageId }], done: true };
    }
    if (isRunCancelledEvent(type)) {
      return {
        events: [
          ...this.flush(),
          {
            type: "error",
            messageId: this.messageId,
            code: "hermes_run_cancelled",
            message: "Hermes run was cancelled",
            recoverable: true,
          },
          { type: "message_done", messageId: this.messageId },
        ],
        done: true,
      };
    }
    if (isRunFailedEvent(type)) {
      return {
        events: [
          ...this.flush(),
          {
            type: "error",
            messageId: this.messageId,
            code: "hermes_run_failed",
            message: safeHermesEventMessage(record),
            recoverable: true,
            details: { event_type: rawType === "" ? "unknown" : rawType },
          },
          { type: "message_done", messageId: this.messageId },
        ],
        done: true,
      };
    }

    if (isIgnorableHermesEvent(record, type)) return { events: [], done: false };
    return {
      events: [
        {
          type: "error",
          messageId: this.messageId,
          code: "hermes_event_unsupported",
          message: "Hermes emitted an unsupported event shape",
          recoverable: true,
          details: { event_type: rawType === "" ? "unknown" : rawType },
        },
      ],
      done: false,
    };
  }

  flush(): AgentEvent[] {
    return this.drainPendingText(true);
  }

  private mapText(text: string): AgentEvent[] {
    if (this.pendingText === "") {
      const objectStart = text.indexOf("{");
      if (objectStart === -1) {
        return [{ type: "text_delta", messageId: this.messageId, text }];
      }
      const events = textDeltaEvent(this.messageId, text.slice(0, objectStart));
      this.pendingText = text.slice(objectStart);
      return [...events, ...this.drainPendingText(false)];
    }
    this.pendingText = `${this.pendingText}${text}`;
    return this.drainPendingText(false);
  }

  private drainPendingText(final: boolean): AgentEvent[] {
    const events: AgentEvent[] = [];
    while (this.pendingText !== "") {
      const objectStart = this.pendingText.indexOf("{");
      if (objectStart === -1) {
        if (final || events.length > 0 || this.pendingText.length > PROPOSED_ACTION_BUFFER_LIMIT) {
          events.push(...textDeltaEvent(this.messageId, this.pendingText));
          this.pendingText = "";
        }
        break;
      }
      if (objectStart > 0) {
        events.push(...textDeltaEvent(this.messageId, this.pendingText.slice(0, objectStart)));
        this.pendingText = this.pendingText.slice(objectStart);
        continue;
      }

      const objectEnd = findJsonObjectEnd(this.pendingText, 0);
      if (objectEnd === null) {
        if (final || this.pendingText.length > PROPOSED_ACTION_BUFFER_LIMIT) {
          events.push(...textDeltaEvent(this.messageId, this.pendingText));
          this.pendingText = "";
        }
        break;
      }

      const block = this.pendingText.slice(0, objectEnd);
      const actions = proposedActionsFromJsonText(block);
      if (actions.length > 0) {
        events.push(...actions.map((action) => approvalEventFromProposedAction(action, this.messageId)));
      } else {
        events.push(...textDeltaEvent(this.messageId, block));
      }
      this.pendingText = this.pendingText.slice(objectEnd);
    }
    return events;
  }
}

function textDeltaEvent(messageId: string, text: string): AgentEvent[] {
  return text === "" ? [] : [{ type: "text_delta", messageId, text }];
}

function textDeltaFromHermesEvent(
  record: Record<string, unknown>,
  type: string,
): string | null {
  const isTextSignal = type.includes("delta") || type.includes("text") || type.includes("assistant");
  const direct = readString(record, "text") ??
    readString(record, "delta") ??
    readString(record, "content");
  if (direct !== null && isTextSignal) {
    return direct;
  }
  const data = record.data;
  if (isTextSignal && data !== null && typeof data === "object" && !Array.isArray(data)) {
    const nested = data as Record<string, unknown>;
    return readString(nested, "text") ?? readString(nested, "delta") ?? readString(nested, "content");
  }
  return null;
}

function normalizeHermesEventType(type: string): string {
  return type.toLowerCase().replace(/_/g, ".").replace(/:/g, ".");
}

function isRunStartEvent(type: string): boolean {
  return type.includes("run") && (type.includes("created") || type.includes("started") || type.endsWith(".start"));
}

function isRunCompletedEvent(type: string): boolean {
  return (type.includes("run") || type.includes("response")) &&
    (type.includes("completed") || type.endsWith(".done") || type.endsWith(".succeeded"));
}

function isRunCancelledEvent(type: string): boolean {
  return type.includes("run") && (type.includes("cancelled") || type.includes("canceled"));
}

function isRunFailedEvent(type: string): boolean {
  return (type.includes("run") || type.includes("response")) &&
    (type.includes("failed") || type.endsWith(".error"));
}

function toolCallFromHermesEvent(
  record: Record<string, unknown>,
  type: string,
  messageId: string,
): AgentEvent | null {
  if (!isToolEvent(record, type)) return null;
  const status = toolStatusFromHermesEvent(record, type);
  if (status === null) return null;
  const label = toolLabelFromHermesEvent(record);
  const detail = toolDetailFromHermesEvent(record);
  return {
    type: "tool_call",
    messageId,
    toolCallId: toolCallIdFromHermesEvent(record, label),
    label,
    ...(detail === undefined ? {} : { detail }),
    status,
  };
}

function isToolEvent(record: Record<string, unknown>, type: string): boolean {
  return type.includes("tool") ||
    type.includes("function.call") ||
    type.includes("function.call.output") ||
    readString(record, "tool_call_id") !== null ||
    readString(record, "toolCallId") !== null ||
    readString(record, "tool_id") !== null ||
    readString(record, "toolId") !== null ||
    readString(record, "tool_name") !== null ||
    readString(record, "toolName") !== null;
}

function toolStatusFromHermesEvent(
  record: Record<string, unknown>,
  type: string,
): "running" | "done" | "failed" | null {
  const status = normalizeHermesEventType(readString(record, "status") ?? "");
  const combined = `${type}.${status}`;
  if (combined.includes("failed") || combined.includes("error")) return "failed";
  if (
    combined.includes("completed") ||
    combined.includes("succeeded") ||
    combined.endsWith(".done") ||
    combined.includes("function.call.output")
  ) {
    return "done";
  }
  if (
    combined.includes("started") ||
    combined.endsWith(".start") ||
    combined.includes("progress") ||
    combined.includes("delta") ||
    combined.includes("running") ||
    combined.includes("function.call")
  ) {
    return "running";
  }
  return null;
}

function toolLabelFromHermesEvent(record: Record<string, unknown>): string {
  const direct = readString(record, "label") ??
    readString(record, "tool_name") ??
    readString(record, "toolName") ??
    readString(record, "name") ??
    readString(record, "function_name") ??
    readString(record, "functionName");
  if (direct !== null && direct.trim() !== "") return truncateEventDetail(direct.trim());
  const tool = readRecord(record, "tool") ?? readRecord(record, "function");
  const nested = tool === null ? null : readString(tool, "name") ?? readString(tool, "label");
  return nested === null || nested.trim() === "" ? "Tool call" : truncateEventDetail(nested.trim());
}

function toolCallIdFromHermesEvent(record: Record<string, unknown>, label: string): string {
  const direct = readString(record, "tool_call_id") ??
    readString(record, "toolCallId") ??
    readString(record, "tool_id") ??
    readString(record, "toolId") ??
    readString(record, "call_id") ??
    readString(record, "callId") ??
    readString(record, "id");
  if (direct !== null && direct.trim() !== "") return truncateEventDetail(direct.trim());
  return `tool_${hashString(label)}`;
}

function toolDetailFromHermesEvent(record: Record<string, unknown>): string | undefined {
  const direct = readString(record, "detail") ?? readString(record, "summary");
  if (direct !== null && direct.trim() !== "") return sanitizeEventTextDetail(direct);
  const status = normalizeHermesEventType(readString(record, "status") ?? "");
  if (status.includes("failed") || status.includes("error")) return "Tool call failed";
  for (const key of ["input", "arguments", "output", "result"]) {
    const value = record[key];
    if (value === undefined) continue;
    if (containsProposedAction(value, 0)) return "Proposed Quay action";
    return key === "input" || key === "arguments" ? "Tool input available" : "Tool output available";
  }
  return undefined;
}

function commandOutputFromHermesEvent(
  record: Record<string, unknown>,
  type: string,
  messageId: string,
): AgentEvent | null {
  if (!isCommandOutputEvent(type)) return null;
  const approvalId = readString(record, "approval_id") ??
    readString(record, "approvalId") ??
    readString(record, "approval") ??
    readString(record, "id");
  const line = readString(record, "line") ??
    readString(record, "text") ??
    readString(record, "output") ??
    readString(record, "content");
  if (approvalId === null || approvalId.trim() === "" || line === null || line.trim() === "") {
    return null;
  }
  return {
    type: "command_output",
    messageId,
    approvalId: truncateEventDetail(approvalId.trim()),
    line: sanitizeEventTextDetail(line),
  };
}

function isCommandOutputEvent(type: string): boolean {
  return (type.includes("command") || type.includes("action") || type.includes("approval")) &&
    (type.includes("output") || type.includes("stdout") || type.includes("stderr"));
}

function isIgnorableHermesEvent(record: Record<string, unknown>, type: string): boolean {
  if (type === "" && Object.keys(record).length === 0) return true;
  return type.includes("debug") ||
    type.includes("heartbeat") ||
    type.includes("ping") ||
    type.includes("metrics") ||
    type.includes("trace");
}

function approvalEventsFromHermesEvent(
  record: Record<string, unknown>,
  type: string,
  messageId: string,
): AgentEvent[] {
  const actions: ProposedAction[] = [];
  collectProposedActions(record, actions, 0);
  if (isNativeApprovalEvent(type)) {
    actions.push(...proposedActionsFromValue(record));
    for (const key of ["data", "action", "approval", "proposed_action", "proposedAction"]) {
      const child = record[key];
      if (child !== undefined) actions.push(...proposedActionsFromValue(child));
    }
  }

  const deduped = new Map<string, ProposedAction>();
  for (const action of actions) {
    deduped.set(`${action.approvalId}:${action.command}`, action);
  }
  return [...deduped.values()].map((action) => approvalEventFromProposedAction(action, messageId));
}

function isNativeApprovalEvent(type: string): boolean {
  return type.includes("approval") ||
    type.includes("requires.action") ||
    (type.includes("action") && type.includes("proposed"));
}

function approvalEventFromProposedAction(action: ProposedAction, messageId: string): AgentEvent {
  return {
    type: "approval_required",
    messageId,
    approvalId: action.approvalId,
    command: action.command,
    description: action.description,
    affects: action.affects,
    ...(action.note === undefined ? {} : { note: action.note }),
  };
}

function collectProposedActions(value: unknown, out: ProposedAction[], depth: number): void {
  if (depth > 6) return;
  if (typeof value === "string") {
    if (value.includes("quay_proposed_action")) out.push(...proposedActionsFromJsonText(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectProposedActions(item, out, depth + 1);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.quay_proposed_action !== undefined) {
    out.push(...proposedActionsFromValue(record.quay_proposed_action));
  }
  for (const child of Object.values(record)) collectProposedActions(child, out, depth + 1);
}

function proposedActionsFromJsonText(text: string): ProposedAction[] {
  const actions: ProposedAction[] = [];
  for (const match of proposedActionMatchesFromText(text)) {
    actions.push(...match.actions);
  }
  return actions;
}

function proposedActionMatchesFromText(text: string): ProposedActionMatch[] {
  const matches: ProposedActionMatch[] = [];
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf("{", index);
    if (start === -1) break;
    const end = findJsonObjectEnd(text, start);
    if (end === null) break;
    const block = text.slice(start, end);
    const actions = proposedActionsFromJsonBlock(block);
    if (actions.length > 0) matches.push({ start, end, actions });
    index = end;
  }
  return matches;
}

function proposedActionsFromJsonBlock(block: string): ProposedAction[] {
  try {
    return proposedActionsFromValue(JSON.parse(block) as unknown);
  } catch {
    return [];
  }
}

function proposedActionsFromValue(value: unknown): ProposedAction[] {
  const actions: ProposedAction[] = [];
  collectProposedActionCandidates(value, actions, 0);
  return actions;
}

function collectProposedActionCandidates(value: unknown, out: ProposedAction[], depth: number): void {
  if (depth > 6 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectProposedActionCandidates(item, out, depth + 1);
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.quay_proposed_action !== undefined) {
    collectProposedActionCandidates(record.quay_proposed_action, out, depth + 1);
    return;
  }

  const action = proposedActionFromRecord(record);
  if (action !== null) out.push(action);
  for (const child of Object.values(record)) collectProposedActionCandidates(child, out, depth + 1);
}

function proposedActionFromRecord(record: Record<string, unknown>): ProposedAction | null {
  const command = readString(record, "command");
  if (command === null || command.trim() === "") return null;
  const description = readString(record, "description") ?? readString(record, "title");
  if (description === null || description.trim() === "") return null;
  const approvalId = readString(record, "approval_id") ??
    readString(record, "approvalId") ??
    `approval_${hashString(`${command}\n${description}`)}`;
  const note = readString(record, "note");
  return {
    approvalId: truncateEventDetail(approvalId.trim()),
    command: truncateEventDetail(command.trim()),
    description: truncateEventDetail(description.trim()),
    affects: affectsFromProposedAction(record.affects),
    ...(note === null || note.trim() === "" ? {} : { note: truncateEventDetail(note.trim()) }),
  };
}

function affectsFromProposedAction(value: unknown): Array<{ label: string; value: string }> {
  if (!Array.isArray(value)) return [];
  const affects: Array<{ label: string; value: string }> = [];
  for (const item of value.slice(0, 20)) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const label = readString(record, "label");
    const itemValue = readString(record, "value");
    if (label === null || itemValue === null) continue;
    affects.push({
      label: truncateEventDetail(label.trim()),
      value: truncateEventDetail(itemValue.trim()),
    });
  }
  return affects;
}

function findJsonObjectEnd(text: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return null;
}

function readRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>)[key];
  return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : null;
}

function containsProposedAction(value: unknown, depth: number): boolean {
  if (depth > 6) return false;
  if (typeof value === "string") return value.includes("quay_proposed_action");
  if (Array.isArray(value)) return value.some((item) => containsProposedAction(item, depth + 1));
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.quay_proposed_action !== undefined ||
    Object.values(record).some((child) => containsProposedAction(child, depth + 1));
}

function sanitizeEventTextDetail(value: string): string {
  return truncateEventDetail(value.trim().replace(secretLikeTextPattern(), "[redacted]"));
}

function secretLikeTextPattern(): RegExp {
  return /(bearer\s+[a-z0-9._~+/-]+|api[_ -]?key\s*[:=]\s*[^\s,;]+|token\s*[:=]\s*[^\s,;]+|secret\s*[:=]\s*[^\s,;]+)/gi;
}

function truncateEventDetail(value: string): string {
  return value.length <= EVENT_DETAIL_MAX_LENGTH ? value : `${value.slice(0, EVENT_DETAIL_MAX_LENGTH)}...[truncated]`;
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
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

function approvalDecisionFollowUp(input: {
  approvalId: string;
  decision: "approved" | "rejected";
  approval?: AgentApproval;
}): string {
  const approval = input.approval;
  const lines = [
    input.decision === "approved"
      ? `The operator approved proposed Quay action ${input.approvalId}.`
      : `The operator rejected proposed Quay action ${input.approvalId}.`,
  ];
  if (approval !== undefined) {
    lines.push(`Command: ${approval.command}`);
    lines.push(`Description: ${approval.description}`);
    if (approval.affects.length > 0) {
      lines.push(`Affected resources: ${approval.affects.map((item) => `${item.label}=${item.value}`).join(", ")}`);
    }
    if (approval.note !== undefined) lines.push(`Operator note: ${approval.note}`);
  }
  lines.push(
    input.decision === "approved"
      ? "Continue from this approval decision. In trusted-Hermes v1 this is operator consent and visibility, not proof that Quay Gateway enforced or executed the command."
      : "Do not run the rejected action. Continue by explaining the next safe option if useful.",
  );
  return lines.join("\n");
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
