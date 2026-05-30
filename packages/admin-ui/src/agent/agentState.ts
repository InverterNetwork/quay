import type { AgentEvent, AgentMessage, AgentMessagePart, AgentThreadState } from './agentTypes';

export const EMPTY_AGENT_THREAD: AgentThreadState = {
  messages: [],
  busy: false,
};

export function appendUserMessage(state: AgentThreadState, id: string, text: string, createdAt: string): AgentThreadState {
  return {
    ...state,
    messages: [
      ...state.messages,
      {
        id,
        role: 'user',
        createdAt,
        parts: [{ id: `${id}:text`, kind: 'text', text, done: true }],
      },
    ],
  };
}

export function applyAgentEvent(state: AgentThreadState, event: AgentEvent, capturedAt: string): AgentThreadState {
  if (event.type === 'message_start') {
    const existing = state.messages.find((message) => message.id === event.messageId);
    if (existing) {
      return mapMessage(state, event.messageId, (message) => ({
        ...message,
        model: event.model ?? message.model,
        streaming: true,
      }));
    }

    return {
      ...state,
      busy: true,
      messages: [
        ...state.messages,
        {
          id: event.messageId,
          role: event.role,
          model: event.model,
          createdAt: capturedAt,
          streaming: true,
          parts: [],
        },
      ],
    };
  }

  if (event.type === 'text_delta') {
    return mapAgentMessage(state, event.messageId, capturedAt, (message) => ({
      ...message,
      parts: appendTextDelta(message.parts, event.messageId, event.text),
    }));
  }

  if (event.type === 'tool_call') {
    return mapAgentMessage(state, event.messageId, capturedAt, (message) => ({
      ...message,
      parts: upsertPart(message.parts, `tool:${event.toolCallId}`, {
        id: `tool:${event.toolCallId}`,
        kind: 'tool',
        toolCallId: event.toolCallId,
        label: event.label,
        detail: event.detail,
        status: event.status,
      }),
    }));
  }

  if (event.type === 'reference') {
    return mapAgentMessage(state, event.messageId, capturedAt, (message) => ({
      ...message,
      parts: [
        ...message.parts,
        {
          id: `ref:${event.kind}:${event.id}:${message.parts.length}`,
          kind: 'reference',
          refKind: event.kind,
          refId: event.id,
          label: event.label,
          url: event.url,
          tone: event.tone,
        },
      ],
    }));
  }

  if (event.type === 'approval_required') {
    return mapAgentMessage(state, event.messageId, capturedAt, (message) => ({
      ...message,
      parts: upsertPart(message.parts, `approval:${event.approvalId}`, {
        id: `approval:${event.approvalId}`,
        kind: 'approval',
        approvalId: event.approvalId,
        command: event.command,
        description: event.description,
        affects: event.affects,
        note: event.note,
        status: 'proposed',
        output: [],
      }),
    }));
  }

  if (event.type === 'command_output') {
    if (!hasMessage(state, event.messageId)) return state;
    return mapAgentMessage(state, event.messageId, capturedAt, (message) => ({
      ...message,
      parts: message.parts.map((part) =>
        part.kind === 'approval' && part.approvalId === event.approvalId
          ? { ...part, output: [...part.output, event.line] }
          : part,
      ),
    }));
  }

  if (event.type === 'approval_result') {
    if (!hasMessage(state, event.messageId)) return state;
    return mapAgentMessage(state, event.messageId, capturedAt, (message) => ({
      ...message,
      parts: message.parts.map((part) =>
        part.kind === 'approval' && part.approvalId === event.approvalId
          ? { ...part, status: event.status, exitCode: event.exitCode }
          : part,
      ),
    }));
  }

  if (event.type === 'error') {
    if (!event.messageId) {
      return {
        ...state,
        busy: false,
        messages: [
          ...state.messages,
          {
            id: `error:${event.code}:${state.messages.length}`,
            role: 'agent',
            createdAt: capturedAt,
            streaming: false,
            parts: [{ id: `error:${event.code}`, kind: 'error', code: event.code, message: event.message, recoverable: event.recoverable }],
          },
        ],
      };
    }

    return mapAgentMessage({ ...state, busy: false }, event.messageId, capturedAt, (message) => ({
      ...message,
      streaming: false,
      parts: [
        ...message.parts,
        {
          id: `error:${event.code}:${message.parts.length}`,
          kind: 'error',
          code: event.code,
          message: event.message,
          recoverable: event.recoverable,
        },
      ],
    }));
  }

  return mapAgentMessage({ ...state, busy: false }, event.messageId, capturedAt, (message) => ({
    ...message,
    streaming: false,
    parts: message.parts.map((part) => (part.kind === 'text' ? { ...part, done: true } : part)),
  }));
}

export function stopAgentThread(state: AgentThreadState): AgentThreadState {
  return {
    ...state,
    busy: false,
    messages: state.messages.map((message) =>
      message.streaming
        ? {
            ...message,
            streaming: false,
            parts: message.parts.map((part) => (part.kind === 'text' ? { ...part, done: true } : part)),
          }
        : message,
    ),
  };
}

function mapAgentMessage(
  state: AgentThreadState,
  messageId: string,
  capturedAt: string,
  fn: (message: AgentMessage) => AgentMessage,
): AgentThreadState {
  const exists = state.messages.some((message) => message.id === messageId);
  const next = exists
    ? state
    : {
        ...state,
        messages: [
          ...state.messages,
          { id: messageId, role: 'agent' as const, createdAt: capturedAt, streaming: true, parts: [] },
        ],
      };
  return mapMessage(next, messageId, fn);
}

function hasMessage(state: AgentThreadState, messageId: string) {
  return state.messages.some((message) => message.id === messageId);
}

function mapMessage(state: AgentThreadState, messageId: string, fn: (message: AgentMessage) => AgentMessage): AgentThreadState {
  return {
    ...state,
    messages: state.messages.map((message) => (message.id === messageId ? fn(message) : message)),
  };
}

function appendTextDelta(parts: AgentMessagePart[], messageId: string, text: string): AgentMessagePart[] {
  const last = parts[parts.length - 1];
  if (last?.kind === 'text' && !last.done) {
    return [...parts.slice(0, -1), { ...last, text: `${last.text}${text}` }];
  }

  return [...parts, { id: `text:${messageId}:${parts.length}`, kind: 'text', text, done: false }];
}

function upsertPart(parts: AgentMessagePart[], id: string, next: AgentMessagePart): AgentMessagePart[] {
  const existing = parts.findIndex((part) => part.id === id);
  if (existing === -1) return [...parts, next];

  const copy = parts.slice();
  copy[existing] = next;
  return copy;
}
