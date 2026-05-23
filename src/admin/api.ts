import type { QuayConfig } from "../cli/config.ts";
import { DEFAULT_RETRY_BUDGET } from "../core/enqueue.ts";
import {
  buildAgentSelection,
  type AgentRole,
} from "../core/agents.ts";
import {
  DEFAULT_PREAMBLE_BODY,
  DEFAULT_REVIEWER_PREAMBLE_BODY,
  type PreambleKind,
} from "../core/preamble.ts";
import { DEFAULT_RETRY_TEMPLATES } from "../core/retries.ts";
import type { RepoRow, RepoService } from "../core/repos/service.ts";
import type { TagService, TagVocab } from "../core/tags/service.ts";
import {
  DEFAULT_CLAIM_TIMEOUT_SECONDS,
  DEFAULT_MAX_ATTEMPT_DURATION_SECONDS,
  DEFAULT_MAX_CLAIM_EXPIRATIONS,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_CONCURRENT_REVIEWERS,
  DEFAULT_MAX_NON_BUDGET_RESPAWNS,
  DEFAULT_MAX_SPAWN_FAILURES,
  DEFAULT_STALENESS_THRESHOLD_SECONDS,
  REVIEWER_GH_TOKEN_ENV,
} from "../core/tick.ts";
import type { DB } from "../db/connection.ts";

export const ADMIN_API_VERSION = "v1";
export const ADMIN_API_ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://[::1]:3000",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "http://[::1]:4173",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://[::1]:5173",
] as const;

export interface AdminApiRuntime {
  version: string;
  config: QuayConfig;
  configPath: string | null;
  dataDir: string;
  db: DB;
  env?: NodeJS.ProcessEnv;
  paths: {
    reposRoot: string;
    worktreesRoot: string;
    artifactsRoot: string;
  };
  repoService: RepoService;
  tagService: TagService;
}

type JsonHeaders = Record<string, string>;
type AdminFieldSource = "config" | "database" | "default" | "derived";
type AdminAdapterStatus = "disabled" | "ready" | "missing_env";
type AdminStatusTone = "good" | "warn" | "neutral";

interface AdminField {
  key: string;
  label: string;
  value: string | null;
  source: AdminFieldSource;
  unit?: string;
}

interface AdminAdapterField {
  label: string;
  value: string;
  dot_tone?: "good" | "warn";
  mono?: boolean;
}

interface AdminAdapterSummary {
  name: string;
  title: string;
  enabled: boolean;
  status: AdminAdapterStatus;
  status_tone: AdminStatusTone;
  status_text: string;
  fields: AdminAdapterField[];
}

interface AdminTagNamespace {
  name: string;
  required: boolean;
  values: string[];
  inherited_by?: number;
  extended_by?: number;
}

interface AdminMatrixRow {
  group: string;
  label: string;
  key: string;
  default_value: string | null;
  values: Record<string, string | null>;
}

const ACTIVE_TASK_STATES = [
  "queued",
  "running",
  "goal-completion-pending",
  "pr-open",
  "done",
  "awaiting-next-brief",
  "claimed-by-orchestrator",
  "waiting_human",
] as const;

export function createAdminApiHandler(runtime: AdminApiRuntime) {
  return async function handleAdminApi(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = pathSegments(url.pathname);
    const cors = corsDecision(request);
    if (!cors.ok) {
      return errorResponse(
        403,
        "cors_origin_not_allowed",
        `origin "${cors.origin}" is not allowed`,
        cors.headers,
      );
    }
    if (segments === null) {
      return errorResponse(
        400,
        "bad_request",
        "path contains invalid encoding",
        cors.headers,
      );
    }
    if (request.method === "OPTIONS") {
      if (!isVersionedRoute(segments)) {
        return errorResponse(
          404,
          "not_found",
          `route not found: ${url.pathname}`,
          cors.headers,
        );
      }
      return new Response(null, {
        status: 204,
        headers: {
          ...cors.headers,
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "600",
        },
      });
    }
    if (request.method !== "GET") {
      return errorResponse(
        405,
        "method_not_allowed",
        `method ${request.method} is not allowed`,
        { ...cors.headers, Allow: "GET, OPTIONS" },
      );
    }

    if (segments.length === 2 && segments[0] === "v1" && segments[1] === "meta") {
      return jsonResponse({
        service: "quay",
        api_version: ADMIN_API_VERSION,
        quay_version: runtime.version,
      }, 200, cors.headers);
    }

    if (segments.length === 2 && segments[0] === "v1" && segments[1] === "repos") {
      return jsonResponse(
        runtime.repoService.list({ activeOnly: true }),
        200,
        cors.headers,
      );
    }

    if (segments.length === 2 && segments[0] === "v1" && segments[1] === "global") {
      return jsonResponse(buildGlobalReadModel(runtime), 200, cors.headers);
    }

    if (segments.length === 2 && segments[0] === "v1" && segments[1] === "tags") {
      return jsonResponse(
        { tag_namespaces: deploymentTagNamespaces(runtime) },
        200,
        cors.headers,
      );
    }

    if (segments.length === 2 && segments[0] === "v1" && segments[1] === "matrix") {
      return jsonResponse(buildMatrixReadModel(runtime), 200, cors.headers);
    }

    if (
      segments.length === 3 &&
      segments[0] === "v1" &&
      segments[1] === "repos"
    ) {
      const repoId = segments[2];
      if (repoId === undefined) {
        return errorResponse(
          404,
          "not_found",
          `route not found: ${url.pathname}`,
          cors.headers,
        );
      }
      const row = runtime.repoService.get(repoId);
      if (row === null || row.archived_at !== null) {
        return errorResponse(
          404,
          "repo_not_found",
          `repo "${repoId}" not found`,
          cors.headers,
        );
      }
      return jsonResponse(buildRepoDetail(runtime, row), 200, cors.headers);
    }

    return errorResponse(
      404,
      "not_found",
      `route not found: ${url.pathname}`,
      cors.headers,
    );
  };
}

function isVersionedRoute(segments: string[]): boolean {
  if (segments[0] !== "v1") return false;
  if (segments.length === 2) {
    return [
      "global",
      "matrix",
      "meta",
      "repos",
      "tags",
    ].includes(segments[1] ?? "");
  }
  return segments.length === 3 && segments[1] === "repos";
}

function buildGlobalReadModel(runtime: AdminApiRuntime): Record<string, unknown> {
  const agentSelection = buildAgentSelection(runtime.config);
  const repos = runtime.repoService.list({ activeOnly: true });
  return {
    config_path: runtime.configPath,
    data_dir: runtime.dataDir,
    paths: {
      data_dir: runtime.dataDir,
      repos_root: runtime.paths.reposRoot,
      worktree_root: runtime.paths.worktreesRoot,
      artifacts_root: runtime.paths.artifactsRoot,
    },
    operations: {
      concurrency: [
        configField(
          "max_concurrent",
          "MAX_CONCURRENT",
          runtime.config.max_concurrent,
          DEFAULT_MAX_CONCURRENT,
          "workers",
        ),
        configField(
          "max_concurrent_reviewers",
          "MAX_CONCURRENT_REVIEWERS",
          runtime.config.max_concurrent_reviewers,
          DEFAULT_MAX_CONCURRENT_REVIEWERS,
          "reviewers",
        ),
      ],
      budgets: [
        configField(
          "retry_budget",
          "RETRY_BUDGET",
          runtime.config.retry_budget,
          DEFAULT_RETRY_BUDGET,
          "per task",
        ),
        configField(
          "max_non_budget_respawns",
          "MAX_NON_BUDGET_RESPAWNS",
          runtime.config.max_non_budget_respawns,
          DEFAULT_MAX_NON_BUDGET_RESPAWNS,
        ),
      ],
      live_worker_thresholds: [
        secondsField(
          "max_attempt_duration_seconds",
          "MAX_ATTEMPT_DURATION",
          runtime.config.max_attempt_duration_seconds,
          DEFAULT_MAX_ATTEMPT_DURATION_SECONDS,
        ),
        secondsField(
          "staleness_threshold_seconds",
          "STALENESS_THRESHOLD",
          runtime.config.staleness_threshold_seconds,
          DEFAULT_STALENESS_THRESHOLD_SECONDS,
        ),
        configField(
          "max_spawn_failures",
          "MAX_SPAWN_FAILURES",
          runtime.config.max_spawn_failures,
          DEFAULT_MAX_SPAWN_FAILURES,
        ),
        secondsField(
          "supervisor_lock_stale_seconds",
          "SUPERVISOR_LOCK_STALE",
          runtime.config.supervisor_lock_stale_seconds,
          null,
        ),
      ],
      claims: [
        secondsField(
          "claim_timeout_seconds",
          "CLAIM_TIMEOUT",
          runtime.config.claim_timeout_seconds,
          DEFAULT_CLAIM_TIMEOUT_SECONDS,
        ),
        configField(
          "max_claim_expirations",
          "MAX_CLAIM_EXPIRATIONS",
          runtime.config.max_claim_expirations,
          DEFAULT_MAX_CLAIM_EXPIRATIONS,
        ),
      ],
      paths: [
        derivedField("data_dir", "DATA_DIR", runtime.dataDir),
        derivedField("repos_root", "REPOS_ROOT", runtime.paths.reposRoot),
        derivedField("worktree_root", "WORKTREE_ROOT", runtime.paths.worktreesRoot),
        derivedField("artifacts_root", "ARTIFACTS_ROOT", runtime.paths.artifactsRoot),
      ],
    },
    adapters: buildAdapterSummaries(runtime),
    agents: {
      defaults: {
        worker: agentSelection.defaults.worker,
        reviewer: agentSelection.defaults.reviewer,
        worker_model: agentSelection.defaultModels?.worker ?? null,
        reviewer_model: agentSelection.defaultModels?.reviewer ?? null,
      },
      invocations: buildAgentInvocations(runtime, repos, agentSelection),
    },
    preambles: buildPreambleSummaries(runtime, repos.length),
    retry_templates: buildRetryTemplates(runtime),
    tag_namespaces: deploymentTagNamespaces(runtime),
  };
}

function buildRepoDetail(runtime: AdminApiRuntime, row: RepoRow): Record<string, unknown> {
  return {
    ...row,
    active_task_count: countActiveTasks(runtime.db, row.repo_id),
    tag_namespaces: tagNamespacesFromVocab(runtime.tagService.getVocab("repo", row.repo_id)),
    inherited_tag_namespaces: deploymentTagNamespaces(runtime),
  };
}

function buildMatrixReadModel(runtime: AdminApiRuntime): Record<string, unknown> {
  const repos = runtime.repoService.list({ activeOnly: true });
  const agentSelection = buildAgentSelection(runtime.config);
  const rows: AdminMatrixRow[] = [
    matrixRow(
      "AGENTS",
      "worker agent",
      "agent_worker",
      agentSelection.defaults.worker,
      repos,
      (repo) => repo.agent_worker,
    ),
    matrixRow(
      "AGENTS",
      "worker model",
      "model_worker",
      agentSelection.defaultModels?.worker ?? null,
      repos,
      (repo) => repo.model_worker,
    ),
    matrixRow(
      "AGENTS",
      "reviewer agent",
      "agent_reviewer",
      agentSelection.defaults.reviewer,
      repos,
      (repo) => repo.agent_reviewer,
    ),
    matrixRow(
      "AGENTS",
      "reviewer model",
      "model_reviewer",
      agentSelection.defaultModels?.reviewer ?? null,
      repos,
      (repo) => repo.model_reviewer,
    ),
    matrixRow(
      "CHECKOUT",
      "base branch",
      "base_branch",
      null,
      repos,
      (repo) => repo.base_branch,
    ),
    matrixRow(
      "BUILD",
      "package manager",
      "package_manager",
      null,
      repos,
      (repo) => repo.package_manager,
    ),
    matrixRow(
      "BUILD",
      "test command",
      "test_cmd",
      null,
      repos,
      (repo) => repo.test_cmd,
    ),
  ];

  const deploymentTags = runtime.tagService.getVocab("deployment");
  for (const [namespace, spec] of Object.entries(deploymentTags).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    rows.push({
      group: "TAGS",
      label: `${namespace} tags`,
      key: `tags.${namespace}`,
      default_value: formatTagNamespace(namespace, spec.values),
      values: Object.fromEntries(
        repos.map((repo) => {
          const repoSpec = runtime.tagService.getVocab("repo", repo.repo_id)[namespace];
          return [
            repo.repo_id,
            repoSpec === undefined
              ? null
              : formatTagNamespace(namespace, repoSpec.values),
          ];
        }),
      ),
    });
  }

  return { rows };
}

function matrixRow(
  group: string,
  label: string,
  key: string,
  defaultValue: string | null,
  repos: RepoRow[],
  select: (repo: RepoRow) => string | null,
): AdminMatrixRow {
  return {
    group,
    label,
    key,
    default_value: defaultValue,
    values: Object.fromEntries(repos.map((repo) => [repo.repo_id, select(repo)])),
  };
}

function configField(
  key: string,
  label: string,
  configured: number | string | boolean | undefined,
  fallback: number | string | boolean | null,
  unit?: string,
): AdminField {
  const field: AdminField = {
    key,
    label,
    value: configured !== undefined
      ? String(configured)
      : fallback === null
        ? null
        : String(fallback),
    source: configured !== undefined ? "config" : "default",
  };
  if (unit !== undefined) field.unit = unit;
  return field;
}

function secondsField(
  key: string,
  label: string,
  configured: number | undefined,
  fallback: number | null,
): AdminField {
  const field = configField(key, label, configured, fallback);
  return field.value === null ? field : { ...field, value: `${field.value}s` };
}

function derivedField(key: string, label: string, value: string): AdminField {
  return { key, label, value, source: "derived" };
}

function buildAdapterSummaries(runtime: AdminApiRuntime): AdminAdapterSummary[] {
  const env = runtime.env ?? process.env;
  const linearEnabled = runtime.config.adapters?.linear?.enabled === true;
  const linearEnv = runtime.config.adapters?.linear?.api_key_env ?? "LINEAR_API_KEY";
  const slackEnabled = runtime.config.adapters?.slack?.enabled === true;
  const slackEnv = runtime.config.adapters?.slack?.bot_token_env ?? "SLACK_TOKEN";
  const reviewerEnabled = runtime.config.reviewer?.enabled === true;
  const reviewerReady =
    hasEnv(env, REVIEWER_GH_TOKEN_ENV) ||
    runtime.config.reviewer?.gh_token_file !== undefined;

  return [
    {
      name: "linear",
      title: "Linear",
      enabled: linearEnabled,
      ...adapterStatus(linearEnabled, hasEnv(env, linearEnv), `env ${linearEnv} is set`, `env ${linearEnv} not set`),
      fields: [
        { label: "API_KEY_ENV", value: linearEnv, dot_tone: hasEnv(env, linearEnv) ? "good" : "warn" },
      ],
    },
    {
      name: "slack",
      title: "Slack",
      enabled: slackEnabled,
      ...adapterStatus(slackEnabled, hasEnv(env, slackEnv), `env ${slackEnv} is set`, `env ${slackEnv} not set`),
      fields: [
        { label: "BOT_TOKEN_ENV", value: slackEnv, dot_tone: hasEnv(env, slackEnv) ? "good" : "warn" },
        {
          label: "MAX_THREAD_MESSAGES",
          value: String(runtime.config.adapters?.slack?.max_thread_messages ?? 200),
        },
      ],
    },
    {
      name: "github_reviewer",
      title: "GitHub reviewer",
      enabled: reviewerEnabled,
      ...adapterStatus(
        reviewerEnabled,
        reviewerReady,
        "reviewer token source configured",
        `${REVIEWER_GH_TOKEN_ENV} or reviewer.gh_token_file not set`,
      ),
      fields: [
        {
          label: "REVIEWER_TOKEN_ENV",
          value: REVIEWER_GH_TOKEN_ENV,
          dot_tone: hasEnv(env, REVIEWER_GH_TOKEN_ENV) ? "good" : "warn",
        },
        { label: "LOGIN", value: runtime.config.reviewer?.login ?? "from gh api user" },
        {
          label: "GATE_QUAY_OWNED_DONE",
          value: String(runtime.config.reviewer?.gate_quay_owned_done ?? false),
        },
      ],
    },
  ];
}

function adapterStatus(
  enabled: boolean,
  ready: boolean,
  readyText: string,
  missingText: string,
): Pick<AdminAdapterSummary, "status" | "status_tone" | "status_text"> {
  if (!enabled) {
    return {
      status: "disabled",
      status_tone: "neutral",
      status_text: "disabled in config",
    };
  }
  if (ready) {
    return { status: "ready", status_tone: "good", status_text: readyText };
  }
  return { status: "missing_env", status_tone: "warn", status_text: missingText };
}

function hasEnv(env: NodeJS.ProcessEnv, key: string): boolean {
  return (env[key] ?? "") !== "";
}

function buildAgentInvocations(
  runtime: AdminApiRuntime,
  repos: RepoRow[],
  selection: ReturnType<typeof buildAgentSelection>,
): Array<Record<string, unknown>> {
  return Object.entries(selection.invocations)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, invocation]) => {
      const roles = (["worker", "reviewer"] as const).filter(
        (role) => invocation[role] !== undefined,
      );
      const capabilities = [
        ...new Set([
          ...(invocation.workerCapabilities ?? []),
          ...(invocation.reviewerCapabilities ?? []),
        ]),
      ];
      const commands = Object.fromEntries(
        roles.map((role) => [role, invocation[role] ?? ""]),
      );
      return {
        name,
        roles,
        commands,
        capabilities,
        used_by_repos: repos.filter((repo) =>
          roles.some((role) => effectiveRepoAgent(repo, role, selection) === name)
        ).length,
        used_by_tasks: countTasksUsingAgent(runtime.db, name),
      };
    });
}

function effectiveRepoAgent(
  repo: RepoRow,
  role: AgentRole,
  selection: ReturnType<typeof buildAgentSelection>,
): string {
  return role === "worker"
    ? repo.agent_worker ?? selection.defaults.worker
    : repo.agent_reviewer ?? selection.defaults.reviewer;
}

function countTasksUsingAgent(db: DB, agentName: string): number {
  return db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n
         FROM tasks
        WHERE worker_agent = ? OR reviewer_agent = ?`,
    )
    .get(agentName, agentName)?.n ?? 0;
}

function buildPreambleSummaries(
  runtime: AdminApiRuntime,
  repoCount: number,
): Array<Record<string, unknown>> {
  return (["code", "review"] as const).map((kind) => {
    const row = latestPreamble(runtime.db, kind);
    const body = row?.body ??
      (kind === "review" ? DEFAULT_REVIEWER_PREAMBLE_BODY : DEFAULT_PREAMBLE_BODY);
    const preambleId = row?.preamble_id ?? 0;
    return {
      kind,
      title: kind === "review" ? "Reviewer preamble" : "Worker preamble",
      version: preambleId,
      body,
      refs: preambleId === 0 ? 0 : countPreambleRefs(runtime.db, preambleId),
      last_edited: row?.created_at ?? null,
      used_by_repos: repoCount,
      override_repos: 0,
    };
  });
}

function latestPreamble(
  db: DB,
  kind: PreambleKind,
): { preamble_id: number; body: string; created_at: string } | null {
  return (
    db
      .query<
        { preamble_id: number; body: string; created_at: string },
        [string]
      >(
        `SELECT preamble_id, body, created_at
           FROM preambles
          WHERE kind = ?
          ORDER BY preamble_id DESC
          LIMIT 1`,
      )
      .get(kind) ?? null
  );
}

function countPreambleRefs(db: DB, preambleId: number): number {
  return db
    .query<{ n: number }, [number]>(
      "SELECT COUNT(*) AS n FROM attempts WHERE preamble_id = ?",
    )
    .get(preambleId)?.n ?? 0;
}

function buildRetryTemplates(runtime: AdminApiRuntime): Array<Record<string, unknown>> {
  const rows = runtime.db
    .query<
      { template_id: number; kind: string; body: string; refs: number },
      []
    >(
      `SELECT rt.template_id, rt.kind, rt.body, COUNT(a.attempt_id) AS refs
         FROM retry_templates rt
         LEFT JOIN attempts a ON a.template_id = rt.template_id
        GROUP BY rt.template_id, rt.kind, rt.body
        ORDER BY rt.kind ASC`,
    )
    .all();
  if (rows.length > 0) {
    return rows.map((row) => ({
      reason: row.kind,
      body: row.body,
      version: row.template_id,
      refs: row.refs,
    }));
  }
  return Object.entries(DEFAULT_RETRY_TEMPLATES)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, body]) => ({
      reason,
      body,
      version: 0,
      refs: 0,
    }));
}

function deploymentTagNamespaces(runtime: AdminApiRuntime): AdminTagNamespace[] {
  const inheritedBy = runtime.repoService.list({ activeOnly: true }).length;
  const extendedBy = repoTagExtensionCounts(runtime.db);
  return tagNamespacesFromVocab(runtime.tagService.getVocab("deployment")).map((ns) => ({
    ...ns,
    inherited_by: inheritedBy,
    extended_by: extendedBy.get(ns.name) ?? 0,
  }));
}

function repoTagExtensionCounts(db: DB): Map<string, number> {
  const rows = db
    .query<{ namespace: string; n: number }, []>(
      `SELECT tn.namespace, COUNT(DISTINCT tn.repo_id) AS n
         FROM tag_namespaces tn
         JOIN repos r ON r.repo_id = tn.repo_id
        WHERE tn.scope = 'repo'
          AND r.archived_at IS NULL
        GROUP BY tn.namespace`,
    )
    .all();
  return new Map(rows.map((row) => [row.namespace, row.n]));
}

function tagNamespacesFromVocab(vocab: TagVocab): AdminTagNamespace[] {
  return Object.entries(vocab)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, spec]) => ({
      name,
      required: spec.required,
      values: [...spec.values],
    }));
}

function countActiveTasks(db: DB, repoId: string): number {
  const placeholders = ACTIVE_TASK_STATES.map(() => "?").join(", ");
  return db
    .query<{ n: number }, [string, ...string[]]>(
      `SELECT COUNT(*) AS n
         FROM tasks
        WHERE repo_id = ?
          AND state IN (${placeholders})`,
    )
    .get(repoId, ...ACTIVE_TASK_STATES)?.n ?? 0;
}

function formatTagNamespace(namespace: string, values: string[]): string {
  return values.map((value) => `${namespace}-${value}`).join(", ");
}

function corsDecision(
  request: Request,
): { ok: true; headers: JsonHeaders } | { ok: false; origin: string; headers: JsonHeaders } {
  const origin = request.headers.get("origin");
  if (origin === null || origin === "") return { ok: true, headers: {} };
  const headers = { Vary: "Origin" };
  if (!ADMIN_API_ALLOWED_ORIGINS.includes(origin as typeof ADMIN_API_ALLOWED_ORIGINS[number])) {
    return { ok: false, origin, headers };
  }
  return {
    ok: true,
    headers: {
      ...headers,
      "Access-Control-Allow-Origin": origin,
    },
  };
}

function pathSegments(pathname: string): string[] | null {
  try {
    return pathname
      .split("/")
      .filter((part) => part.length > 0)
      .map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
}

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: JsonHeaders = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  extraHeaders: JsonHeaders = {},
): Response {
  return jsonResponse({ error: code, message }, status, extraHeaders);
}
