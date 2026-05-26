// Slack adapter contract. Slice 6 only needed the type to exist so the
// escalate-human service could fence against accidental Slack calls; slice
// 8 added posting + reply ingestion; slice 14 (adapters spec §7) extends
// the port with `fetchThreadContext` for assembling enqueue-time briefs.

export interface SlackPostInput {
  threadRef: string;
  body: string;
}

export interface SlackPostResult {
  ts: string;
}

export interface SlackReply {
  ts: string;
  authorBot: boolean;
  text: string;
}

export interface SlackThreadMessage {
  ts: string;
  authorBot: boolean;
  authorName: string | null;
  text: string;
}

export interface SlackThread {
  parent: SlackThreadMessage;
  replies: SlackThreadMessage[];
}

export interface SlackPort {
  post(input: SlackPostInput): Promise<SlackPostResult>;
  fenceTs(threadRef: string): Promise<string>;
  searchByNonce(threadRef: string, nonce: string): Promise<SlackReply | null>;
  listReplies(threadRef: string, lowerBoundTs: string): Promise<SlackReply[]>;
  // Returns the original conversation (parent + every reply, ordered) for
  // brief composition. Distinct from `listReplies`, which filters to
  // replies after a fence for `waiting_human` ingestion. Truncation above
  // `[adapters.slack].max_thread_messages` happens inside the adapter so
  // the marker is part of the returned `replies` payload (spec §7).
  // Throws on thread-not-found, 4xx/5xx, 429, and network/auth errors;
  // the caller (`ticketContext.fetch`) wraps as `adapter_error{adapter:"slack"}`.
  fetchThreadContext(threadRef: string): Promise<SlackThread>;
}
