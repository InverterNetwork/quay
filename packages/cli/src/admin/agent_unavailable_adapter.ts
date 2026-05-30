import type { AgentAdapter, AgentEvent } from "./agent_types.ts";

export function createUnavailableAgentAdapter(input: {
  provider: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}): AgentAdapter {
  return {
    provider: input.provider,

    async createSession({ session }) {
      session.unavailable = true;
    },

    async *sendMessage() {
      yield unavailableEvent(input);
    },

    async *decideApproval() {
      yield unavailableEvent(input);
    },

    async stop() {},
  };
}

function unavailableEvent(input: {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}): AgentEvent {
  return {
    type: "error",
    code: input.code,
    message: input.message,
    recoverable: true,
    ...(input.details === undefined ? {} : { details: input.details }),
  };
}
