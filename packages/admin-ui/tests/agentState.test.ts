import { expect, test } from 'bun:test';
import { EMPTY_AGENT_THREAD, appendUserMessage, applyAgentEvent } from '../src/agent/agentState';
import type { AgentThreadState } from '../src/agent/agentTypes';

const capturedAt = '2026-05-30T09:00:00.000Z';

test('appends user messages and streams text deltas into one message part', () => {
  let state = appendUserMessage(EMPTY_AGENT_THREAD, 'user-1', 'What needs attention?', capturedAt);
  state = applyAgentEvent(state, { type: 'message_start', messageId: 'agent-1', role: 'agent', model: 'hermes-1.4' }, capturedAt);
  state = applyAgentEvent(state, { type: 'text_delta', messageId: 'agent-1', text: 'hello' }, capturedAt);
  state = applyAgentEvent(state, { type: 'text_delta', messageId: 'agent-1', text: ' world' }, capturedAt);

  const agentMessage = state.messages[1]!;
  expect(state.busy).toBe(true);
  expect(state.messages[0]?.parts[0]).toMatchObject({ kind: 'text', text: 'What needs attention?', done: true });
  expect(agentMessage.parts).toEqual([{ id: 'text:agent-1:0', kind: 'text', text: 'hello world', done: false }]);

  state = applyAgentEvent(state, { type: 'message_done', messageId: 'agent-1' }, capturedAt);
  expect(state.busy).toBe(false);
  expect(state.messages[1]?.streaming).toBe(false);
  expect(state.messages[1]?.parts[0]).toMatchObject({ done: true });
});

test('normalizes tool, reference, and approval lifecycle events', () => {
  let state: AgentThreadState = EMPTY_AGENT_THREAD;
  state = applyAgentEvent(state, { type: 'message_start', messageId: 'agent-1', role: 'agent' }, capturedAt);
  state = applyAgentEvent(state, { type: 'tool_call', messageId: 'agent-1', toolCallId: 'scan', label: 'Scanning', status: 'running' }, capturedAt);
  state = applyAgentEvent(state, { type: 'tool_call', messageId: 'agent-1', toolCallId: 'scan', label: 'Scanning', detail: '17 tasks', status: 'done' }, capturedAt);
  state = applyAgentEvent(state, { type: 'reference', messageId: 'agent-1', kind: 'task', id: 'abc123', label: 'Task abc123', tone: 'warn' }, capturedAt);
  state = applyAgentEvent(
    state,
    {
      type: 'approval_required',
      messageId: 'agent-1',
      approvalId: 'approval-1',
      title: 'Resume task',
      previewKind: 'intent',
      command: 'quay task retry abc123',
      description: 'Retry task abc123.',
      affects: [{ label: 'task', value: 'abc123' }],
      note: 'Safe retry',
      action: {
        type: 'quay.resume_task',
        taskId: 'abc123',
        reason: 'blocker_resolved',
        brief: 'Retry with the resolved dependency.',
      },
    },
    capturedAt,
  );
  state = applyAgentEvent(state, { type: 'command_output', messageId: 'agent-1', approvalId: 'approval-1', line: 'ok' }, capturedAt);
  state = applyAgentEvent(state, { type: 'approval_result', messageId: 'agent-1', approvalId: 'approval-1', status: 'succeeded', exitCode: 0 }, capturedAt);

  const parts = state.messages[0]?.parts ?? [];
  expect(parts.map((part) => part.kind)).toEqual(['tool', 'reference', 'approval']);
  expect(parts[0]).toMatchObject({ kind: 'tool', toolCallId: 'scan', detail: '17 tasks', status: 'done' });
  expect(parts[1]).toMatchObject({ kind: 'reference', refKind: 'task', refId: 'abc123', tone: 'warn' });
  expect(parts[2]).toMatchObject({
    kind: 'approval',
    title: 'Resume task',
    previewKind: 'intent',
    action: { type: 'quay.resume_task', taskId: 'abc123' },
    status: 'succeeded',
    exitCode: 0,
    output: ['ok'],
  });
});

test('ignores approval updates for missing messages', () => {
  const commandOutput = applyAgentEvent(EMPTY_AGENT_THREAD, { type: 'command_output', messageId: 'old-agent', approvalId: 'old-approval', line: 'late output' }, capturedAt);
  const approvalResult = applyAgentEvent(EMPTY_AGENT_THREAD, { type: 'approval_result', messageId: 'old-agent', approvalId: 'old-approval', status: 'succeeded', exitCode: 0 }, capturedAt);

  expect(commandOutput.messages).toEqual([]);
  expect(approvalResult.messages).toEqual([]);
});
