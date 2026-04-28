// Slack adapter contract. Slice 6 only needs the type to exist so the
// escalate-human service can fence against accidental Slack calls; the real
// posting + reply ingestion landing in Slice 8.

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

export interface SlackPort {
  post(input: SlackPostInput): SlackPostResult;
  fenceTs(threadRef: string): string;
  searchByNonce(threadRef: string, nonce: string): SlackReply | null;
  listReplies(threadRef: string, lowerBoundTs: string): SlackReply[];
}
