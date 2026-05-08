// Real Slack adapter. Posts and reads via the Slack Web API using `fetch`.
// The bot token is sourced from `SLACK_TOKEN` (spec §11 Slack integration).
//
// Thread refs are encoded as `<channel>:<ts>` everywhere in Quay; this
// adapter parses that encoding once at the boundary and uses the structured
// pieces internally. Failures throw — tick wraps the throw in `tick_error`
// and retries on the next cycle (spec §5).
//
// The adapter calls `fetch` in-process. An out-of-process spawn would not
// survive `bun build --compile`: `process.execPath` is the compiled quay
// binary, not bun, so spawning `process.execPath -e <script>` re-enters
// quay's CLI dispatcher with `-e` and fails (the same bug AST-85 fixed
// for Linear). Tests inject an in-process `transport` that returns a
// `SlackTransportResponse` (sync or Promise — both work).
//
// Failure-mode mapping for `fetchThreadContext` (adapters spec §7 / §17):
//   - HTTP 200, `ok: true`           → success (paginate, truncate, return)
//   - HTTP 200, `ok: false, error`   → throw (caller wraps as adapter_error)
//   - HTTP 4xx                       → throw (caller wraps as adapter_error)
//   - HTTP 429                       → throw `adapter_error{retryable:true, retry_after}`
//   - HTTP 5xx                       → throw `adapter_error{retryable:false}`
import { QuayError } from "../core/errors.ts";
import type {
  SlackPort,
  SlackPostInput,
  SlackPostResult,
  SlackReply,
  SlackThread,
  SlackThreadMessage,
} from "../ports/slack.ts";

interface SlackMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
  subtype?: string;
  username?: string;
  user_profile?: {
    display_name?: string | null;
    real_name?: string | null;
  } | null;
  bot_profile?: { name?: string | null } | null;
}

interface ConversationsRepliesPayload {
  ok: boolean;
  error?: string;
  messages?: SlackMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

// Default per-call timeout. Configurable via QUAY_SLACK_TIMEOUT_MS at the
// deployment level so a stalled Slack connection cannot hold the supervisor
// lock indefinitely (spec §5: tick must record `tick_error` and continue).
const DEFAULT_SLACK_TIMEOUT_MS = 30_000;
// Adapters spec §17: default cap on `fetchThreadContext` reply count.
// Configurable via `[adapters.slack].max_thread_messages`.
const DEFAULT_MAX_THREAD_MESSAGES = 200;
// Per-page size for `conversations.replies`. Slack accepts up to 1000; 200
// is the comfortable middle (matches the existing `listReplies` choice).
const REPLIES_PAGE_SIZE = 200;

export interface SlackTransportRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body: string;
}

export interface SlackTransportResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type SlackTransport = (
  req: SlackTransportRequest,
) => Promise<SlackTransportResponse> | SlackTransportResponse;

export class SlackAdapter implements SlackPort {
  // The token is resolved lazily on first use so the production CLI can
  // construct this adapter unconditionally — a deployment without any
  // `waiting_human` tasks should not need `SLACK_TOKEN` set just to run
  // `quay tick`. The error surfaces only when tick actually tries to talk
  // to Slack.
  private readonly endpoint: string;
  private readonly explicitToken: string | null;
  private readonly tokenEnvVar: string;
  private readonly timeoutMs: number;
  private readonly transport: SlackTransport;
  private readonly maxThreadMessages: number;

  constructor(opts?: {
    token?: string;
    tokenEnvVar?: string;
    endpoint?: string;
    timeoutMs?: number;
    transport?: SlackTransport;
    maxThreadMessages?: number;
  }) {
    this.explicitToken =
      opts?.token !== undefined && opts.token !== "" ? opts.token : null;
    this.tokenEnvVar =
      opts?.tokenEnvVar !== undefined && opts.tokenEnvVar !== ""
        ? opts.tokenEnvVar
        : "SLACK_TOKEN";
    this.endpoint = opts?.endpoint ?? "https://slack.com/api";
    this.timeoutMs =
      opts?.timeoutMs !== undefined && opts.timeoutMs > 0
        ? opts.timeoutMs
        : resolveTimeoutFromEnv();
    this.transport = opts?.transport ?? buildDefaultTransport(this.timeoutMs);
    this.maxThreadMessages =
      opts?.maxThreadMessages !== undefined && opts.maxThreadMessages > 0
        ? opts.maxThreadMessages
        : DEFAULT_MAX_THREAD_MESSAGES;
  }

  private resolveToken(): string {
    if (this.explicitToken !== null) return this.explicitToken;
    const envVar = this.tokenEnvVar;
    const fromEnv = process.env[envVar] ?? "";
    if (fromEnv === "") {
      throw new QuayError(
        "adapter_not_configured",
        `SlackAdapter requires ${envVar} to be set in the environment for any Slack API call`,
        { adapter: "slack", env_var: envVar },
      );
    }
    return fromEnv;
  }

  async post(input: SlackPostInput): Promise<SlackPostResult> {
    const { channel, ts: parentTs } = parseThreadRef(input.threadRef);
    const body = {
      channel,
      thread_ts: parentTs,
      text: input.body,
    };
    const data = await this.callOk<{ ts: string }>("chat.postMessage", body);
    if (typeof data.ts !== "string" || data.ts.length === 0) {
      throw new Error(
        `Slack chat.postMessage returned no ts for thread ${input.threadRef}`,
      );
    }
    return { ts: data.ts };
  }

  async fenceTs(threadRef: string): Promise<string> {
    const replies = await this.fetchReplies(threadRef);
    if (replies.length === 0) {
      // Empty thread (no parent reachable) — return a sentinel "earlier than
      // anything" ts so any subsequent post is strictly later. Slack ts are
      // floats encoded as strings; "0" is well below any real value.
      return "0.000000";
    }
    return replies[replies.length - 1]!.ts;
  }

  async searchByNonce(
    threadRef: string,
    nonce: string,
  ): Promise<SlackReply | null> {
    // Spec §5 Sequence B step 3: scan the thread for a *bot-authored* message
    // whose body contains the per-escalation nonce. Not search.messages —
    // workspaces frequently disable that scope, and conversations.replies is
    // the same data source we already use for reply ingestion.
    const replies = await this.fetchReplies(threadRef);
    for (const m of replies) {
      if (!isBotAuthored(m)) continue;
      if ((m.text ?? "").includes(nonce)) {
        return { ts: m.ts, authorBot: true, text: m.text ?? "" };
      }
    }
    return null;
  }

  async fetchThreadContext(threadRef: string): Promise<SlackThread> {
    const { channel, ts } = parseThreadRef(threadRef);
    // Paginate `conversations.replies` to completion (or until we've gone
    // sufficiently past the cap that further fetches couldn't change the
    // truncation outcome). The first message of the first page is the
    // parent; subsequent messages — and all messages on follow-up pages —
    // are replies. We dedupe defensively in case Slack repeats the parent.
    const collected: SlackMessage[] = [];
    let parent: SlackMessage | null = null;
    let cursor: string | null = null;
    let pageCount = 0;

    let pageCapped = false;
    while (true) {
      pageCount += 1;
      const payload: Record<string, unknown> = {
        channel,
        ts,
        limit: REPLIES_PAGE_SIZE,
      };
      if (cursor !== null) payload.cursor = cursor;

      const env = await this.requestEnvelope(
        "conversations.replies",
        payload,
        "GET",
      );
      mapEnvelopeErrorsForFetchThreadContext(env);

      let parsed: ConversationsRepliesPayload;
      try {
        parsed = JSON.parse(env.body);
      } catch (err) {
        throw new Error(
          `Slack conversations.replies returned unparseable JSON: ${(err as Error).message}`,
        );
      }
      if (!parsed.ok) {
        throw new Error(
          `Slack conversations.replies failed: ${parsed.error ?? "unknown error"}`,
        );
      }
      const messages = parsed.messages ?? [];
      if (parent === null) {
        if (messages.length === 0) {
          throw new Error(
            `Slack thread ${threadRef} returned no messages (thread not found)`,
          );
        }
        parent = messages[0]!;
        for (let i = 1; i < messages.length; i++) {
          collected.push(messages[i]!);
        }
      } else {
        for (const m of messages) {
          if (m.ts === parent.ts) continue; // defensive dedupe
          collected.push(m);
        }
      }

      const next = parsed.response_metadata?.next_cursor ?? "";
      const hasMore = parsed.has_more === true && next !== "";
      if (!hasMore) break;
      // Belt-and-braces page cap. Even at the page size of 200 the worst
      // case per Slack's documented thread limit (~1000) is a handful of
      // pages; a runaway pagination signals an upstream change worth
      // surfacing rather than silently spinning.
      if (pageCount >= 50) {
        pageCapped = true;
        break;
      }
      cursor = next;
    }

    const cap = this.maxThreadMessages;
    const parentMsg = toSlackThreadMessage(parent!);
    if (collected.length <= cap) {
      return {
        parent: parentMsg,
        replies: collected.map(toSlackThreadMessage),
      };
    }
    // Truncation: first floor(cap/2) + canonical marker + last floor(cap/2).
    // Marker text matches `<!-- thread truncated: K intermediate messages omitted -->`
    // exactly when the full thread was fetched, with K substituted (adapters
    // spec §7 / §17). When the page cap fired before pagination completed,
    // `collected` is a partial view of the thread — K is a lower bound, and
    // the marker says so.
    const half = Math.floor(cap / 2);
    const head = collected.slice(0, half).map(toSlackThreadMessage);
    const tail = collected
      .slice(collected.length - half)
      .map(toSlackThreadMessage);
    const omitted = collected.length - 2 * half;
    const markerText = pageCapped
      ? `<!-- thread truncated: at least ${omitted} intermediate messages omitted (page cap hit; full thread length unknown) -->`
      : `<!-- thread truncated: ${omitted} intermediate messages omitted -->`;
    const marker: SlackThreadMessage = {
      ts: `${head[head.length - 1]?.ts ?? "0"}-truncated`,
      authorBot: true,
      authorName: null,
      text: markerText,
    };
    return { parent: parentMsg, replies: [...head, marker, ...tail] };
  }

  async listReplies(
    threadRef: string,
    lowerBoundTs: string,
  ): Promise<SlackReply[]> {
    const replies = await this.fetchReplies(threadRef);
    const lb = Number(lowerBoundTs);
    return replies
      .filter((m) => Number(m.ts) > lb)
      .map((m) => ({
        ts: m.ts,
        authorBot: isBotAuthored(m),
        text: m.text ?? "",
      }));
  }

  // -- helpers ----------------------------------------------------------

  private async fetchReplies(threadRef: string): Promise<SlackMessage[]> {
    const { channel, ts } = parseThreadRef(threadRef);
    // conversations.replies is paginated. v1 fetches a single page; threads
    // longer than ~200 messages would need cursor handling. The spec
    // explicitly defers paging optimization — escalation threads in practice
    // sit in the low double digits.
    const data = await this.callOk<{ messages: SlackMessage[] }>(
      "conversations.replies",
      { channel, ts, limit: 200 },
      "GET",
    );
    return Array.isArray(data.messages) ? data.messages : [];
  }

  private async callOk<T>(
    method: string,
    payload: Record<string, unknown>,
    httpMethod: "POST" | "GET" = "POST",
  ): Promise<T> {
    // Slack's Web API returns JSON with `{ ok: bool, error?: string, ... }`.
    // Quay treats any `ok=false` as a thrown error so tick's per-task error
    // path logs `tick_error`. Network/HTTP failures bubble up the same way.
    const env = await this.requestEnvelope(method, payload, httpMethod);
    if (env.status < 200 || env.status >= 300) {
      throw new Error(
        `Slack ${method} HTTP ${env.status}: ${truncate(env.body)}`,
      );
    }
    let parsed: { ok: boolean; error?: string } & Record<string, unknown>;
    try {
      parsed = JSON.parse(env.body);
    } catch (err) {
      throw new Error(
        `Slack ${method} returned unparseable JSON: ${(err as Error).message}`,
      );
    }
    if (!parsed.ok) {
      throw new Error(
        `Slack ${method} failed: ${parsed.error ?? "unknown error"}`,
      );
    }
    return parsed as unknown as T;
  }

  private async requestEnvelope(
    method: string,
    payload: Record<string, unknown>,
    httpMethod: "POST" | "GET",
  ): Promise<SlackTransportResponse> {
    const token = this.resolveToken();
    const url =
      httpMethod === "GET"
        ? `${this.endpoint}/${method}?${encodeForm(payload)}`
        : `${this.endpoint}/${method}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    let body = "";
    if (httpMethod === "POST") {
      headers["Content-Type"] = "application/json; charset=utf-8";
      body = JSON.stringify(payload);
    }
    return await this.transport({ url, method: httpMethod, headers, body });
  }
}

// `AbortController` bounds each request to `timeoutMs` so a stalled
// connection cannot wedge the supervisor's bounded budget.
function buildDefaultTransport(timeoutMs: number): SlackTransport {
  return async (req) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const init: RequestInit = {
        method: req.method,
        headers: req.headers,
        signal: controller.signal,
      };
      if (req.method !== "GET" && req.body !== "") init.body = req.body;
      const response = await fetch(req.url, init);
      const body = await response.text();
      const headers = Object.fromEntries(response.headers.entries());
      return { status: response.status, headers, body };
    } catch (err) {
      const e = err as Error & { name?: string };
      const name = e?.name ?? "";
      const msg = e?.message ?? String(err);
      if (name === "AbortError" || name === "TimeoutError" || /aborted|abort/i.test(msg)) {
        throw new Error(`Slack request timed out after ${timeoutMs}ms`);
      }
      throw new Error(`Slack request failed: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  };
}

function parseThreadRef(threadRef: string): { channel: string; ts: string } {
  // `<channel>:<ts>` per spec §11. The colon split is unambiguous because
  // both Slack channel ids and Slack timestamps are safe charsets that
  // never contain `:`.
  const idx = threadRef.indexOf(":");
  if (idx <= 0 || idx >= threadRef.length - 1) {
    throw new Error(
      `invalid Slack thread ref "${threadRef}"; expected "<channel>:<ts>"`,
    );
  }
  return { channel: threadRef.slice(0, idx), ts: threadRef.slice(idx + 1) };
}

function isBotAuthored(msg: SlackMessage): boolean {
  // Slack flags bot posts via `bot_id`. The thread's parent message (the
  // ticket post the orchestrator is replying into) often has neither a
  // `bot_id` nor a `user` matching ours; treat anything without a `bot_id`
  // as human-authored. Subtype `bot_message` is also a strong signal.
  if (msg.bot_id !== undefined && msg.bot_id !== "") return true;
  if (msg.subtype === "bot_message") return true;
  return false;
}

function resolveAuthorName(msg: SlackMessage): string | null {
  // Best-effort author resolution from fields Slack surfaces inline on
  // `conversations.replies` payloads. We deliberately do not issue a
  // separate `users.info` round-trip for each unresolved user — it would
  // turn one Slack call into N for long threads, and the brief composer
  // tolerates `null` (renders as "(unknown)").
  if (msg.user_profile) {
    const display = msg.user_profile.display_name ?? "";
    if (display !== "") return display;
    const real = msg.user_profile.real_name ?? "";
    if (real !== "") return real;
  }
  if (msg.bot_profile && typeof msg.bot_profile.name === "string") {
    if (msg.bot_profile.name !== "") return msg.bot_profile.name;
  }
  if (typeof msg.username === "string" && msg.username !== "") {
    return msg.username;
  }
  return null;
}

function toSlackThreadMessage(m: SlackMessage): SlackThreadMessage {
  return {
    ts: m.ts,
    authorBot: isBotAuthored(m),
    authorName: resolveAuthorName(m),
    text: m.text ?? "",
  };
}

function mapEnvelopeErrorsForFetchThreadContext(
  env: SlackTransportResponse,
): void {
  if (env.status === 429) {
    const retryAfter = parseRetryAfter(env.headers);
    throw new QuayError(
      "adapter_error",
      "Slack conversations.replies: rate-limited (429)",
      { adapter: "slack", retryable: true, retry_after: retryAfter },
    );
  }
  if (env.status >= 500 && env.status < 600) {
    throw new QuayError(
      "adapter_error",
      `Slack conversations.replies: upstream ${env.status} ${truncate(env.body)}`,
      { adapter: "slack", retryable: false, status: env.status },
    );
  }
  if (env.status < 200 || env.status >= 300) {
    // 4xx — auth, scope, or bad request. Surface as a plain Error so
    // ticketContext.fetch wraps as adapter_error{slack} per spec §12.
    throw new Error(
      `Slack conversations.replies: HTTP ${env.status} ${truncate(env.body)}`,
    );
  }
}

function parseRetryAfter(headers: Record<string, string>): number | null {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== "retry-after") continue;
    const seconds = Number(v);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds);
    return null;
  }
  return null;
}

function encodeForm(payload: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(payload)) {
    if (v === undefined || v === null) continue;
    params.append(k, String(v));
  }
  return params.toString();
}

function truncate(s: string): string {
  if (s.length <= 500) return s;
  return `${s.slice(0, 500)}... (truncated, ${s.length} bytes total)`;
}

function resolveTimeoutFromEnv(): number {
  const raw = process.env.QUAY_SLACK_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_SLACK_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SLACK_TIMEOUT_MS;
  return Math.floor(parsed);
}
