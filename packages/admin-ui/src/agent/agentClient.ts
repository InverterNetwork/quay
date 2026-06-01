import { QuayAdminRequestError, getQuayAdminBaseUrl } from '../api/quayAdmin';
import type { AgentUiContext } from './agentContext';
import type { AgentEvent } from './agentTypes';

const DEFAULT_AGENT_PROVIDER = 'hermes';
const STREAM_ACCEPT = 'application/x-ndjson, text/event-stream';

export type AgentApprovalDecision = 'approved' | 'rejected';

export interface AgentGatewaySession {
  sessionId: string;
}

export interface CreateAgentSessionInput {
  context: AgentUiContext;
  agent?: string;
  signal?: AbortSignal;
}

export interface SendAgentMessageInput {
  sessionId: string;
  message: string;
  context: AgentUiContext;
  signal?: AbortSignal;
}

export interface DecideAgentApprovalInput {
  sessionId: string;
  approvalId: string;
  decision: AgentApprovalDecision;
  signal?: AbortSignal;
}

export interface StopAgentSessionInput {
  sessionId: string;
  signal?: AbortSignal;
}

export interface AgentGatewayClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  agent?: string;
}

interface AgentGatewayErrorBody {
  error?: string;
  message?: string;
  details?: Record<string, unknown>;
}

export class AgentGatewayProtocolError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AgentGatewayProtocolError';
    this.code = code;
    this.details = details;
  }
}

export class AgentGatewayClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly agent: string;

  constructor(options: AgentGatewayClientOptions = {}) {
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? getQuayAdminBaseUrl());
    this.fetchImpl = options.fetch ?? fetch;
    this.agent = options.agent ?? DEFAULT_AGENT_PROVIDER;
  }

  async createSession(input: CreateAgentSessionInput): Promise<AgentGatewaySession> {
    const body = await this.postJson<unknown>(
      '/v1/agent/sessions',
      { agent: input.agent ?? this.agent, context: input.context },
      input.signal,
    );
    const sessionId = readString(body, 'session_id') ?? readString(body, 'sessionId');
    if (!sessionId) {
      throw new AgentGatewayProtocolError('agent_session_missing_id', 'Agent Gateway did not return a session id.', body);
    }
    return { sessionId };
  }

  async *sendMessage(input: SendAgentMessageInput): AsyncGenerator<AgentEvent> {
    yield* this.postEventStream(
      `/v1/agent/sessions/${encodeURIComponent(input.sessionId)}/messages`,
      { message: input.message, context: input.context },
      input.signal,
    );
  }

  async *decideApproval(input: DecideAgentApprovalInput): AsyncGenerator<AgentEvent> {
    yield* this.postEventStream(
      `/v1/agent/sessions/${encodeURIComponent(input.sessionId)}/approvals/${encodeURIComponent(input.approvalId)}`,
      { decision: input.decision },
      input.signal,
    );
  }

  async stopSession(input: StopAgentSessionInput): Promise<void> {
    await this.postEmpty(`/v1/agent/sessions/${encodeURIComponent(input.sessionId)}/stop`, {}, input.signal);
  }

  private async postJson<T>(path: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal,
    });
    await assertOk(response);
    return response.json() as Promise<T>;
  }

  private async postEmpty(path: string, payload: unknown, signal?: AbortSignal): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal,
    });
    await assertOk(response);
  }

  private async *postEventStream(path: string, payload: unknown, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Accept: STREAM_ACCEPT,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal,
    });
    yield* parseAgentEventStream(response);
  }
}

export function createAgentGatewayClient(options?: AgentGatewayClientOptions): AgentGatewayClient {
  return new AgentGatewayClient(options);
}

export async function* parseAgentEventStream(response: Response): AsyncGenerator<AgentEvent> {
  await assertOk(response);
  if (!response.body) {
    throw new AgentGatewayProtocolError('agent_stream_missing_body', 'Agent Gateway stream response did not include a body.');
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    yield* parseSseEvents(response.body);
    return;
  }

  yield* parseNdjsonEvents(response.body);
}

async function* parseNdjsonEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<AgentEvent> {
  let buffer = '';
  for await (const chunk of readTextChunks(body)) {
    buffer += chunk;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line) yield parseAgentEventJson(line);
      newlineIndex = buffer.indexOf('\n');
    }
  }

  const finalLine = buffer.trim();
  if (finalLine) yield parseAgentEventJson(finalLine);
}

async function* parseSseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<AgentEvent> {
  let buffer = '';
  for await (const chunk of readTextChunks(body)) {
    buffer = normalizeNewlines(`${buffer}${chunk}`);
    let blockIndex = buffer.indexOf('\n\n');
    while (blockIndex !== -1) {
      const block = buffer.slice(0, blockIndex);
      buffer = buffer.slice(blockIndex + 2);
      const event = parseSseBlock(block);
      if (event) yield event;
      blockIndex = buffer.indexOf('\n\n');
    }
  }

  const finalBlock = buffer.trim();
  if (finalBlock) {
    const event = parseSseBlock(finalBlock);
    if (event) yield event;
  }
}

async function* readTextChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function parseSseBlock(block: string): AgentEvent | null {
  const dataLines: string[] = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(':')) continue;
    if (!line.startsWith('data:')) continue;
    const value = line.slice(5);
    dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
  }

  const data = dataLines.join('\n').trim();
  if (!data || data === '[DONE]') return null;
  return parseAgentEventJson(data);
}

function parseAgentEventJson(input: string): AgentEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (err) {
    throw new AgentGatewayProtocolError('agent_event_invalid_json', 'Agent Gateway emitted invalid event JSON.', {
      input,
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  return toAgentEvent(parsed);
}

function toAgentEvent(value: unknown): AgentEvent {
  if (!isRecord(value)) {
    throw new AgentGatewayProtocolError('agent_event_invalid_shape', 'Agent Gateway emitted a non-object event.', value);
  }

  switch (value.type) {
    case 'message_start':
      requireString(value, 'messageId');
      if (value.role !== 'agent') throw invalidEvent(value, 'message_start requires role "agent".');
      if (value.model !== undefined) requireString(value, 'model');
      return value as AgentEvent;
    case 'text_delta':
      requireString(value, 'messageId');
      requireString(value, 'text');
      return value as AgentEvent;
    case 'tool_call':
      requireString(value, 'messageId');
      requireString(value, 'toolCallId');
      requireString(value, 'label');
      if (!['running', 'done', 'failed'].includes(String(value.status))) throw invalidEvent(value, 'tool_call has an invalid status.');
      if (value.detail !== undefined) requireString(value, 'detail');
      return value as AgentEvent;
    case 'reference':
      requireString(value, 'messageId');
      if (!['task', 'pr', 'log', 'file', 'ci', 'config'].includes(String(value.kind))) throw invalidEvent(value, 'reference has an invalid kind.');
      requireString(value, 'id');
      requireString(value, 'label');
      if (value.url !== undefined) requireString(value, 'url');
      if (value.tone !== undefined && !['neutral', 'good', 'warn', 'danger'].includes(String(value.tone))) {
        throw invalidEvent(value, 'reference has an invalid tone.');
      }
      return value as AgentEvent;
    case 'approval_required':
      requireString(value, 'messageId');
      requireString(value, 'approvalId');
      if (value.title !== undefined) requireString(value, 'title');
      if (value.previewKind !== undefined && !['command', 'intent'].includes(String(value.previewKind))) throw invalidEvent(value, 'approval_required has an invalid previewKind.');
      requireString(value, 'command');
      requireString(value, 'description');
      if (!Array.isArray(value.affects)) throw invalidEvent(value, 'approval_required requires affects.');
      for (const affect of value.affects) {
        if (!isRecord(affect) || typeof affect.label !== 'string' || typeof affect.value !== 'string') {
          throw invalidEvent(value, 'approval_required affects must have string label and value.');
        }
      }
      if (value.note !== undefined) requireString(value, 'note');
      if (value.action !== undefined) validateApprovalAction(value.action, value);
      return value as AgentEvent;
    case 'command_output':
      requireString(value, 'messageId');
      requireString(value, 'approvalId');
      requireString(value, 'line');
      return value as AgentEvent;
    case 'approval_result':
      requireString(value, 'messageId');
      requireString(value, 'approvalId');
      if (!['running', 'rejected', 'succeeded', 'failed'].includes(String(value.status))) throw invalidEvent(value, 'approval_result has an invalid status.');
      if (value.exitCode !== undefined && typeof value.exitCode !== 'number') throw invalidEvent(value, 'approval_result exitCode must be a number.');
      return value as AgentEvent;
    case 'error':
      if (value.messageId !== undefined) requireString(value, 'messageId');
      requireString(value, 'code');
      requireString(value, 'message');
      if (typeof value.recoverable !== 'boolean') throw invalidEvent(value, 'error requires recoverable.');
      return value as AgentEvent;
    case 'message_done':
      requireString(value, 'messageId');
      return value as AgentEvent;
    default:
      throw invalidEvent(value, `Unsupported AgentEvent type "${String(value.type)}".`);
  }
}

function validateApprovalAction(action: unknown, event: Record<string, unknown>): void {
  if (!isRecord(action)) throw invalidEvent(event, 'approval_required action must be an object.');
  if (action.type !== 'quay.resume_task') throw invalidEvent(event, 'approval_required action has an unsupported type.');
  requireString(action, 'taskId');
  requireString(action, 'brief');
  if (action.reason !== undefined) requireString(action, 'reason');
  if (action.expectedOutcome !== undefined) requireString(action, 'expectedOutcome');
  if (action.scope !== undefined) requireString(action, 'scope');
  if (action.externalRef !== undefined) requireString(action, 'externalRef');
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;

  const body = await response.text().catch(() => '');
  const errorBody = parseErrorBody(body);
  throw new QuayAdminRequestError(
    errorBody?.message ?? `Quay Admin API request failed with HTTP ${response.status}`,
    response.status,
    errorBody?.error ?? 'request_failed',
    errorBody?.details,
  );
}

function parseErrorBody(body: string): AgentGatewayErrorBody | null {
  if (!body.trim()) return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!isRecord(parsed)) return null;
    return {
      error: typeof parsed.error === 'string' ? parsed.error : undefined,
      message: typeof parsed.message === 'string' ? parsed.message : undefined,
      details: isRecord(parsed.details) ? parsed.details : undefined,
    };
  } catch {
    return null;
  }
}

function invalidEvent(value: unknown, message: string): AgentGatewayProtocolError {
  return new AgentGatewayProtocolError('agent_event_invalid_shape', message, value);
}

function requireString(value: Record<string, unknown>, key: string): void {
  if (typeof value[key] !== 'string') throw invalidEvent(value, `Agent event field "${key}" must be a string.`);
}

function readString(value: unknown, key: string): string | null {
  if (!isRecord(value)) return null;
  return typeof value[key] === 'string' ? value[key] : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
