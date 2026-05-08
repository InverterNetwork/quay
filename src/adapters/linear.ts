// Real Linear adapter. Reads issues + comments via Linear's GraphQL API.
// Bot token is sourced from `LINEAR_API_KEY` (adapters spec §4 / §7).
//
// The adapter calls `fetch` in-process. An out-of-process spawn would not
// survive `bun build --compile`: `process.execPath` is the compiled quay
// binary, not bun, so spawning `process.execPath -e <script>` re-enters
// quay's CLI dispatcher with `-e` and fails. Tests inject an in-process
// `transport`; the network path is gated behind `QUAY_INTEGRATION_TESTS`
// so the unit suite never needs the env var or the network.
//
// Failure-mode mapping (adapters spec §12):
//   - HTTP 200, `data.issue === null`         → return null
//   - HTTP 200, draft flag set on issue       → throw `ticket_not_actionable`
//   - HTTP 200, `data.issue` populated         → parse + paginate comments
//   - HTTP 200, `errors[]` only                → throw `adapter_error{retryable:false}`
//   - HTTP 404                                 → return null (defensive)
//   - HTTP 429                                 → throw `adapter_error{retryable:true, retry_after}`
//   - HTTP 401/403 / other 4xx                 → throw `adapter_error{retryable:false}`
//   - HTTP 5xx                                 → throw `adapter_error{retryable:false}` (response
//                                                 body included in the message for debuggability)
import { QuayError } from "../core/errors.ts";
import type {
  LinearComment,
  LinearIssue,
  LinearPort,
} from "../ports/linear.ts";

const DEFAULT_LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const DEFAULT_LINEAR_TIMEOUT_MS = 30_000;
// First page of comments fetched alongside the issue, and subsequent pages.
// Linear's GraphQL caps `first` at 250; 100 keeps us well under.
const COMMENTS_PAGE_SIZE = 100;

export interface LinearTransportRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface LinearTransportResponse {
  status: number;
  // Lower-cased keys; only headers the adapter needs (`retry-after`) must
  // be present. Tests typically pass a small subset.
  headers: Record<string, string>;
  body: string;
}

export type LinearTransport = (
  req: LinearTransportRequest,
) => Promise<LinearTransportResponse> | LinearTransportResponse;

interface RawLinearComment {
  id: string;
  createdAt: string;
  body: string;
  user?: { name?: string | null; displayName?: string | null } | null;
  botActor?: { name?: string | null } | null;
}

interface RawLinearCommentsPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: RawLinearComment[];
}

interface RawLinearIssue {
  identifier: string;
  url: string;
  title: string;
  description: string | null;
  draft?: boolean | null;
  state?: { type?: string | null } | null;
  comments: RawLinearCommentsPage;
}

interface GraphQLEnvelope<T> {
  data?: T | null;
  errors?: Array<{ message?: string; extensions?: Record<string, unknown> }>;
}

export class LinearAdapter implements LinearPort {
  private readonly endpoint: string;
  private readonly explicitToken: string | null;
  private readonly tokenEnvVar: string;
  private readonly timeoutMs: number;
  private readonly transport: LinearTransport;

  constructor(opts?: {
    token?: string;
    tokenEnvVar?: string;
    endpoint?: string;
    timeoutMs?: number;
    transport?: LinearTransport;
  }) {
    this.explicitToken =
      opts?.token !== undefined && opts.token !== "" ? opts.token : null;
    this.tokenEnvVar =
      opts?.tokenEnvVar !== undefined && opts.tokenEnvVar !== ""
        ? opts.tokenEnvVar
        : "LINEAR_API_KEY";
    this.endpoint = opts?.endpoint ?? DEFAULT_LINEAR_ENDPOINT;
    this.timeoutMs =
      opts?.timeoutMs !== undefined && opts.timeoutMs > 0
        ? opts.timeoutMs
        : resolveTimeoutFromEnv();
    this.transport = opts?.transport ?? buildDefaultTransport(this.timeoutMs);
  }

  async getIssue(identifier: string): Promise<LinearIssue | null> {
    const first = await this.queryIssuePage(identifier, null);
    if (first === null) return null;
    if (isDraftIssue(first)) {
      throw new QuayError(
        "ticket_not_actionable",
        `Linear issue ${identifier} is a draft`,
        { identifier },
      );
    }
    const allRaw: RawLinearComment[] = [...first.comments.nodes];
    let cursor = first.comments.pageInfo.endCursor;
    let hasNext = first.comments.pageInfo.hasNextPage;
    while (hasNext) {
      if (cursor === null) {
        throw new QuayError(
          "adapter_error",
          `Linear ${identifier}: hasNextPage=true with null endCursor`,
          { adapter: "linear", retryable: false },
        );
      }
      const next = await this.queryIssuePage(identifier, cursor);
      if (next === null) {
        throw new QuayError(
          "adapter_error",
          `Linear ${identifier}: ticket disappeared mid-pagination`,
          { adapter: "linear", retryable: true },
        );
      }
      allRaw.push(...next.comments.nodes);
      cursor = next.comments.pageInfo.endCursor;
      hasNext = next.comments.pageInfo.hasNextPage;
    }
    const comments = allRaw
      .map(parseComment)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return {
      identifier: first.identifier,
      url: first.url,
      title: first.title,
      body: first.description ?? "",
      comments,
    };
  }

  // -- helpers ----------------------------------------------------------

  private resolveToken(): string {
    if (this.explicitToken !== null) return this.explicitToken;
    const envVar = this.tokenEnvVar;
    const fromEnv = process.env[envVar] ?? "";
    if (fromEnv === "") {
      throw new QuayError(
        "adapter_not_configured",
        `LinearAdapter requires ${envVar} to be set in the environment for any Linear API call`,
        { adapter: "linear", env_var: envVar },
      );
    }
    return fromEnv;
  }

  private async queryIssuePage(
    identifier: string,
    commentsAfter: string | null,
  ): Promise<RawLinearIssue | null> {
    const token = this.resolveToken();
    const body = JSON.stringify({
      query: GET_ISSUE_QUERY,
      variables: {
        id: identifier,
        commentsFirst: COMMENTS_PAGE_SIZE,
        commentsAfter,
      },
    });
    const response = await this.transport({
      url: this.endpoint,
      method: "POST",
      headers: {
        Authorization: token,
        "Content-Type": "application/json; charset=utf-8",
      },
      body,
    });
    return this.parseResponse(identifier, response);
  }

  private parseResponse(
    identifier: string,
    response: LinearTransportResponse,
  ): RawLinearIssue | null {
    const status = response.status;
    if (status === 404) return null;
    if (status === 429) {
      const retryAfter = parseRetryAfter(response.headers);
      throw new QuayError(
        "adapter_error",
        `Linear ${identifier}: rate-limited (429)`,
        { adapter: "linear", retryable: true, retry_after: retryAfter },
      );
    }
    if (status >= 500 && status < 600) {
      throw new QuayError(
        "adapter_error",
        `Linear ${identifier}: upstream ${status} ${truncate(response.body)}`,
        { adapter: "linear", retryable: false, status },
      );
    }
    if (status < 200 || status >= 300) {
      throw new QuayError(
        "adapter_error",
        `Linear ${identifier}: HTTP ${status} ${truncate(response.body)}`,
        { adapter: "linear", retryable: false, status },
      );
    }
    let parsed: GraphQLEnvelope<{ issue: RawLinearIssue | null }>;
    try {
      parsed = JSON.parse(response.body);
    } catch (err) {
      throw new QuayError(
        "adapter_error",
        `Linear ${identifier}: unparseable JSON: ${(err as Error).message}`,
        { adapter: "linear", retryable: false },
      );
    }
    if (parsed.errors !== undefined && parsed.errors.length > 0) {
      // Per spec §12: any non-empty `errors[]` is a hard adapter failure,
      // regardless of whether `data.issue` is also populated.
      const messages = parsed.errors
        .map((e) => e.message ?? "(no message)")
        .join("; ");
      throw new QuayError(
        "adapter_error",
        `Linear ${identifier}: GraphQL error: ${messages}`,
        { adapter: "linear", retryable: false },
      );
    }
    if (parsed.data === undefined || parsed.data === null) {
      throw new QuayError(
        "adapter_error",
        `Linear ${identifier}: missing data envelope`,
        { adapter: "linear", retryable: false },
      );
    }
    if (!("issue" in parsed.data)) {
      throw new QuayError(
        "adapter_error",
        `Linear ${identifier}: response missing issue field`,
        { adapter: "linear", retryable: false },
      );
    }
    if (parsed.data.issue === null) return null;
    return parsed.data.issue;
  }
}

// `AbortController` bounds each request to `timeoutMs` so a stalled
// connection cannot wedge the supervisor's bounded budget.
function buildDefaultTransport(timeoutMs: number): LinearTransport {
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
        throw new Error(`Linear request timed out after ${timeoutMs}ms`);
      }
      throw new Error(`Linear request failed: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  };
}

// GraphQL query — single source of truth, used both for the initial fetch
// and for follow-up pagination of comments. The deliberate omissions
// (labels, attachments, plain-text state, createdBy, assignee, ...) are
// pinned by `test_linear_adapter_does_not_fetch_labels_field` and the
// LinearIssue type's exclusion list (adapters spec §7).
const GET_ISSUE_QUERY = `query GetIssue($id: String!, $commentsFirst: Int!, $commentsAfter: String) {
  issue(id: $id) {
    identifier
    url
    title
    description
    state { type }
    comments(first: $commentsFirst, after: $commentsAfter) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        createdAt
        body
        user { name displayName }
        botActor { name }
      }
    }
  }
}`;

function isDraftIssue(issue: RawLinearIssue): boolean {
  // Defensive check per adapters spec §17: Linear's `issue()` query usually
  // returns 404 for drafts (drafts live on a separate `IssueDraft` entity in
  // their schema), but if Linear ever surfaces a `draft` flag on Issue we
  // honor it here. Triage state is *not* treated as draft — triage tickets
  // are real, just unprocessed; pre-filtering on state is Hermes's job
  // (adapters spec §7), not Quay's.
  return issue.draft === true;
}

function parseComment(raw: RawLinearComment): LinearComment {
  // Linear flags integration-authored comments via `botActor` (the
  // GitHub/Slack/Front integrations populate this); user-authored comments
  // leave `botActor` null and populate `user`. The brief composer (adapters
  // spec §6.1) filters bot-authored comments out of the assembled brief but
  // keeps them in `ticket_snapshot` for traceability.
  const isBot =
    raw.botActor !== null && raw.botActor !== undefined;
  let authorName = "(unknown)";
  if (isBot) {
    const name = raw.botActor?.name ?? "";
    if (name !== "") authorName = name;
  } else if (raw.user) {
    const display = raw.user.displayName ?? "";
    const name = raw.user.name ?? "";
    if (display !== "") authorName = display;
    else if (name !== "") authorName = name;
  }
  return {
    id: raw.id,
    authorName,
    authorIsBot: isBot,
    body: raw.body,
    createdAt: raw.createdAt,
  };
}

function parseRetryAfter(headers: Record<string, string>): number | null {
  // Headers might come in mixed-case from real fetch responses; normalize
  // by lower-casing keys at the lookup boundary.
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== "retry-after") continue;
    const seconds = Number(v);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds);
    return null;
  }
  return null;
}

function truncate(s: string): string {
  if (s.length <= 500) return s;
  return `${s.slice(0, 500)}... (truncated, ${s.length} bytes total)`;
}

function resolveTimeoutFromEnv(): number {
  const raw = process.env.QUAY_LINEAR_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_LINEAR_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LINEAR_TIMEOUT_MS;
  return Math.floor(parsed);
}
