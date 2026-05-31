import type { Tone } from '../styles/tones';

export type AgentConnectionStatus = Tone;
export type AgentReferenceKind = 'task' | 'pr' | 'log' | 'file' | 'ci' | 'config';
export type AgentReferenceTone = Exclude<Tone, 'accent'>;
export type AgentApprovalPreviewKind = 'command' | 'intent';

export type AgentApprovalAction =
  | {
      type: 'quay.resume_task';
      taskId: string;
      reason?: string;
      brief: string;
      expectedOutcome?: string;
      scope?: string;
      externalRef?: string;
    };

export interface AgentContextSummary {
  agentId: string;
  agentName: string;
  model?: string;
  statusLabel: string;
  scopeLabel?: string;
}

export type AgentEvent =
  | { type: 'message_start'; messageId: string; role: 'agent'; model?: string }
  | { type: 'text_delta'; messageId: string; text: string }
  | {
      type: 'tool_call';
      messageId: string;
      toolCallId: string;
      label: string;
      detail?: string;
      status: 'running' | 'done' | 'failed';
    }
  | {
      type: 'reference';
      messageId: string;
      kind: AgentReferenceKind;
      id: string;
      label: string;
      url?: string;
      tone?: AgentReferenceTone;
    }
  | {
      type: 'approval_required';
      messageId: string;
      approvalId: string;
      title?: string;
      previewKind?: AgentApprovalPreviewKind;
      command: string;
      description: string;
      affects: Array<{ label: string; value: string }>;
      note?: string;
      action?: AgentApprovalAction;
    }
  | { type: 'command_output'; messageId: string; approvalId: string; line: string }
  | {
      type: 'approval_result';
      messageId: string;
      approvalId: string;
      status: 'running' | 'rejected' | 'succeeded' | 'failed';
      exitCode?: number;
    }
  | { type: 'error'; messageId?: string; code: string; message: string; recoverable: boolean; details?: unknown }
  | { type: 'message_done'; messageId: string };

export type AgentMessageRole = 'user' | 'agent';

export type AgentMessagePart =
  | { id: string; kind: 'text'; text: string; done: boolean }
  | {
      id: string;
      kind: 'tool';
      toolCallId: string;
      label: string;
      detail?: string;
      status: 'running' | 'done' | 'failed';
    }
  | {
      id: string;
      kind: 'reference';
      refKind: AgentReferenceKind;
      refId: string;
      label: string;
      url?: string;
      tone?: AgentReferenceTone;
    }
  | {
      id: string;
      kind: 'approval';
      approvalId: string;
      title?: string;
      previewKind?: AgentApprovalPreviewKind;
      command: string;
      description: string;
      affects: Array<{ label: string; value: string }>;
      note?: string;
      action?: AgentApprovalAction;
      status: 'proposed' | 'running' | 'rejected' | 'succeeded' | 'failed';
      exitCode?: number;
      output: string[];
    }
  | { id: string; kind: 'error'; code: string; message: string; recoverable: boolean };

export interface AgentMessage {
  id: string;
  role: AgentMessageRole;
  model?: string;
  createdAt: string;
  streaming?: boolean;
  parts: AgentMessagePart[];
}

export interface AgentThreadState {
  messages: AgentMessage[];
  busy: boolean;
}
