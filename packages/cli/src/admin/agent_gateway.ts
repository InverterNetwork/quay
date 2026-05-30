import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AdminApiRuntime } from "./api.ts";
import { createEchoAgentAdapter } from "./agent_echo_adapter.ts";
import type { AgentAdapter, AgentSession, AgentUiContext } from "./agent_types.ts";
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
  ) => Promise<Response | null>;
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
  const sessions = new Map<string, AgentSession>();
  const adapter = agentAdapterForRuntime(runtime);

  return {
    async handle(request, segments, corsHeaders) {
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
          sessions.set(session.sessionId, session);
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
          const session = requireSession(sessions, segments[3]);
          const parsed = parseWithSchema(
            sendMessageSchema,
            await readJsonBody(request),
            "agent message request invalid",
          );
          session.lastContext = parsed.context;
          const events = adapter.sendMessage({
            session,
            message: parsed.message,
            context: parsed.context,
          });
          return eventStreamResponse(events, requestedStreamFormat(request), corsHeaders);
        }

        if (isApprovalRoute(segments)) {
          const session = requireSession(sessions, segments[3]);
          const approvalId = segments[5];
          if (approvalId === undefined) {
            throw new AgentGatewayHttpError(404, "agent_approval_not_found", "agent approval not found");
          }
          const parsed = parseWithSchema(
            approvalDecisionSchema,
            await readJsonBody(request),
            "agent approval request invalid",
          );
          const events = adapter.decideApproval({
            session,
            approvalId,
            decision: parsed.decision,
          });
          return eventStreamResponse(events, requestedStreamFormat(request), corsHeaders);
        }

        if (isStopRoute(segments)) {
          const session = requireSession(sessions, segments[3]);
          await adapter.stop({ session });
          session.activeMessageId = null;
          return jsonResponse(
            { session_id: session.sessionId, stopped: true },
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
  sessions: Map<string, AgentSession>,
  sessionId: string | undefined,
): AgentSession {
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
