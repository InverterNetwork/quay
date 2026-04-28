import type {
  SlackPort,
  SlackPostInput,
  SlackPostResult,
  SlackReply,
} from "../../../src/ports/slack.ts";

export class FakeSlack implements SlackPort {
  postCalls: SlackPostInput[] = [];
  fenceCalls: string[] = [];
  searchCalls: { threadRef: string; nonce: string }[] = [];
  listCalls: { threadRef: string; lowerBoundTs: string }[] = [];

  post(input: SlackPostInput): SlackPostResult {
    this.postCalls.push(input);
    return { ts: `posted-${this.postCalls.length}` };
  }

  fenceTs(threadRef: string): string {
    this.fenceCalls.push(threadRef);
    return "fence-ts";
  }

  searchByNonce(threadRef: string, nonce: string): SlackReply | null {
    this.searchCalls.push({ threadRef, nonce });
    return null;
  }

  listReplies(threadRef: string, lowerBoundTs: string): SlackReply[] {
    this.listCalls.push({ threadRef, lowerBoundTs });
    return [];
  }

  totalCalls(): number {
    return (
      this.postCalls.length +
      this.fenceCalls.length +
      this.searchCalls.length +
      this.listCalls.length
    );
  }
}
