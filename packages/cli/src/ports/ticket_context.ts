// Composed ticket context returned by `fetchTicketContext`. Adapters spec §6.

export interface TicketAuthor {
  name: string;
  slack_id: string;
}

export interface TicketContext {
  external_ref: string;
  repo: string;
  base_branch: string | null;
  umbrella: TicketUmbrellaContext | null;
  brief: string;
  ticket_snapshot: string;
  slack_thread_ref: string | null;
  tags: string[];
  worker_execution: "oneshot" | "goal";
  authors: TicketAuthor[];
}

export interface TicketUmbrellaContext {
  external_ref: string;
  base_branch: string | null;
  feature_branch: string | null;
  depends_on: string[];
}
