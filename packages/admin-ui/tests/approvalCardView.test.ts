import { expect, test } from 'bun:test';
import { approvalCardView } from '../src/agent/approvalCardView';
import type { AgentMessagePart } from '../src/agent/agentTypes';

test('approval card view labels typed resume-task actions as intent approvals', () => {
  const part: Extract<AgentMessagePart, { kind: 'approval' }> = {
    id: 'approval:resume',
    kind: 'approval',
    approvalId: 'resume',
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
    status: 'proposed',
    output: [],
  };

  expect(approvalCardView(part)).toEqual({
    title: 'Resume task',
    previewLabel: 'Intent preview',
    approveLabel: 'Approve',
  });
});
