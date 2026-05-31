export type AgentReferenceTone = "neutral" | "good" | "warn" | "danger";

export type AgentEvent =
  | { type: "message_start"; messageId: string; role: "agent"; model?: string }
  | { type: "text_delta"; messageId: string; text: string }
  | {
    type: "tool_call";
    messageId: string;
    toolCallId: string;
    label: string;
    detail?: string;
    status: "running" | "done" | "failed";
  }
  | {
    type: "reference";
    messageId: string;
    kind: "task" | "pr" | "log" | "file" | "ci" | "config";
    id: string;
    label: string;
    url?: string;
    tone?: AgentReferenceTone;
  }
  | {
    type: "approval_required";
    messageId: string;
    approvalId: string;
    command: string;
    description: string;
    affects: Array<{ label: string; value: string }>;
    note?: string;
  }
  | { type: "command_output"; messageId: string; approvalId: string; line: string }
  | {
    type: "approval_result";
    messageId: string;
    approvalId: string;
    status: "running" | "rejected" | "succeeded" | "failed";
    exitCode?: number;
  }
  | { type: "error"; messageId?: string; code: string; message: string; recoverable: boolean; details?: unknown }
  | { type: "message_done"; messageId: string };

export interface AgentUiContext {
  view: "mission-control" | "configuration";
  scope: string;
  urlPath: string;
  capturedAt: string;
  summary: string;
  payload: Record<string, unknown>;
}

export type AgentFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface AgentApproval {
  messageId: string;
  approvalId: string;
  command: string;
  description: string;
  affects: Array<{ label: string; value: string }>;
  note?: string;
}

export interface AgentSession {
  sessionId: string;
  agent: string;
  provider: string;
  createdAt: string;
  lastContext: AgentUiContext;
  activeMessageId: string | null;
  unavailable: boolean;
  binding?: unknown;
}

export interface AgentAdapter {
  readonly provider: string;
  createSession(input: { session: AgentSession }): Promise<void>;
  sendMessage(input: {
    session: AgentSession;
    message: string;
    context: AgentUiContext;
  }): AsyncIterable<AgentEvent>;
  decideApproval(input: {
    session: AgentSession;
    approvalId: string;
    decision: "approved" | "rejected";
    approval?: AgentApproval;
  }): AsyncIterable<AgentEvent>;
  stop(input: { session: AgentSession }): Promise<void>;
}
