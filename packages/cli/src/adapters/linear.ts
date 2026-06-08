// Real Linear adapter. Reads issues + comments via Linear's GraphQL API.
// Auth defaults to the legacy `LINEAR_API_KEY` personal token path, and can
// opt into OAuth/app-actor Bearer tokens via a per-request env/helper source.
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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { QuayError } from "../core/errors.ts";
import type {
  LinearBlockedByRelation,
  LinearComment,
  LinearHierarchyIssue,
  LinearIssue,
  LinearIssueHierarchy,
  LinearPort,
} from "../ports/linear.ts";

const DEFAULT_LINEAR_ENDPOINT = "https://api.linear.app/graphql";
const DEFAULT_LINEAR_TIMEOUT_MS = 30_000;
// First page of comments fetched alongside the issue, and subsequent pages.
// Linear's GraphQL caps `first` at 250; 100 keeps us well under.
const COMMENTS_PAGE_SIZE = 100;
const CHILDREN_PAGE_SIZE = 100;
const execFileAsync = promisify(execFile);

export type LinearAuthMode = "api_key" | "bearer";
export type LinearTokenProvider = () => Promise<string> | string;

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

interface RawLinearRelationIssue {
  identifier: string;
  url: string;
  title: string;
  description: string | null;
  state?: { type?: string | null } | null;
}

interface RawLinearIssueRelation {
  id: string;
  type: string;
  issue: RawLinearRelationIssue | null;
  relatedIssue: RawLinearRelationIssue | null;
}

interface RawLinearRelationsPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: RawLinearIssueRelation[];
}

interface RawLinearIssueRelations {
  identifier: string;
  relations: RawLinearRelationsPage;
}

interface RawLinearIssueInverseRelations {
  identifier: string;
  inverseRelations: RawLinearRelationsPage;
}

interface CollectedLinearRelationPages {
  identifier: string;
  nodes: RawLinearIssueRelation[];
}

interface RawLinearHierarchyIssue {
  identifier: string;
  url: string;
  title: string;
  state?: { type?: string | null } | null;
}

interface RawLinearChildrenPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: RawLinearHierarchyIssue[];
}

interface RawLinearIssueHierarchy {
  identifier: string;
  parent: RawLinearHierarchyIssue | null;
  children: RawLinearChildrenPage;
}

interface RawIssueStateRefs {
  state: { id: string; name: string } | null;
  team: { id: string } | null;
}

interface RawTeamStateNode {
  id: string;
  name: string;
}

interface RawTeamStates {
  states: { nodes: RawTeamStateNode[] };
}

interface GraphQLEnvelope<T> {
  data?: T | null;
  errors?: Array<{ message?: string; extensions?: Record<string, unknown> }>;
}

export class LinearAdapter implements LinearPort {
  private readonly endpoint: string;
  private readonly explicitToken: string | null;
  private readonly tokenEnvVar: string;
  private readonly authMode: LinearAuthMode;
  private readonly tokenCommand: string | null;
  private readonly tokenProvider: LinearTokenProvider | null;
  private readonly timeoutMs: number;
  private readonly transport: LinearTransport;
  // Per-team workflow state cache (state-name → state-id). Linear's workflow
  // states are stable enough to cache for the process lifetime; the cost of a
  // miss is one extra round-trip. Keyed on `team.id` (UUID), not the team's
  // short key, so deployments where two adapters target the same instance
  // don't collide on short-key aliases.
  private readonly teamStatesCache = new Map<string, Map<string, string>>();
  // Last stateName this process wrote (or observed equal to) for each
  // issue. Lets repeated writebacks of the same name short-circuit the
  // read-then-write round trip entirely. Worst-case staleness: when Linear
  // moved on its side, the next *different* sync target reconciles —
  // quay's hot path never re-asserts an already-set state.
  //
  // Bounded LRU: Map preserves insertion order, so the oldest entry is
  // always `keys().next()`. Eviction happens at the write site below,
  // keeping the cache footprint at ~one map slot per distinct ticket the
  // process has touched up to the cap. The cap is high enough that any
  // realistic operator load stays inside it; the bound only matters for
  // pathological workloads or test fixtures that mint tickets in a loop.
  private readonly lastSyncedStateNameByIssue = new Map<string, string>();
  private static readonly LAST_SYNCED_STATE_CACHE_MAX = 4096;

  constructor(opts?: {
    token?: string;
    tokenEnvVar?: string;
    authMode?: LinearAuthMode;
    tokenCommand?: string;
    tokenProvider?: LinearTokenProvider;
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
    this.authMode = opts?.authMode ?? "api_key";
    this.tokenCommand =
      opts?.tokenCommand !== undefined && opts.tokenCommand.trim() !== ""
        ? opts.tokenCommand
        : null;
    this.tokenProvider = opts?.tokenProvider ?? null;
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

  async getBlockedByRelations(
    identifier: string,
  ): Promise<LinearBlockedByRelation[]> {
    const forward = await this.collectIssueRelationPages(
      identifier,
      "relations",
    );
    const inverse = await this.collectIssueRelationPages(
      identifier,
      "inverseRelations",
    );
    const allRaw = [...forward.nodes, ...inverse.nodes];

    const current = forward.identifier.toUpperCase();
    const blockers: LinearBlockedByRelation[] = [];
    for (const relation of allRaw) {
      const blocker = extractBlockingIssue(relation, current);
      if (blocker === null) continue;
      blockers.push({
        relationId: relation.id,
        blocker: {
          identifier: blocker.identifier,
          url: blocker.url,
          title: blocker.title,
          body: blocker.description ?? "",
          stateType: blocker.state?.type ?? null,
        },
      });
    }
    return blockers.sort((a, b) =>
      a.blocker.identifier.localeCompare(b.blocker.identifier),
    );
  }

  async getIssueHierarchy(identifier: string): Promise<LinearIssueHierarchy> {
    const first = await this.queryIssueHierarchyPage(identifier, null);
    if (first === null) {
      throw new QuayError(
        "adapter_error",
        `Linear ${identifier}: ticket disappeared before hierarchy fetch`,
        { adapter: "linear", retryable: true },
      );
    }
    const allRaw: RawLinearHierarchyIssue[] = [...first.children.nodes];
    let cursor = first.children.pageInfo.endCursor;
    let hasNext = first.children.pageInfo.hasNextPage;
    while (hasNext) {
      if (cursor === null) {
        throw new QuayError(
          "adapter_error",
          `Linear ${identifier}: children hasNextPage=true with null endCursor`,
          { adapter: "linear", retryable: false },
        );
      }
      const next = await this.queryIssueHierarchyPage(identifier, cursor);
      if (next === null) {
        throw new QuayError(
          "adapter_error",
          `Linear ${identifier}: ticket disappeared mid-children-pagination`,
          { adapter: "linear", retryable: true },
        );
      }
      allRaw.push(...next.children.nodes);
      cursor = next.children.pageInfo.endCursor;
      hasNext = next.children.pageInfo.hasNextPage;
    }

    return {
      parent:
        first.parent === null ? null : parseHierarchyIssue(first.parent),
      children: allRaw
        .map(parseHierarchyIssue)
        .sort((a, b) => a.identifier.localeCompare(b.identifier)),
    };
  }

  async setIssueState(identifier: string, stateName: string): Promise<void> {
    // Local fast path: nothing to do when the last writeback for this issue
    // landed on the same target. Skips all three round-trips for steady-
    // state (e.g. retries that keep firing "In Progress").
    if (this.lastSyncedStateNameByIssue.get(identifier) === stateName) return;
    // Read current state + team in a single round-trip. A 404 (ticket
    // deleted upstream) is a quiet no-op — quay has nothing to write back.
    const refs = await this.queryIssueStateRefs(identifier);
    if (refs === null) return;
    if (refs.team === null) {
      throw new QuayError(
        "adapter_error",
        `Linear ${identifier}: issue has no team`,
        { adapter: "linear", retryable: false },
      );
    }
    // Resolve target stateName via the team's workflow states. A stale cache
    // shows up as a `state.id` Linear rejects with a 4xx — surfaces as
    // `adapter_error`, reaches the operator as a warning, and is preferred
    // over a fetch-per-call.
    const teamId = refs.team.id;
    let stateMap = this.teamStatesCache.get(teamId);
    if (stateMap === undefined) {
      stateMap = await this.queryTeamStates(identifier, teamId);
      this.teamStatesCache.set(teamId, stateMap);
    }
    const targetStateId = stateMap.get(stateName);
    if (targetStateId === undefined) {
      throw new QuayError(
        "unknown_state",
        `Linear team ${teamId} has no workflow state named "${stateName}"`,
        { adapter: "linear", team_id: teamId, state_name: stateName },
      );
    }
    // Idempotent skip — compared on id, so a Linear-side rename doesn't
    // accidentally re-write.
    if (refs.state !== null && refs.state.id === targetStateId) {
      this.rememberSyncedState(identifier, stateName);
      return;
    }
    await this.runIssueUpdate(identifier, targetStateId);
    this.rememberSyncedState(identifier, stateName);
  }

  private rememberSyncedState(identifier: string, stateName: string): void {
    // Re-inserting an existing key is a no-op for the cap check; net new
    // identifiers trip the eviction. `keys().next().value` is the oldest
    // entry by Map insertion order — that's the LRU victim.
    if (
      !this.lastSyncedStateNameByIssue.has(identifier) &&
      this.lastSyncedStateNameByIssue.size >=
        LinearAdapter.LAST_SYNCED_STATE_CACHE_MAX
    ) {
      const oldest = this.lastSyncedStateNameByIssue.keys().next().value;
      if (oldest !== undefined) {
        this.lastSyncedStateNameByIssue.delete(oldest);
      }
    }
    this.lastSyncedStateNameByIssue.set(identifier, stateName);
  }

  // -- helpers ----------------------------------------------------------

  private async resolveAuthorizationHeader(): Promise<string> {
    const rawToken = await this.resolveToken();
    if (this.authMode === "bearer") {
      return `Bearer ${rawToken.replace(/^Bearer\s+/i, "")}`;
    }
    return rawToken;
  }

  private async resolveToken(): Promise<string> {
    if (this.tokenProvider !== null) {
      const fromProvider = (await this.tokenProvider()).trim();
      if (fromProvider === "") {
        throw new QuayError(
          "adapter_not_configured",
          "LinearAdapter token provider returned an empty token",
          { adapter: "linear", token_source: "provider" },
        );
      }
      return fromProvider;
    }
    if (this.tokenCommand !== null) {
      const fromCommand = await this.runTokenCommand();
      if (fromCommand === "") {
        throw new QuayError(
          "adapter_not_configured",
          "LinearAdapter token command returned an empty token",
          { adapter: "linear", token_source: "command" },
        );
      }
      return fromCommand;
    }
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

  private async runTokenCommand(): Promise<string> {
    const shell = process.env.SHELL !== undefined && process.env.SHELL !== ""
      ? process.env.SHELL
      : "/bin/sh";
    try {
      const result = await execFileAsync(shell, ["-lc", this.tokenCommand!], {
        timeout: this.timeoutMs,
        maxBuffer: 1024 * 1024,
      });
      return result.stdout.trim();
    } catch (err) {
      const e = err as Error & {
        stderr?: string;
        stdout?: string;
        code?: unknown;
      };
      const stderr =
        e.stderr !== undefined && e.stderr !== ""
          ? ` stderr=${truncate(e.stderr)}`
          : "";
      throw new QuayError(
        "adapter_not_configured",
        `LinearAdapter token command failed: ${e.message}${stderr}`,
        { adapter: "linear", token_source: "command", exit_code: e.code },
      );
    }
  }

  private async queryIssuePage(
    identifier: string,
    commentsAfter: string | null,
  ): Promise<RawLinearIssue | null> {
    const response = await this.postGraphQL(identifier, GET_ISSUE_QUERY, {
      id: identifier,
      commentsFirst: COMMENTS_PAGE_SIZE,
      commentsAfter,
    });
    const data = this.parseGraphQLEnvelope<{ issue: RawLinearIssue | null }>(
      identifier,
      response,
    );
    if (data === null) return null;
    if (!("issue" in data)) {
      throw new QuayError(
        "adapter_error",
        `Linear ${identifier}: response missing issue field`,
        { adapter: "linear", retryable: false },
      );
    }
    return data.issue;
  }

  private async queryIssueStateRefs(
    identifier: string,
  ): Promise<RawIssueStateRefs | null> {
    const response = await this.postGraphQL(
      identifier,
      GET_ISSUE_STATE_REFS_QUERY,
      { id: identifier },
    );
    const parsed = this.parseGraphQLEnvelope<{
      issue: RawIssueStateRefs | null;
    }>(identifier, response);
    if (parsed === null) return null;
    if (!("issue" in parsed)) {
      throw new QuayError(
        "adapter_error",
        `Linear ${identifier}: response missing issue field`,
        { adapter: "linear", retryable: false },
      );
    }
    return parsed.issue;
  }

  private async queryIssueRelationsPage(
    identifier: string,
    relationsAfter: string | null,
  ): Promise<RawLinearIssueRelations | null> {
    const response = await this.postGraphQL(identifier, GET_ISSUE_RELATIONS_QUERY, {
      id: identifier,
      relationsFirst: RELATIONS_PAGE_SIZE,
      relationsAfter,
    });
    const data = this.parseGraphQLEnvelope<{
      issue: RawLinearIssueRelations | null;
    }>(identifier, response);
    if (data === null) return null;
    if (!("issue" in data)) {
      throw new QuayError(
        "adapter_error",
        `Linear ${identifier}: response missing issue field`,
        { adapter: "linear", retryable: false },
      );
    }
    return data.issue;
  }

  private async queryIssueInverseRelationsPage(
    identifier: string,
    relationsAfter: string | null,
  ): Promise<RawLinearIssueInverseRelations | null> {
    const response = await this.postGraphQL(
      identifier,
      GET_ISSUE_INVERSE_RELATIONS_QUERY,
      {
        id: identifier,
        relationsFirst: RELATIONS_PAGE_SIZE,
        relationsAfter,
      },
    );
    const data = this.parseGraphQLEnvelope<{
      issue: RawLinearIssueInverseRelations | null;
    }>(identifier, response);
    if (data === null) return null;
    if (!("issue" in data)) {
      throw new QuayError(
        "adapter_error",
        `Linear ${identifier}: response missing issue field`,
        { adapter: "linear", retryable: false },
      );
    }
    return data.issue;
  }

  private async collectIssueRelationPages(
    identifier: string,
    direction: "relations" | "inverseRelations",
  ): Promise<CollectedLinearRelationPages> {
    const queryPage =
      direction === "relations"
        ? (after: string | null) =>
            this.queryIssueRelationsPage(identifier, after)
        : (after: string | null) =>
            this.queryIssueInverseRelationsPage(identifier, after);
    const first = await queryPage(null);
    if (first === null) {
      throw new QuayError(
        "adapter_error",
        `Linear ${identifier}: ticket disappeared before relation fetch`,
        { adapter: "linear", retryable: true },
      );
    }
    const page =
      direction === "relations"
        ? (first as RawLinearIssueRelations).relations
        : (first as RawLinearIssueInverseRelations).inverseRelations;
    const allRaw: RawLinearIssueRelation[] = [...page.nodes];
    let cursor = page.pageInfo.endCursor;
    let hasNext = page.pageInfo.hasNextPage;
    while (hasNext) {
      if (cursor === null) {
        throw new QuayError(
          "adapter_error",
          `Linear ${identifier}: ${direction} hasNextPage=true with null endCursor`,
          { adapter: "linear", retryable: false },
        );
      }
      const next = await queryPage(cursor);
      if (next === null) {
        throw new QuayError(
          "adapter_error",
          `Linear ${identifier}: ticket disappeared mid-relation-pagination`,
          { adapter: "linear", retryable: true },
        );
      }
      const nextPage =
        direction === "relations"
          ? (next as RawLinearIssueRelations).relations
          : (next as RawLinearIssueInverseRelations).inverseRelations;
      allRaw.push(...nextPage.nodes);
      cursor = nextPage.pageInfo.endCursor;
      hasNext = nextPage.pageInfo.hasNextPage;
    }
    return { identifier: first.identifier, nodes: allRaw };
  }

  private async queryIssueHierarchyPage(
    identifier: string,
    childrenAfter: string | null,
  ): Promise<RawLinearIssueHierarchy | null> {
    const response = await this.postGraphQL(
      identifier,
      GET_ISSUE_HIERARCHY_QUERY,
      {
        id: identifier,
        childrenFirst: CHILDREN_PAGE_SIZE,
        childrenAfter,
      },
    );
    const data = this.parseGraphQLEnvelope<{
      issue: RawLinearIssueHierarchy | null;
    }>(identifier, response);
    if (data === null) return null;
    if (!("issue" in data)) {
      throw new QuayError(
        "adapter_error",
        `Linear ${identifier}: response missing issue field`,
        { adapter: "linear", retryable: false },
      );
    }
    return data.issue;
  }

  private async queryTeamStates(
    identifier: string,
    teamId: string,
  ): Promise<Map<string, string>> {
    const response = await this.postGraphQL(
      identifier,
      GET_TEAM_STATES_QUERY,
      { teamId, statesFirst: TEAM_STATES_PAGE_SIZE },
    );
    const parsed = this.parseGraphQLEnvelope<{ team: RawTeamStates | null }>(
      identifier,
      response,
    );
    if (parsed === null || parsed.team === null) {
      throw new QuayError(
        "adapter_error",
        `Linear team ${teamId}: not found while resolving workflow states`,
        { adapter: "linear", team_id: teamId, retryable: false },
      );
    }
    const map = new Map<string, string>();
    for (const node of parsed.team.states.nodes) {
      map.set(node.name, node.id);
    }
    return map;
  }

  private async runIssueUpdate(
    identifier: string,
    stateId: string,
  ): Promise<void> {
    const response = await this.postGraphQL(
      identifier,
      UPDATE_ISSUE_STATE_MUTATION,
      { id: identifier, stateId },
    );
    const parsed = this.parseGraphQLEnvelope<{
      issueUpdate: { success: boolean } | null;
    }>(identifier, response);
    // A null envelope means HTTP 404 on the issue — the ticket vanished
    // between the read and the write. Treat as best-effort no-op rather than
    // an error: the next sync (if any) will be a fresh read-before-write.
    if (parsed === null) return;
    if (parsed.issueUpdate === null || parsed.issueUpdate.success !== true) {
      throw new QuayError(
        "adapter_error",
        `Linear ${identifier}: issueUpdate returned success=false`,
        { adapter: "linear", retryable: false },
      );
    }
  }

  private async postGraphQL(
    identifier: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<LinearTransportResponse> {
    const authorization = await this.resolveAuthorizationHeader();
    const body = JSON.stringify({ query, variables });
    return this.transport({
      url: this.endpoint,
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json; charset=utf-8",
      },
      body,
    });
  }

  private parseGraphQLEnvelope<T>(
    identifier: string,
    response: LinearTransportResponse,
  ): T | null {
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
    if (status === 401 || status === 403) {
      throw new QuayError(
        "adapter_error",
        `Linear ${identifier}: auth failed (HTTP ${status}) ${truncate(response.body)}`,
        { adapter: "linear", retryable: false, status, auth_failure: true },
      );
    }
    if (status < 200 || status >= 300) {
      throw new QuayError(
        "adapter_error",
        `Linear ${identifier}: HTTP ${status} ${truncate(response.body)}`,
        { adapter: "linear", retryable: false, status },
      );
    }
    let parsed: GraphQLEnvelope<T>;
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
      // Spec §12: any non-empty `errors[]` is a hard adapter failure even
      // when `data` is also populated.
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
    return parsed.data;
  }
}

// First page of team workflow states. Workflow state counts per team are
// typically <20 in Linear; 50 is generous headroom without paging.
const TEAM_STATES_PAGE_SIZE = 50;
const RELATIONS_PAGE_SIZE = 100;

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

const GET_ISSUE_RELATIONS_QUERY = `query GetIssueRelations($id: String!, $relationsFirst: Int!, $relationsAfter: String) {
  issue(id: $id) {
    identifier
    relations(first: $relationsFirst, after: $relationsAfter) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        type
        issue {
          identifier
          url
          title
          description
          state { type }
        }
        relatedIssue {
          identifier
          url
          title
          description
          state { type }
        }
      }
    }
  }
}`;

const GET_ISSUE_INVERSE_RELATIONS_QUERY = `query GetIssueInverseRelations($id: String!, $relationsFirst: Int!, $relationsAfter: String) {
  issue(id: $id) {
    identifier
    inverseRelations(first: $relationsFirst, after: $relationsAfter) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        type
        issue {
          identifier
          url
          title
          description
          state { type }
        }
        relatedIssue {
          identifier
          url
          title
          description
          state { type }
        }
      }
    }
  }
}`;

const GET_ISSUE_HIERARCHY_QUERY = `query GetIssueHierarchy($id: String!, $childrenFirst: Int!, $childrenAfter: String) {
  issue(id: $id) {
    identifier
    parent {
      identifier
      url
      title
      state { type }
    }
    children(first: $childrenFirst, after: $childrenAfter) {
      pageInfo { hasNextPage endCursor }
      nodes {
        identifier
        url
        title
        state { type }
      }
    }
  }
}`;

// Minimal projection for the writeback path: we only need `state.id` (for
// idempotent-skip) and `team.id` (to resolve the target state). Skipping the
// comments/description fields keeps the writeback's per-call payload small.
const GET_ISSUE_STATE_REFS_QUERY = `query GetIssueStateRefs($id: String!) {
  issue(id: $id) {
    state { id name }
    team { id }
  }
}`;

// Per-team workflow state map. Cached for the process lifetime; one
// round-trip per team per process.
const GET_TEAM_STATES_QUERY = `query GetTeamStates($teamId: String!, $statesFirst: Int!) {
  team(id: $teamId) {
    states(first: $statesFirst) {
      nodes { id name }
    }
  }
}`;

// `issueUpdate` with a `stateId` input is Linear's canonical state move. The
// adapter never persists the returned issue body — only `success` matters.
const UPDATE_ISSUE_STATE_MUTATION = `mutation UpdateIssueState($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    success
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

function parseHierarchyIssue(
  raw: RawLinearHierarchyIssue,
): LinearHierarchyIssue {
  return {
    identifier: raw.identifier,
    url: raw.url,
    title: raw.title,
    stateType: raw.state?.type ?? null,
  };
}

function extractBlockingIssue(
  relation: RawLinearIssueRelation,
  currentIdentifier: string,
): RawLinearRelationIssue | null {
  const type = relation.type.toLowerCase().replace(/[_-]/g, "");
  const issue = relation.issue;
  const related = relation.relatedIssue;
  const issueIdentifier = issue?.identifier.toUpperCase() ?? null;
  const relatedIdentifier = related?.identifier.toUpperCase() ?? null;

  if (type === "blockedby") {
    if (issueIdentifier === currentIdentifier && related !== null) return related;
    if (relatedIdentifier === currentIdentifier && issue !== null) return null;
  }

  if (type === "blocks") {
    if (relatedIdentifier === currentIdentifier && issue !== null) return issue;
    if (issueIdentifier === currentIdentifier && related !== null) return null;
  }

  return null;
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
