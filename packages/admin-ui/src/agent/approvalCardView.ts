import type { AgentMessagePart } from './agentTypes';

type ApprovalPart = Extract<AgentMessagePart, { kind: 'approval' }>;

export interface ApprovalCardView {
  title: string;
  previewLabel: string;
  approveLabel: string;
}

export function approvalCardView(part: ApprovalPart): ApprovalCardView {
  const isIntent = part.previewKind === 'intent';
  return {
    title: part.title ?? (isIntent ? 'Proposed action' : 'Proposed command'),
    previewLabel: isIntent ? 'Intent preview' : 'Command',
    approveLabel: isIntent ? 'Approve' : 'Run command',
  };
}
