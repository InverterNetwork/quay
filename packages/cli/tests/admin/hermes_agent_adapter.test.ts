import { expect, test } from "bun:test";
import {
  HermesAgentAdapter,
  hermesAgentConfigFromEnv,
  type HermesSessionBinding,
} from "../../src/admin/hermes_agent_adapter.ts";
import type { AgentEvent, AgentFetch, AgentSession, AgentUiContext } from "../../src/admin/agent_types.ts";

const contextFixture: AgentUiContext = {
  view: "mission-control",
  scope: "all repos",
  urlPath: "/mission-control",
  capturedAt: "2026-05-30T09:00:00.000Z",
  summary: "Mission Control: 1 task visible.",
  payload: {
    taskCounts: {
      total: 1,
      attention: 0,
      running: 1,
      prLifecycle: 0,
      waiting: 0,
      terminal: 0,
    },
    filters: {
      repo: null,
      lane: null,
      sort: "updated",
    },
    visibleTasks: [],
    limits: {
      maxTasks: 50,
      truncatedFields: [],
    },
  },
};

test("hermesAgentConfigFromEnv validates required server-side configuration", () => {
  try {
    hermesAgentConfigFromEnv({});
    throw new Error("expected config validation to fail");
  } catch (err) {
    expect(err).toMatchObject({
      name: "HermesConfigError",
      details: {
        issues: expect.arrayContaining([
          expect.stringContaining("QUAY_HERMES_API_KEY"),
        ]),
      },
    });
  }

  const config = hermesAgentConfigFromEnv({
    QUAY_HERMES_API_BASE_URL: "http://hermes.local/",
    QUAY_HERMES_API_KEY: "secret-key",
    QUAY_HERMES_MODEL: "hermes-test",
    QUAY_HERMES_SESSION_KEY_PREFIX: "quay-dev",
  });

  expect(config).toEqual({
    apiBaseUrl: "http://hermes.local",
    apiKey: "secret-key",
    model: "hermes-test",
    sessionKeyPrefix: "quay-dev",
  });
});

test("HermesAgentAdapter creates a run and maps basic Runs API SSE events", async () => {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const fetchImpl: AgentFetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ path: url.pathname, init });
    if (url.pathname === "/health") return jsonResponse({ status: "ok" });
    if (url.pathname === "/v1/capabilities") {
      return jsonResponse({ features: ["run_submission", "run_events_sse", "run_stop"] });
    }
    if (url.pathname === "/v1/runs") {
      return jsonResponse({ run_id: "run-1" });
    }
    if (url.pathname === "/v1/runs/run-1/events") {
      return sseResponse([
        { type: "response.output_text.delta", delta: "hello" },
        { type: "response.output_text.delta", delta: " world" },
        { type: "run.completed" },
      ]);
    }
    return jsonResponse({ error: "not_found" }, { status: 404 });
  };
  const adapter = new HermesAgentAdapter({
    config: {
      apiBaseUrl: "http://hermes.local",
      apiKey: "secret-key",
      model: "hermes-test",
      sessionKeyPrefix: "quay-dev",
    },
    fetch: fetchImpl,
  });
  const session = makeSession();
  await adapter.createSession({ session });

  const events: AgentEvent[] = [];
  for await (const event of adapter.sendMessage({
    session,
    message: "What needs attention?",
    context: contextFixture,
  })) {
    events.push(event);
  }

  expect(events.map((event) => event.type)).toEqual([
    "message_start",
    "text_delta",
    "text_delta",
    "message_done",
  ]);
  expect(events[0]).toMatchObject({ role: "agent", model: "hermes-test" });
  expect(events[1]).toMatchObject({ text: "hello" });
  expect(events[2]).toMatchObject({ text: " world" });
  expect(calls.map((call) => call.path)).toEqual([
    "/health",
    "/v1/capabilities",
    "/v1/runs",
    "/v1/runs/run-1/events",
  ]);
  const runCall = calls.find((call) => call.path === "/v1/runs");
  if (runCall === undefined) throw new Error("expected run create call");
  const runBody = JSON.parse(String(runCall.init.body)) as Record<string, unknown>;
  expect(runBody.session_id).toBe("quay-ui:session-1");
  expect(runBody.model).toBe("hermes-test");
  expect(String(runBody.input)).toContain("What needs attention?");
  expect(String(runBody.input)).toContain("<quay-ui-context>");
  expect(String(runBody.input)).toContain("Mission Control: 1 task visible.");
  expect(new Headers(runCall.init.headers).get("authorization")).toBe("Bearer secret-key");
  expect(new Headers(runCall.init.headers).get("x-hermes-session-key")).toBe("quay-dev:session-1");
  expect(JSON.stringify(events)).not.toContain("secret-key");
});

test("HermesAgentAdapter stop calls the active Runs API stop endpoint", async () => {
  const paths: string[] = [];
  const fetchImpl: AgentFetch = async (input) => {
    paths.push(new URL(String(input)).pathname);
    return jsonResponse({ ok: true });
  };
  const adapter = new HermesAgentAdapter({
    config: {
      apiBaseUrl: "http://hermes.local",
      apiKey: "secret-key",
      model: "hermes-test",
      sessionKeyPrefix: "quay-dev",
    },
    fetch: fetchImpl,
  });
  const session = makeSession();
  await adapter.createSession({ session });
  (session.binding as HermesSessionBinding).activeRunId = "run-stop";

  await adapter.stop({ session });

  expect(paths).toEqual(["/v1/runs/run-stop/stop"]);
  expect((session.binding as HermesSessionBinding).activeRunId).toBeNull();
});

test("HermesAgentAdapter maps health failures into structured normalized error events", async () => {
  const adapter = new HermesAgentAdapter({
    config: {
      apiBaseUrl: "http://hermes.local",
      apiKey: "secret-key",
      model: "hermes-test",
      sessionKeyPrefix: "quay-dev",
    },
    fetch: async () => jsonResponse({ error: "offline" }, { status: 503 }),
  });
  const session = makeSession();
  await adapter.createSession({ session });

  const events: AgentEvent[] = [];
  for await (const event of adapter.sendMessage({
    session,
    message: "hello",
    context: contextFixture,
  })) {
    events.push(event);
  }

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "error",
    code: "hermes_health_failed",
    recoverable: true,
  });
  expect(session.unavailable).toBe(true);
  expect(JSON.stringify(events[0])).not.toContain("secret-key");
});

test("HermesAgentAdapter redacts upstream error bodies from browser events", async () => {
  const adapter = new HermesAgentAdapter({
    config: {
      apiBaseUrl: "http://hermes.local",
      apiKey: "secret-key",
      model: "hermes-test",
      sessionKeyPrefix: "quay-dev",
    },
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/health") return jsonResponse({ status: "ok" });
      return jsonResponse(
        {
          error: "debug",
          authorization: "Bearer secret-key",
          message: "request headers echoed by upstream",
        },
        { status: 500 },
      );
    },
  });
  const session = makeSession();
  await adapter.createSession({ session });

  const events: AgentEvent[] = [];
  for await (const event of adapter.sendMessage({
    session,
    message: "hello",
    context: contextFixture,
  })) {
    events.push(event);
  }

  const serialized = JSON.stringify(events);
  expect(events[0]).toMatchObject({
    type: "error",
    code: "hermes_capabilities_failed",
    details: { status: 500 },
  });
  expect(serialized).not.toContain("secret-key");
  expect(serialized).not.toContain("authorization");
  expect(serialized).not.toContain("request headers echoed");
});

test("HermesAgentAdapter redacts malformed run create payloads from browser events", async () => {
  const adapter = new HermesAgentAdapter({
    config: {
      apiBaseUrl: "http://hermes.local",
      apiKey: "secret-key",
      model: "hermes-test",
      sessionKeyPrefix: "quay-dev",
    },
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/health") return jsonResponse({ status: "ok" });
      if (path === "/v1/capabilities") {
        return jsonResponse({ features: ["run_submission", "run_events_sse", "run_stop"] });
      }
      return jsonResponse({
        authorization: "Bearer secret-key",
        debug: "missing run id",
      });
    },
  });
  const session = makeSession();
  await adapter.createSession({ session });

  const events: AgentEvent[] = [];
  for await (const event of adapter.sendMessage({
    session,
    message: "hello",
    context: contextFixture,
  })) {
    events.push(event);
  }

  const serialized = JSON.stringify(events);
  expect(events[0]).toMatchObject({
    type: "error",
    code: "hermes_run_create_failed",
    details: { response_shape: "object:debug" },
  });
  expect(serialized).not.toContain("secret-key");
  expect(serialized).not.toContain("authorization");
});

test("HermesAgentAdapter redacts Hermes SSE error event payloads from browser events", async () => {
  const adapter = new HermesAgentAdapter({
    config: {
      apiBaseUrl: "http://hermes.local",
      apiKey: "secret-key",
      model: "hermes-test",
      sessionKeyPrefix: "quay-dev",
    },
    fetch: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/health") return jsonResponse({ status: "ok" });
      if (path === "/v1/capabilities") {
        return jsonResponse({ features: ["run_submission", "run_events_sse", "run_stop"] });
      }
      if (path === "/v1/runs") return jsonResponse({ run_id: "run-error" });
      return sseResponse([
        {
          type: "run.failed",
          code: "tool_failed",
          message: "Authorization Bearer secret-key was echoed",
          authorization: "Bearer secret-key",
        },
      ]);
    },
  });
  const session = makeSession();
  await adapter.createSession({ session });

  const events: AgentEvent[] = [];
  for await (const event of adapter.sendMessage({
    session,
    message: "hello",
    context: contextFixture,
  })) {
    events.push(event);
  }

  const serialized = JSON.stringify(events);
  expect(events.find((event) => event.type === "error")).toMatchObject({
    type: "error",
    code: "hermes_run_failed",
    message: "Hermes run failed: tool_failed",
    details: { event_type: "run.failed" },
  });
  expect(serialized).not.toContain("secret-key");
  expect(serialized).not.toContain("Authorization Bearer");
  expect(serialized).not.toContain("authorization");
});

function makeSession(): AgentSession {
  return {
    sessionId: "session-1",
    agent: "hermes",
    provider: "hermes",
    createdAt: "2026-05-30T09:00:00.000Z",
    lastContext: contextFixture,
    activeMessageId: null,
    unavailable: false,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}
