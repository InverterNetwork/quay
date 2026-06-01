import { randomUUID } from "node:crypto";
import type { AgentAdapter, AgentEvent, AgentSession, AgentUiContext } from "./agent_types.ts";

export function createEchoAgentAdapter(): AgentAdapter {
  return {
    provider: "echo",

    async createSession() {},

    async *sendMessage({ session, message, context }) {
      yield* noOpMessageEvents(session, message, context);
    },

    async *decideApproval({ session, approvalId, decision, approval }) {
      yield* noOpApprovalEvents(session, approvalId, decision, approval?.messageId);
    },

    async stop() {},
  };
}

function noOpMessageEvents(
  session: AgentSession,
  message: string,
  context: AgentUiContext,
): AgentEvent[] {
  const messageId = `agent_${randomUUID()}`;
  session.activeMessageId = messageId;
  const text = [
    `Temporary Quay Agent Gateway received your message: "${truncate(message, 160)}".`,
    `Current UI context is ${context.view} at ${context.urlPath}.`,
    context.summary,
  ].join("\n");
  session.activeMessageId = null;
  return [
    { type: "message_start", messageId, role: "agent", model: session.agent },
    { type: "text_delta", messageId, text },
    {
      type: "reference",
      messageId,
      kind: "config",
      id: context.view,
      label: context.summary,
      tone: "neutral",
    },
    { type: "message_done", messageId },
  ];
}

function noOpApprovalEvents(
  session: AgentSession,
  approvalId: string,
  decision: "approved" | "rejected",
  messageId = session.activeMessageId ?? `agent_${randomUUID()}`,
): AgentEvent[] {
  const status = decision === "approved" ? "succeeded" : "rejected";
  return [
    { type: "message_start", messageId, role: "agent", model: session.agent },
    {
      type: "approval_result",
      messageId,
      approvalId,
      status,
      ...(status === "succeeded" ? { exitCode: 0 } : {}),
    },
    {
      type: "text_delta",
      messageId,
      text: decision === "approved"
        ? "Temporary gateway recorded operator approval. No command was executed by the echo adapter."
        : "Temporary gateway recorded operator rejection. No command was executed by the echo adapter.",
    },
    { type: "message_done", messageId },
  ];
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}
