import { expect, test } from 'bun:test';
import { QuayAdminRequestError } from '../src/api/quayAdmin';
import { AgentGatewayClient, AgentGatewayProtocolError, parseAgentEventStream } from '../src/agent/agentClient';
import { EMPTY_AGENT_THREAD, reduceAgentEventStream } from '../src/agent/agentState';
import type { AgentUiContext } from '../src/agent/agentContext';
import type { AgentEvent } from '../src/agent/agentTypes';

const capturedAt = '2026-05-30T09:00:00.000Z';

test('parses NDJSON AgentEvents and reduces them into thread state', async () => {
  const response = streamResponse(
    [
      `${JSON.stringify({ type: 'message_start', messageId: 'agent-1', role: 'agent', model: 'hermes' })}\n{"type":"text_delta","messageId":"agent-1","text":"hello`,
      ` world"}\n${JSON.stringify({ type: 'message_done', messageId: 'agent-1' })}\n`,
    ],
    'application/x-ndjson',
  );

  const state = await reduceAgentEventStream(EMPTY_AGENT_THREAD, parseAgentEventStream(response), () => capturedAt);

  expect(state.busy).toBe(false);
  expect(state.messages).toHaveLength(1);
  expect(state.messages[0]?.parts[0]).toMatchObject({ kind: 'text', text: 'hello world', done: true });
});

test('parses Server-Sent Events AgentEvents', async () => {
  const response = streamResponse(
    [
      `event: agent_event\ndata: ${JSON.stringify({ type: 'message_start', messageId: 'agent-1', role: 'agent' })}\n\n`,
      `data: ${JSON.stringify({ type: 'tool_call', messageId: 'agent-1', toolCallId: 'list', label: 'List tasks', status: 'running' })}\n\n`,
      'data: [DONE]\n\n',
    ],
    'text/event-stream',
  );

  const events: AgentEvent[] = [];
  for await (const event of parseAgentEventStream(response)) {
    events.push(event);
  }

  expect(events).toEqual([
    { type: 'message_start', messageId: 'agent-1', role: 'agent' },
    { type: 'tool_call', messageId: 'agent-1', toolCallId: 'list', label: 'List tasks', status: 'running' },
  ]);
});

test('parses typed resume-task approval AgentEvents', async () => {
  const approval = {
    type: 'approval_required',
    messageId: 'agent-1',
    approvalId: 'approval-resume',
    title: 'Resume task',
    previewKind: 'intent',
    command: 'quay.resume_task task_id=abc123 reason=blocker_resolved',
    description: 'Resume task abc123.',
    affects: [{ label: 'task', value: 'abc123' }],
    action: {
      type: 'quay.resume_task',
      taskId: 'abc123',
      reason: 'blocker_resolved',
      brief: 'Continue after the dependency landed.',
    },
  };
  const response = streamResponse([`${JSON.stringify(approval)}\n`], 'application/x-ndjson');

  const events: AgentEvent[] = [];
  for await (const event of parseAgentEventStream(response)) {
    events.push(event);
  }

  expect(events).toEqual([approval]);
});

test('client posts context to gateway endpoints and streams normalized events', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = new AgentGatewayClient({
    baseUrl: 'http://quay.test/',
    fetch: async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      const path = new URL(String(input)).pathname;
      if (path === '/v1/agent/sessions') {
        return jsonResponse({ session_id: 'session-1' });
      }
      if (path === '/v1/agent/sessions/session-1/messages') {
        return streamResponse([`${JSON.stringify({ type: 'message_start', messageId: 'agent-1', role: 'agent' })}\n`], 'application/x-ndjson');
      }
      if (path === '/v1/agent/sessions/session-1/approvals/approval-1') {
        return streamResponse([`${JSON.stringify({ type: 'approval_result', messageId: 'agent-1', approvalId: 'approval-1', status: 'rejected' })}\n`], 'application/x-ndjson');
      }
      if (path === '/v1/agent/sessions/session-1/stop') {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: 'not_found', message: 'No route' }, { status: 404 });
    },
  });

  const session = await client.createSession({ context: contextFixture });
  const messageEvents: AgentEvent[] = [];
  for await (const event of client.sendMessage({ sessionId: session.sessionId, message: 'What needs attention?', context: contextFixture })) {
    messageEvents.push(event);
  }
  const approvalEvents: AgentEvent[] = [];
  for await (const event of client.decideApproval({ sessionId: session.sessionId, approvalId: 'approval-1', decision: 'rejected' })) {
    approvalEvents.push(event);
  }
  await client.stopSession({ sessionId: session.sessionId });

  expect(session).toEqual({ sessionId: 'session-1' });
  expect(messageEvents).toEqual([{ type: 'message_start', messageId: 'agent-1', role: 'agent' }]);
  expect(approvalEvents).toEqual([{ type: 'approval_result', messageId: 'agent-1', approvalId: 'approval-1', status: 'rejected' }]);
  expect(calls.map((call) => call.url)).toEqual([
    'http://quay.test/v1/agent/sessions',
    'http://quay.test/v1/agent/sessions/session-1/messages',
    'http://quay.test/v1/agent/sessions/session-1/approvals/approval-1',
    'http://quay.test/v1/agent/sessions/session-1/stop',
  ]);
  expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ agent: 'hermes', context: contextFixture });
  expect(JSON.parse(String(calls[1]?.init.body))).toMatchObject({ message: 'What needs attention?', context: contextFixture });
  expect(JSON.parse(String(calls[2]?.init.body))).toEqual({ decision: 'rejected' });
  expect(new Headers(calls[1]?.init.headers).get('Accept')).toBe('application/x-ndjson, text/event-stream');
});

test('throws typed errors for gateway failures and invalid event shapes', async () => {
  await expect(
    parseAgentEventStream(jsonResponse({ error: 'agent_offline', message: 'Agent offline', details: { provider: 'hermes' } }, { status: 503 }))
      .next(),
  ).rejects.toMatchObject({
    name: 'QuayAdminRequestError',
    status: 503,
    code: 'agent_offline',
    details: { provider: 'hermes' },
  } satisfies Partial<QuayAdminRequestError>);

  await expect(
    parseAgentEventStream(streamResponse(['{"type":"text_delta","messageId":"agent-1"}\n'], 'application/x-ndjson')).next(),
  ).rejects.toBeInstanceOf(AgentGatewayProtocolError);
});

const contextFixture: AgentUiContext = {
  view: 'mission-control',
  scope: 'all repos',
  urlPath: '/mission-control',
  capturedAt,
  summary: 'Mission Control: 1 task visible.',
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
      sort: 'updated',
    },
    visibleTasks: [],
    limits: {
      maxTasks: 50,
      truncatedFields: [],
    },
  },
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init.headers,
    },
  });
}

function streamResponse(chunks: string[], contentType: string): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
    { headers: { 'content-type': contentType } },
  );
}
