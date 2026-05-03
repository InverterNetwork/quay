// Real Linear adapter. Reads issues + comments via Linear's GraphQL API.
// Bot token is sourced from `LINEAR_API_KEY` (adapters spec §4 / §7).
//
// LinearPort is synchronous (the dispatcher in `quay enqueue --linear-issue`
// is a blocking pipeline: fetch → validate → enqueue, with no benefit from
// async hand-offs). Bun's `fetch` is async-only, so the adapter runs the
// HTTP call in a child Bun process and `spawnSync`-waits on it — same
// pattern as `SlackAdapter` (`src/adapters/slack.ts`). Tests inject a
// synchronous in-process `transport` instead, which is why the network
// path is gated behind `QUAY_INTEGRATION_TESTS` and the unit suite never
// needs the env var or the network.
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
const PARENT_TIMEOUT_GRACE_MS = 5_000;
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
) => LinearTransportResponse;

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
  private readonly timeoutMs: number;
  private readonly transport: LinearTransport;

  constructor(opts?: {
    token?: string;
    endpoint?: string;
    timeoutMs?: number;
    transport?: LinearTransport;
  }) {
    this.explicitToken =
      opts?.token !== undefined && opts.token !== "" ? opts.token : null;
    this.endpoint = opts?.endpoint ?? DEFAULT_LINEAR_ENDPOINT;
    this.timeoutMs =
      opts?.timeoutMs !== undefined && opts.timeoutMs > 0
        ? opts.timeoutMs
        : resolveTimeoutFromEnv();
    this.transport = opts?.transport ?? this.spawnFetchTransport();
  }

  getIssue(identifier: string): LinearIssue | null {
    const first = this.queryIssuePage(identifier, null);
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
    while (hasNext && cursor !== null) {
      const next = this.queryIssuePage(identifier, cursor);
      if (next === null) break; // ticket disappeared mid-pagination — give up cleanly
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
    const fromEnv = process.env.LINEAR_API_KEY ?? "";
    if (fromEnv === "") {
      throw new Error(
        "LinearAdapter requires LINEAR_API_KEY to be set in the environment for any Linear API call",
      );
    }
    return fromEnv;
  }

  private queryIssuePage(
    identifier: string,
    commentsAfter: string | null,
  ): RawLinearIssue | null {
    const token = this.resolveToken();
    const body = JSON.stringify({
      query: GET_ISSUE_QUERY,
      variables: {
        id: identifier,
        commentsFirst: COMMENTS_PAGE_SIZE,
        commentsAfter,
      },
    });
    const response = this.transport({
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
      // Linear returns `data: { issue: null }` for 404-by-identifier, but
      // some shapes surface `errors[]` with no data; treat the latter as a
      // hard adapter failure rather than silently mapping to null.
      const messages = parsed.errors
        .map((e) => e.message ?? "(no message)")
        .join("; ");
      if (parsed.data?.issue == null) {
        throw new QuayError(
          "adapter_error",
          `Linear ${identifier}: GraphQL error: ${messages}`,
          { adapter: "linear", retryable: false },
        );
      }
    }
    const issue = parsed.data?.issue;
    if (issue == null) return null;
    return issue;
  }

  // Default transport: spawns a child Bun process that runs `fetch` and
  // writes a JSON-encoded {status, headers, body} envelope to stdout.
  // Token + URL + body live in env (not argv) for the same reasons as
  // SlackAdapter — argv is exposed via `/proc/<pid>/cmdline` on Linux.
  private spawnFetchTransport(): LinearTransport {
    const timeoutMs = this.timeoutMs;
    return (req) => {
      const result = Bun.spawnSync({
        cmd: [process.execPath, "-e", linearFetchScript()],
        env: {
          ...process.env,
          QUAY_LINEAR_URL: req.url,
          QUAY_LINEAR_METHOD: req.method,
          QUAY_LINEAR_BODY: req.body,
          QUAY_LINEAR_HEADERS: JSON.stringify(req.headers),
          QUAY_LINEAR_TIMEOUT_MS: String(timeoutMs),
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: timeoutMs + PARENT_TIMEOUT_GRACE_MS,
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `Linear request child process failed (exit ${result.exitCode}): ${decode(result.stderr).trim()}`,
        );
      }
      let envelope: { status: number; headers: Record<string, string>; body: string };
      try {
        envelope = JSON.parse(decode(result.stdout));
      } catch (err) {
        throw new Error(
          `Linear request returned unparseable envelope: ${(err as Error).message}`,
        );
      }
      return envelope;
    };
  }
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

function decode(buf: Buffer | Uint8Array | undefined): string {
  if (!buf) return "";
  return new TextDecoder().decode(buf);
}

function resolveTimeoutFromEnv(): number {
  const raw = process.env.QUAY_LINEAR_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_LINEAR_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LINEAR_TIMEOUT_MS;
  return Math.floor(parsed);
}

// Child-process script: argv is empty (everything sensitive is in env),
// stdout receives a JSON envelope `{status, headers, body}` so the parent
// can map HTTP status / Retry-After header to the right QuayError.
function linearFetchScript(): string {
  return `
const url = process.env.QUAY_LINEAR_URL || "";
const method = process.env.QUAY_LINEAR_METHOD || "POST";
const body = process.env.QUAY_LINEAR_BODY || "";
const headersJson = process.env.QUAY_LINEAR_HEADERS || "{}";
if (!url) {
  process.stderr.write("QUAY_LINEAR_URL not set in child env");
  process.exit(1);
}
let headers;
try { headers = JSON.parse(headersJson); }
catch (e) {
  process.stderr.write("QUAY_LINEAR_HEADERS unparseable: " + (e && e.message ? e.message : e));
  process.exit(1);
}
const timeoutMs = Number(process.env.QUAY_LINEAR_TIMEOUT_MS || "30000");
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);
const init = { method, headers, signal: controller.signal };
if (method !== "GET" && body) init.body = body;
fetch(url, init)
  .then(async (r) => {
    const text = await r.text();
    const respHeaders = {};
    r.headers.forEach((v, k) => { respHeaders[k] = v; });
    process.stdout.write(JSON.stringify({ status: r.status, headers: respHeaders, body: text }));
  })
  .catch((err) => {
    const isAbort =
      (err && (err.name === "AbortError" || err.name === "TimeoutError")) ||
      /aborted|abort/i.test(String(err && err.message ? err.message : err));
    if (isAbort) {
      process.stderr.write("Linear request timed out after " + timeoutMs + "ms");
    } else {
      process.stderr.write(String(err && err.message ? err.message : err));
    }
    process.exit(1);
  })
  .finally(() => clearTimeout(timer));
`;
}
