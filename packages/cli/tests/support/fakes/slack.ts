import type {
  SlackPort,
  SlackPostInput,
  SlackPostResult,
  SlackReply,
  SlackThread,
  SlackThreadMessage,
} from "../../../src/ports/slack.ts";

interface FakeMessage {
  ts: string;
  authorBot: boolean;
  text: string;
}

interface FakeThreadContext {
  parent: SlackThreadMessage;
  replies: SlackThreadMessage[];
  // When true, the fake simulates the adapter having hit the pagination page
  // cap before exhausting all replies — the omitted count in the truncation
  // marker is a lower bound and the marker text says so.
  pageCapped?: boolean;
}

// Default cap matches `[adapters.slack].max_thread_messages` in the spec.
const DEFAULT_MAX_THREAD_MESSAGES = 200;

export class FakeSlack implements SlackPort {
  postCalls: SlackPostInput[] = [];
  fenceCalls: string[] = [];
  searchCalls: { threadRef: string; nonce: string }[] = [];
  listCalls: { threadRef: string; lowerBoundTs: string }[] = [];
  fetchThreadContextCalls: string[] = [];

  // Public so tests can mutate without an explicit setter call.
  maxThreadMessages = DEFAULT_MAX_THREAD_MESSAGES;

  private threads = new Map<string, FakeMessage[]>();
  private threadContexts = new Map<string, FakeThreadContext>();
  private tsCounter = 0;
  private postFailureQueue: Error[] = [];
  private fenceFailureQueue: Error[] = [];
  private listFailureQueue: Error[] = [];
  private searchFailureQueue: Error[] = [];

  private getThread(threadRef: string): FakeMessage[] {
    let thread = this.threads.get(threadRef);
    if (!thread) {
      thread = [];
      this.threads.set(threadRef, thread);
    }
    return thread;
  }

  private nextTs(): string {
    this.tsCounter += 1;
    // ts strings are zero-padded so both numeric and alphabetic comparison
    // produce a consistent total order.
    return `1.${String(this.tsCounter).padStart(8, "0")}`;
  }

  // Test helpers ---------------------------------------------------------

  appendBotMessage(threadRef: string, text: string): string {
    const ts = this.nextTs();
    this.getThread(threadRef).push({ ts, authorBot: true, text });
    return ts;
  }

  appendHumanReply(threadRef: string, text: string): string {
    const ts = this.nextTs();
    this.getThread(threadRef).push({ ts, authorBot: false, text });
    return ts;
  }

  failPostOnce(message = "fake: slack post failed"): void {
    this.postFailureQueue.push(new Error(message));
  }

  failFenceOnce(message = "fake: slack fence failed"): void {
    this.fenceFailureQueue.push(new Error(message));
  }

  failListOnce(message = "fake: slack list failed"): void {
    this.listFailureQueue.push(new Error(message));
  }

  failSearchOnce(message = "fake: slack search failed"): void {
    this.searchFailureQueue.push(new Error(message));
  }

  configureThreadContext(
    threadRef: string,
    parent: SlackThreadMessage,
    replies: SlackThreadMessage[],
    opts?: { pageCapped?: boolean },
  ): void {
    this.threadContexts.set(threadRef, {
      parent,
      replies: [...replies],
      pageCapped: opts?.pageCapped ?? false,
    });
  }

  setMaxThreadMessages(cap: number): void {
    this.maxThreadMessages = cap;
  }

  totalCalls(): number {
    return (
      this.postCalls.length +
      this.fenceCalls.length +
      this.searchCalls.length +
      this.listCalls.length +
      this.fetchThreadContextCalls.length
    );
  }

  // Port impl ------------------------------------------------------------

  async post(input: SlackPostInput): Promise<SlackPostResult> {
    this.postCalls.push({ ...input });
    const failure = this.postFailureQueue.shift();
    if (failure) throw failure;
    const ts = this.appendBotMessage(input.threadRef, input.body);
    return { ts };
  }

  async fenceTs(threadRef: string): Promise<string> {
    this.fenceCalls.push(threadRef);
    const failure = this.fenceFailureQueue.shift();
    if (failure) throw failure;
    const thread = this.getThread(threadRef);
    if (thread.length === 0) return "0.00000000";
    return thread[thread.length - 1]!.ts;
  }

  async searchByNonce(
    threadRef: string,
    nonce: string,
  ): Promise<SlackReply | null> {
    this.searchCalls.push({ threadRef, nonce });
    const failure = this.searchFailureQueue.shift();
    if (failure) throw failure;
    const thread = this.getThread(threadRef);
    for (const msg of thread) {
      if (msg.authorBot && msg.text.includes(nonce)) {
        return { ts: msg.ts, authorBot: true, text: msg.text };
      }
    }
    return null;
  }

  async listReplies(
    threadRef: string,
    lowerBoundTs: string,
  ): Promise<SlackReply[]> {
    this.listCalls.push({ threadRef, lowerBoundTs });
    const failure = this.listFailureQueue.shift();
    if (failure) throw failure;
    const thread = this.getThread(threadRef);
    const lb = Number(lowerBoundTs);
    return thread
      .filter((m) => Number(m.ts) > lb)
      .map((m) => ({ ts: m.ts, authorBot: m.authorBot, text: m.text }));
  }

  async fetchThreadContext(threadRef: string): Promise<SlackThread> {
    this.fetchThreadContextCalls.push(threadRef);
    const ctx = this.threadContexts.get(threadRef);
    if (!ctx) {
      throw new Error(`fake: thread not found: ${threadRef}`);
    }
    const cap = this.maxThreadMessages;
    const replies = ctx.replies;
    if (replies.length <= cap) {
      return { parent: ctx.parent, replies: [...replies] };
    }
    // Truncation: first floor(cap/2) + marker + last floor(cap/2). When the
    // fake is configured with pageCapped=true it mirrors the real adapter's
    // behaviour: the omitted count is a lower bound and the marker text says
    // so. Otherwise the canonical marker text is used (spec §7 / §17).
    const half = Math.floor(cap / 2);
    const omitted = replies.length - 2 * half;
    const head = replies.slice(0, half);
    const tail = replies.slice(replies.length - half);
    const markerText = ctx.pageCapped
      ? `<!-- thread truncated: at least ${omitted} intermediate messages omitted (page cap hit; full thread length unknown) -->`
      : `<!-- thread truncated: ${omitted} intermediate messages omitted -->`;
    const marker: SlackThreadMessage = {
      ts: `${head[head.length - 1]?.ts ?? "0"}-truncated`,
      authorBot: true,
      authorName: null,
      text: markerText,
    };
    return { parent: ctx.parent, replies: [...head, marker, ...tail] };
  }
}
