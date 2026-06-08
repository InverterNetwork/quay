import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AdminApiRuntime, AdminAuditEvent } from "./api.ts";
import { createEchoAgentAdapter } from "./agent_echo_adapter.ts";
import type { AdminRequestAuditContext } from "./auth.ts";
import type { AgentAdapter, AgentApproval, AgentEvent, AgentSession, AgentUiContext } from "./agent_types.ts";
import { createUnavailableAgentAdapter } from "./agent_unavailable_adapter.ts";
import {
  HermesAgentAdapter,
  hermesAgentConfigFromEnv,
  isHermesConfigError,
} from "./hermes_agent_adapter.ts";

type JsonHeaders = Record<string, string>;
type AgentAuditAction = Extract<AdminAuditEvent["action"], `agent.${string}`>;
type AgentAuditRetentionBucket = NonNullable<AdminAuditEvent["retention_bucket"]>;
type AgentAuditEffect = NonNullable<AdminAuditEvent["effect"]>;

const AGENT_AUDIT_TTL_DAYS: Record<AgentAuditRetentionBucket, number> = {
  agent_chat_7d: 7,
  agent_tool_7d: 7,
  agent_rejected_approval_7d: 7,
  agent_approved_action_30d: 30,
};
const AUDIT_DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_AGENT_STREAM_HEARTBEAT_MS = 5_000;

interface AgentGateway {
  handle: (
    request: Request,
    segments: string[],
    corsHeaders: JsonHeaders,
    audit: AdminRequestAuditContext,
  ) => Promise<Response | null>;
}

interface AgentGatewaySessionState {
  session: AgentSession;
  approvals: Map<string, AgentApprovalState>;
}

interface AgentApprovalState extends AgentApproval {
  status: "proposed" | "running" | "rejected" | "succeeded" | "failed";
  createdAt: string;
  updatedAt: string;
  decision?: "approved" | "rejected";
  exitCode?: number;
}

class AgentGatewayHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AgentGatewayHttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const agentUiContextSchema = z
  .object({
    view: z.enum(["mission-control", "configuration"]),
    scope: z.string(),
    urlPath: z.string(),
    capturedAt: z.string(),
    summary: z.string(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

const createSessionSchema = z
  .object({
    agent: z.string().min(1).default("hermes"),
    context: agentUiContextSchema,
  })
  .strict();

const sendMessageSchema = z
  .object({
    message: z.string().min(1),
    context: agentUiContextSchema,
  })
  .strict();

const approvalDecisionSchema = z
  .object({
    decision: z.enum(["approved", "rejected"]),
  })
  .strict();

export function createAgentGateway(runtime: AdminApiRuntime): AgentGateway {
  const sessions = new Map<string, AgentGatewaySessionState>();
  const adapter = agentAdapterForRuntime(runtime);

  return {
    async handle(request, segments, corsHeaders, audit) {
      try {
        if (isCreateSessionRoute(segments)) {
          const parsed = parseWithSchema(
            createSessionSchema,
            await readJsonBody(request),
            "agent session request invalid",
          );
          const session: AgentSession = {
            sessionId: `agent_${randomUUID()}`,
            agent: parsed.agent ?? "hermes",
            provider: adapter.provider,
            createdAt: new Date().toISOString(),
            lastContext: parsed.context,
            activeMessageId: null,
            unavailable: false,
          };
          await adapter.createSession({ session });
          sessions.set(session.sessionId, { session, approvals: new Map() });
          recordAgentAudit(runtime, request, audit, {
            action: "agent.session.create",
            success: true,
            status: 200,
            retentionBucket: "agent_chat_7d",
            session,
            context: parsed.context,
            operationSummary: [`agent session created for ${session.provider}`],
            targetResources: [`agent-session:${session.sessionId}`],
          });
          return jsonResponse(
            {
              session_id: session.sessionId,
              agent: session.agent,
              provider: session.provider,
              created_at: session.createdAt,
            },
            200,
            corsHeaders,
          );
        }

        if (isSendMessageRoute(segments)) {
          const state = requireSession(sessions, segments[3]);
          const parsed = parseWithSchema(
            sendMessageSchema,
            await readJsonBody(request),
            "agent message request invalid",
          );
          state.session.lastContext = parsed.context;
          recordAgentAudit(runtime, request, audit, {
            action: "agent.message.send",
            success: true,
            status: 200,
            retentionBucket: "agent_chat_7d",
            session: state.session,
            context: parsed.context,
            messageSummary: truncateAuditText(parsed.message, 300),
            argumentsSummary: truncateAuditText(parsed.message, 300),
            operationSummary: [`agent message sent: ${truncateAuditText(parsed.message, 120)}`],
            targetResources: [`agent-session:${state.session.sessionId}`],
            effect: "unknown",
          });
          const events = adapter.sendMessage({
            session: state.session,
            message: parsed.message,
            context: parsed.context,
          });
          return eventStreamResponse(
            trackAgentEvents({ runtime, request, audit, state, events }),
            requestedStreamFormat(request),
            corsHeaders,
            agentStreamHeartbeatMs(runtime),
          );
        }

        if (isApprovalRoute(segments)) {
          const state = requireSession(sessions, segments[3]);
          const approvalId = segments[5];
          if (approvalId === undefined) {
            throw new AgentGatewayHttpError(404, "agent_approval_not_found", "agent approval not found");
          }
          const parsed = parseWithSchema(
            approvalDecisionSchema,
            await readJsonBody(request),
            "agent approval request invalid",
          );
          const approval = state.approvals.get(approvalId);
          if (approval === undefined) {
            throw new AgentGatewayHttpError(
              404,
              "agent_approval_not_found",
              `agent approval "${approvalId}" not found`,
            );
          }
          if (approval.status !== "proposed") {
            throw new AgentGatewayHttpError(
              409,
              "agent_approval_already_decided",
              `agent approval "${approvalId}" has already been decided`,
              {
                approval_id: approval.approvalId,
                status: approval.status,
                decision: approval.decision,
              },
            );
          }
          approval.decision = parsed.decision;
          approval.status = parsed.decision === "approved" ? "running" : "rejected";
          approval.updatedAt = new Date().toISOString();
          recordAgentApprovalDecisionAudit(runtime, request, audit, {
            session: state.session,
            approval,
            decision: parsed.decision,
          });
          const events = adapter.decideApproval({
            session: state.session,
            approvalId,
            decision: parsed.decision,
            approval,
          });
          return eventStreamResponse(
            trackApprovalDecisionEvents({
              runtime,
              request,
              audit,
              state,
              approval,
              decision: parsed.decision,
              events,
            }),
            requestedStreamFormat(request),
            corsHeaders,
            agentStreamHeartbeatMs(runtime),
          );
        }

        if (isStopRoute(segments)) {
          const state = requireSession(sessions, segments[3]);
          await adapter.stop({ session: state.session });
          state.session.activeMessageId = null;
          recordAgentAudit(runtime, request, audit, {
            action: "agent.session.stop",
            success: true,
            status: 200,
            retentionBucket: "agent_chat_7d",
            session: state.session,
            operationSummary: ["agent session stopped"],
            targetResources: [`agent-session:${state.session.sessionId}`],
          });
          return jsonResponse(
            { session_id: state.session.sessionId, stopped: true },
            200,
            corsHeaders,
          );
        }
      } catch (err) {
        recordAgentGatewayErrorAudit(runtime, request, audit, segments, adapter.provider, err);
        return agentGatewayErrorResponse(err, corsHeaders);
      }

      return null;
    },
  };
}

export function agentGatewayAllowedMethods(segments: string[]): string | null {
  if (segments[0] !== "v1" || segments[1] !== "agent") return null;
  return isCreateSessionRoute(segments) ||
      isSendMessageRoute(segments) ||
      isApprovalRoute(segments) ||
      isStopRoute(segments)
    ? "POST, OPTIONS"
    : null;
}

function isCreateSessionRoute(segments: string[]): boolean {
  return segments.length === 3 &&
    segments[0] === "v1" &&
    segments[1] === "agent" &&
    segments[2] === "sessions";
}

function isSendMessageRoute(segments: string[]): boolean {
  return segments.length === 5 &&
    segments[0] === "v1" &&
    segments[1] === "agent" &&
    segments[2] === "sessions" &&
    segments[4] === "messages";
}

function isApprovalRoute(segments: string[]): boolean {
  return segments.length === 6 &&
    segments[0] === "v1" &&
    segments[1] === "agent" &&
    segments[2] === "sessions" &&
    segments[4] === "approvals";
}

function isStopRoute(segments: string[]): boolean {
  return segments.length === 5 &&
    segments[0] === "v1" &&
    segments[1] === "agent" &&
    segments[2] === "sessions" &&
    segments[4] === "stop";
}

function requireSession(
  sessions: Map<string, AgentGatewaySessionState>,
  sessionId: string | undefined,
): AgentGatewaySessionState {
  if (sessionId === undefined) {
    throw new AgentGatewayHttpError(404, "agent_session_not_found", "agent session not found");
  }
  const session = sessions.get(sessionId);
  if (session === undefined) {
    throw new AgentGatewayHttpError(
      404,
      "agent_session_not_found",
      `agent session "${sessionId}" not found`,
    );
  }
  return session;
}

async function* trackAgentEvents(input: {
  runtime: AdminApiRuntime;
  request: Request;
  audit: AdminRequestAuditContext;
  state: AgentGatewaySessionState;
  events: AsyncIterable<AgentEvent>;
}): AsyncIterable<AgentEvent> {
  for await (const event of input.events) {
    if (!rememberAgentEvent(input.state, event)) continue;
    recordAgentEventAudit(input.runtime, input.request, input.audit, input.state, event);
    yield event;
  }
}

async function* trackApprovalDecisionEvents(input: {
  runtime: AdminApiRuntime;
  request: Request;
  audit: AdminRequestAuditContext;
  state: AgentGatewaySessionState;
  approval: AgentApprovalState;
  decision: "approved" | "rejected";
  events: AsyncIterable<AgentEvent>;
}): AsyncIterable<AgentEvent> {
  let success = true;
  try {
    for await (const event of input.events) {
      if (!rememberAgentEvent(input.state, event)) continue;
      recordAgentEventAudit(input.runtime, input.request, input.audit, input.state, event);
      yield event;
    }
  } catch (err) {
    success = false;
    input.approval.status = "failed";
    input.approval.updatedAt = new Date().toISOString();
    throw err;
  } finally {
    if (input.decision === "approved") {
      recordAgentApprovalResultAudit(input.runtime, input.request, input.audit, {
        session: input.state.session,
        approval: input.approval,
        success,
        status: success ? 200 : 500,
      });
    }
  }
}

function rememberAgentEvent(state: AgentGatewaySessionState, event: AgentEvent): boolean {
  if (event.type === "approval_required") {
    const existing = state.approvals.get(event.approvalId);
    if (existing !== undefined && existing.status !== "proposed") {
      existing.updatedAt = new Date().toISOString();
      return false;
    }
    state.approvals.set(event.approvalId, {
      messageId: event.messageId,
      approvalId: event.approvalId,
      ...(event.title === undefined ? {} : { title: event.title }),
      ...(event.previewKind === undefined ? {} : { previewKind: event.previewKind }),
      command: event.command,
      description: event.description,
      affects: event.affects,
      ...(event.note === undefined ? {} : { note: event.note }),
      ...(event.action === undefined ? {} : { action: event.action }),
      status: "proposed",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return true;
  }

  if (event.type === "approval_result") {
    const approval = state.approvals.get(event.approvalId);
    if (approval === undefined) return true;
    approval.status = event.status;
    approval.updatedAt = new Date().toISOString();
    if (event.exitCode !== undefined) approval.exitCode = event.exitCode;
  }
  return true;
}

function recordAgentEventAudit(
  runtime: AdminApiRuntime,
  request: Request,
  audit: AdminRequestAuditContext,
  state: AgentGatewaySessionState,
  event: AgentEvent,
): void {
  if (event.type === "tool_call") {
    const effect = classifyToolCallEffect(event);
    recordAgentAudit(runtime, request, audit, {
      action: "agent.tool.call",
      success: event.status !== "failed",
      status: 200,
      retentionBucket: "agent_tool_7d",
      session: state.session,
      messageId: event.messageId,
      toolCallId: event.toolCallId,
      toolName: truncateAuditText(event.label, 120),
      argumentsSummary: truncateAuditText(event.detail ?? `tool ${event.status}`, 300),
      resultStatus: toolResultStatus(event.status),
      operationSummary: [`agent tool ${event.status}: ${truncateAuditText(event.label, 120)}`],
      targetResources: [
        `agent-session:${state.session.sessionId}`,
        `agent-tool:${normalizeAuditResourcePart(event.toolCallId)}`,
      ],
      effect,
    });
    return;
  }

  if (event.type === "approval_required") {
    recordAgentAudit(runtime, request, audit, {
      action: "agent.approval.required",
      success: true,
      status: 200,
      retentionBucket: "agent_chat_7d",
      session: state.session,
      messageId: event.messageId,
      approvalId: event.approvalId,
      toolName: "quay cli",
      command: truncateAuditText(event.command, 300),
      affects: auditAffects(event.affects),
      argumentsSummary: truncateAuditText(event.command, 300),
      resultStatus: "proposed",
      operationSummary: [`agent approval required: ${truncateAuditText(event.command, 160)}`],
      targetResources: approvalTargetResources(state.session.sessionId, event.approvalId, event.affects),
      effect: "mutating",
    });
    return;
  }

  if (event.type === "error") {
    recordAgentAudit(runtime, request, audit, {
      action: "agent.error",
      success: false,
      status: 200,
      retentionBucket: "agent_chat_7d",
      session: state.session,
      ...(event.messageId === undefined ? {} : { messageId: event.messageId }),
      errorCode: event.code,
      errorMessage: truncateAuditText(event.message, 300),
      resultStatus: "failed",
      argumentsSummary: truncateAuditText(event.message, 300),
      operationSummary: [`agent error: ${truncateAuditText(event.message, 160)}`],
      targetResources: [`agent-session:${state.session.sessionId}`],
    });
    return;
  }

  if (event.type === "command_output") {
    const approval = state.approvals.get(event.approvalId);
    recordAgentAudit(runtime, request, audit, {
      action: "agent.command.output",
      success: true,
      status: 200,
      retentionBucket: approval?.decision === "approved" ? "agent_approved_action_30d" : "agent_chat_7d",
      session: state.session,
      messageId: event.messageId,
      approvalId: event.approvalId,
      ...(approval === undefined ? {} : {
        command: truncateAuditText(approval.command, 300),
        affects: auditAffects(approval.affects),
      }),
      argumentsSummary: truncateAuditText(event.line, 300),
      toolName: "quay cli",
      ...(approval === undefined ? {} : { resultStatus: approval.status }),
      operationSummary: [`agent command output: ${truncateAuditText(event.line, 160)}`],
      targetResources: approval === undefined
        ? [`agent-session:${state.session.sessionId}`, `agent-approval:${event.approvalId}`]
        : approvalTargetResources(state.session.sessionId, event.approvalId, approval.affects),
      effect: "mutating",
    });
  }
}

function recordAgentApprovalDecisionAudit(
  runtime: AdminApiRuntime,
  request: Request,
  audit: AdminRequestAuditContext,
  input: {
    session: AgentSession;
    approval: AgentApprovalState;
    decision: "approved" | "rejected";
  },
): void {
  recordAgentAudit(runtime, request, audit, {
    action: "agent.approval.decide",
    success: true,
    status: 200,
    retentionBucket: input.decision === "approved"
      ? "agent_approved_action_30d"
      : "agent_rejected_approval_7d",
    session: input.session,
    approvalId: input.approval.approvalId,
    decision: input.decision,
    resultStatus: input.approval.status,
    command: truncateAuditText(input.approval.command, 300),
    affects: auditAffects(input.approval.affects),
    argumentsSummary: truncateAuditText(input.approval.command, 300),
    toolName: "quay cli",
    operationSummary: [
      `agent approval ${input.decision}: ${truncateAuditText(input.approval.command, 160)}`,
    ],
    targetResources: approvalTargetResources(
      input.session.sessionId,
      input.approval.approvalId,
      input.approval.affects,
    ),
    effect: "mutating",
    ...(input.approval.exitCode === undefined ? {} : { exitCode: input.approval.exitCode }),
  });
}

function recordAgentApprovalResultAudit(
  runtime: AdminApiRuntime,
  request: Request,
  audit: AdminRequestAuditContext,
  input: {
    session: AgentSession;
    approval: AgentApprovalState;
    success: boolean;
    status: number;
  },
): void {
  const success = input.success && input.approval.status !== "failed";
  recordAgentAudit(runtime, request, audit, {
    action: "agent.approval.result",
    success,
    status: input.status,
    retentionBucket: "agent_approved_action_30d",
    session: input.session,
    approvalId: input.approval.approvalId,
    decision: "approved",
    resultStatus: input.approval.status,
    command: truncateAuditText(input.approval.command, 300),
    affects: auditAffects(input.approval.affects),
    argumentsSummary: truncateAuditText(input.approval.command, 300),
    toolName: "quay cli",
    operationSummary: [
      `agent approval result ${input.approval.status}: ${truncateAuditText(input.approval.command, 160)}`,
    ],
    targetResources: approvalTargetResources(
      input.session.sessionId,
      input.approval.approvalId,
      input.approval.affects,
    ),
    effect: "mutating",
    ...(input.approval.exitCode === undefined ? {} : { exitCode: input.approval.exitCode }),
  });
}

function recordAgentGatewayErrorAudit(
  runtime: AdminApiRuntime,
  request: Request,
  audit: AdminRequestAuditContext,
  segments: string[],
  adapterId: string,
  err: unknown,
): void {
  const sessionId = agentSessionIdFromSegments(segments);
  const status = err instanceof AgentGatewayHttpError ? err.status : 500;
  const code = err instanceof AgentGatewayHttpError ? err.code : "agent_gateway_failed";
  const message = err instanceof Error ? err.message : String(err);
  recordAgentAudit(runtime, request, audit, {
    action: "agent.error",
    success: false,
    status,
    retentionBucket: "agent_chat_7d",
    adapterId,
    ...(sessionId === undefined ? {} : { sessionId }),
    errorCode: code,
    errorMessage: truncateAuditText(message, 300),
    resultStatus: "failed",
    operationSummary: [`agent gateway error: ${truncateAuditText(message, 160)}`],
    targetResources: sessionId === undefined ? ["agent-gateway"] : [`agent-session:${sessionId}`],
  });
}

function recordAgentAudit(
  runtime: AdminApiRuntime,
  request: Request,
  audit: AdminRequestAuditContext,
  input: {
    action: AgentAuditAction;
    success: boolean;
    status: number;
    retentionBucket: AgentAuditRetentionBucket;
    operationSummary: string[];
    targetResources: string[];
    session?: AgentSession;
    sessionId?: string;
    adapterId?: string;
    context?: AgentUiContext;
    messageId?: string;
    messageSummary?: string;
    toolCallId?: string;
    toolName?: string;
    argumentsSummary?: string;
    effect?: AgentAuditEffect;
    errorCode?: string;
    errorMessage?: string;
    approvalId?: string;
    decision?: "approved" | "rejected";
    resultStatus?: "proposed" | "running" | "rejected" | "succeeded" | "failed";
    command?: string;
    affects?: Array<{ label: string; value: string }>;
    exitCode?: number;
  },
): void {
  const timestamp = new Date().toISOString();
  const context = input.context ?? input.session?.lastContext;
  const adapterId = input.adapterId ?? input.session?.provider;
  const sessionId = input.sessionId ?? input.session?.sessionId;
  runtime.adminAudit?.({
    action: input.action,
    method: request.method,
    path: new URL(request.url).pathname,
    timestamp,
    ...audit,
    success: input.success,
    status: input.status,
    operation_summary: input.operationSummary,
    target_resources: input.targetResources,
    retention_bucket: input.retentionBucket,
    expires_at: agentAuditExpiresAt(timestamp, input.retentionBucket),
    ...(adapterId === undefined ? {} : { adapter_id: adapterId }),
    ...(input.session === undefined ? {} : { agent_id: input.session.agent }),
    ...(sessionId === undefined ? {} : { session_id: sessionId }),
    ...(context === undefined ? {} : contextAuditFields(context)),
    ...(input.messageId === undefined ? {} : { message_id: input.messageId }),
    ...(input.messageSummary === undefined ? {} : { message_summary: input.messageSummary }),
    ...(input.toolCallId === undefined ? {} : { tool_call_id: input.toolCallId }),
    ...(input.toolName === undefined ? {} : { tool_name: input.toolName }),
    ...(input.argumentsSummary === undefined ? {} : { arguments_summary: input.argumentsSummary }),
    ...(input.effect === undefined ? {} : { effect: input.effect }),
    ...(input.errorCode === undefined ? {} : { error_code: input.errorCode }),
    ...(input.errorMessage === undefined ? {} : { error_message: input.errorMessage }),
    ...(input.approvalId === undefined ? {} : { approval_id: input.approvalId }),
    ...(input.decision === undefined ? {} : { decision: input.decision }),
    ...(input.resultStatus === undefined ? {} : { result_status: input.resultStatus }),
    ...(input.command === undefined ? {} : { command: input.command }),
    ...(input.affects === undefined ? {} : { affects: input.affects }),
    ...(input.exitCode === undefined ? {} : { exit_code: input.exitCode }),
  });
}

function agentAuditExpiresAt(timestamp: string, bucket: AgentAuditRetentionBucket): string {
  return new Date(Date.parse(timestamp) + AGENT_AUDIT_TTL_DAYS[bucket] * AUDIT_DAY_MS).toISOString();
}

function contextAuditFields(context: AgentUiContext): Pick<
  AdminAuditEvent,
  "context_view" | "context_scope" | "context_url_path" | "context_summary" | "context_captured_at"
> {
  return {
    context_view: context.view,
    context_scope: truncateAuditText(context.scope, 120),
    context_url_path: truncateAuditText(context.urlPath, 200),
    context_summary: truncateAuditText(context.summary, 300),
    context_captured_at: context.capturedAt,
  };
}

function approvalTargetResources(
  sessionId: string,
  approvalId: string,
  affects: Array<{ label: string; value: string }>,
): string[] {
  return [
    `agent-session:${sessionId}`,
    `agent-approval:${approvalId}`,
    ...affects.map((item) =>
      `${normalizeAuditResourcePart(item.label)}:${truncateAuditText(item.value, 80)}`
    ),
  ];
}

function auditAffects(
  affects: Array<{ label: string; value: string }>,
): Array<{ label: string; value: string }> {
  return affects.map((item) => ({
    label: truncateAuditText(item.label, 80),
    value: truncateAuditText(item.value, 160),
  }));
}

function toolResultStatus(
  status: Extract<AgentEvent, { type: "tool_call" }>["status"],
): NonNullable<AdminAuditEvent["result_status"]> {
  if (status === "done") return "succeeded";
  if (status === "failed") return "failed";
  return "running";
}

function classifyToolCallEffect(
  event: Extract<AgentEvent, { type: "tool_call" }>,
): AgentAuditEffect {
  const text = `${event.label} ${event.detail ?? ""}`.toLowerCase();
  if (/\b(create|update|delete|cancel|retry|merge|push|approve|reject|apply|write|execute|run)\b/.test(text)) {
    return "mutating";
  }
  if (/\b(get|list|read|view|show|status|inspect|search|query|fetch|describe|summarize)\b/.test(text)) {
    return "read_only";
  }
  return "unknown";
}

function agentSessionIdFromSegments(segments: string[]): string | undefined {
  return segments[0] === "v1" && segments[1] === "agent" && segments[2] === "sessions"
    ? segments[3]
    : undefined;
}

function normalizeAuditResourcePart(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized === "" ? "resource" : normalized;
}

function truncateAuditText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function requestedStreamFormat(request: Request): "ndjson" | "sse" {
  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("text/event-stream") && !accept.includes("application/x-ndjson")) {
    return "sse";
  }
  return "ndjson";
}

function eventStreamResponse(
  events: AsyncIterable<unknown>,
  format: "ndjson" | "sse",
  extraHeaders: JsonHeaders,
  heartbeatMs = DEFAULT_AGENT_STREAM_HEARTBEAT_MS,
): Response {
  const encoder = new TextEncoder();
  const iterator = events[Symbol.asyncIterator]();
  let cancelled = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const stopHeartbeat = () => {
    if (heartbeat === null) return;
    clearInterval(heartbeat);
    heartbeat = null;
  };
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        heartbeat = setInterval(() => {
          if (!cancelled) controller.enqueue(encoder.encode(streamHeartbeatChunk(format)));
        }, heartbeatMs);
        try {
          while (!cancelled) {
            const next = await iterator.next();
            if (next.done === true) break;
            const event = next.value;
            const line = format === "sse"
              ? `event: agent_event\ndata: ${JSON.stringify(event)}\n\n`
              : `${JSON.stringify(event)}\n`;
            controller.enqueue(encoder.encode(line));
          }
          if (!cancelled) {
            if (format === "sse") controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          }
        } catch (err) {
          if (!cancelled) controller.error(err);
        } finally {
          stopHeartbeat();
          if (cancelled) await iterator.return?.();
        }
      },
      async cancel() {
        cancelled = true;
        stopHeartbeat();
        await iterator.return?.();
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": format === "sse"
          ? "text/event-stream; charset=utf-8"
          : "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache",
        ...extraHeaders,
      },
    },
  );
}

function streamHeartbeatChunk(format: "ndjson" | "sse"): string {
  if (format === "sse") return `: keep-alive ${new Date().toISOString()}\n\n`;
  return `${JSON.stringify({ type: "heartbeat", timestamp: new Date().toISOString() })}\n`;
}

function agentStreamHeartbeatMs(runtime: AdminApiRuntime): number {
  const configured = runtime.agentStreamHeartbeatMs;
  return configured !== undefined && Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_AGENT_STREAM_HEARTBEAT_MS;
}

function agentAdapterForRuntime(runtime: AdminApiRuntime): AgentAdapter {
  const env = runtime.env ?? process.env;
  const provider = env.QUAY_AGENT_PROVIDER ?? "echo";
  if (provider === "echo") return createEchoAgentAdapter();
  if (provider === "hermes") {
    try {
      const options: ConstructorParameters<typeof HermesAgentAdapter>[0] = {
        config: hermesAgentConfigFromEnv(env),
      };
      if (runtime.agentFetch !== undefined) options.fetch = runtime.agentFetch;
      return new HermesAgentAdapter(options);
    } catch (err) {
      if (isHermesConfigError(err)) {
        return createUnavailableAgentAdapter({
          provider: "hermes",
          code: err.code,
          message: err.message,
          details: err.details,
        });
      }
      throw err;
    }
  }
  return createUnavailableAgentAdapter({
    provider,
    code: "agent_provider_unsupported",
    message: `Agent provider "${provider}" is not supported`,
    details: { supported_providers: ["echo", "hermes"] },
  });
}

async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === "") {
    throw new AgentGatewayHttpError(
      400,
      "validation_error",
      "request body must be a JSON object",
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AgentGatewayHttpError(
      400,
      "validation_error",
      `request body is not valid JSON: ${message}`,
    );
  }
}

function parseWithSchema<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  label: string,
): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const summary = result.error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
  throw new AgentGatewayHttpError(
    400,
    "validation_error",
    `${label}: ${summary}`,
    { issues: result.error.issues },
  );
}

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: JsonHeaders = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function agentGatewayErrorResponse(
  err: unknown,
  extraHeaders: JsonHeaders,
): Response {
  if (err instanceof AgentGatewayHttpError) {
    return jsonResponse(
      err.details === undefined
        ? { error: err.code, message: err.message }
        : { error: err.code, message: err.message, details: err.details },
      err.status,
      extraHeaders,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return jsonResponse(
    {
      error: "agent_gateway_failed",
      message: `Agent Gateway request failed: ${message}`,
    },
    500,
    extraHeaders,
  );
}
