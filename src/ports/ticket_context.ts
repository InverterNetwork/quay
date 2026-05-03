// Composed ticket context returned by `fetchTicketContext`. Adapters spec §6.

export interface TicketAuthor {
  name: string;
  slack_id: string;
}

export interface TicketContext {
  external_ref: string;
  brief: string;
  ticket_snapshot: string;
  slack_thread_ref: string | null;
  tags: string[];
  authors: TicketAuthor[];
}
