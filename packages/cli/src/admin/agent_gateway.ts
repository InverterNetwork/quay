import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AdminApiRuntime } from "./api.ts";
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
          const events = adapter.sendMessage({
            session: state.session,
            message: parsed.message,
            context: parsed.context,
          });
          return eventStreamResponse(
            trackAgentEvents(state, events),
            requestedStreamFormat(request),
            corsHeaders,
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
          );
        }

        if (isStopRoute(segments)) {
          const state = requireSession(sessions, segments[3]);
          await adapter.stop({ session: state.session });
          state.session.activeMessageId = null;
          return jsonResponse(
            { session_id: state.session.sessionId, stopped: true },
            200,
            corsHeaders,
          );
        }
      } catch (err) {
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

async function* trackAgentEvents(
  state: AgentGatewaySessionState,
  events: AsyncIterable<AgentEvent>,
): AsyncIterable<AgentEvent> {
  for await (const event of events) {
    if (!rememberAgentEvent(state, event)) continue;
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
      yield event;
    }
  } catch (err) {
    success = false;
    input.approval.status = "failed";
    input.approval.updatedAt = new Date().toISOString();
    throw err;
  } finally {
    recordAgentApprovalAudit(input.runtime, input.request, input.audit, {
      session: input.state.session,
      approval: input.approval,
      decision: input.decision,
      success,
      status: success ? 200 : 500,
    });
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
      command: event.command,
      description: event.description,
      affects: event.affects,
      ...(event.note === undefined ? {} : { note: event.note }),
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

function recordAgentApprovalAudit(
  runtime: AdminApiRuntime,
  request: Request,
  audit: AdminRequestAuditContext,
  input: {
    session: AgentSession;
    approval: AgentApprovalState;
    decision: "approved" | "rejected";
    success: boolean;
    status: number;
  },
): void {
  runtime.adminAudit?.({
    action: "agent.approval.decide",
    method: request.method,
    path: new URL(request.url).pathname,
    timestamp: new Date().toISOString(),
    ...audit,
    success: input.success,
    status: input.status,
    operation_summary: [
      `agent approval ${input.decision}: ${truncateAuditText(input.approval.command, 160)}`,
    ],
    target_resources: [
      `agent-session:${input.session.sessionId}`,
      `agent-approval:${input.approval.approvalId}`,
      ...input.approval.affects.map((item) =>
        `${normalizeAuditResourcePart(item.label)}:${truncateAuditText(item.value, 80)}`
      ),
    ],
    session_id: input.session.sessionId,
    approval_id: input.approval.approvalId,
    decision: input.decision,
    result_status: input.approval.status,
    command: truncateAuditText(input.approval.command, 300),
    affects: input.approval.affects,
    ...(input.approval.exitCode === undefined ? {} : { exit_code: input.approval.exitCode }),
  });
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
): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        for await (const event of events) {
          const line = format === "sse"
            ? `event: agent_event\ndata: ${JSON.stringify(event)}\n\n`
            : `${JSON.stringify(event)}\n`;
          controller.enqueue(encoder.encode(line));
        }
        if (format === "sse") controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
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
