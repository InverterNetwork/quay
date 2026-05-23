import { createHash } from "node:crypto";
import { z } from "zod";
import type { QuayConfig } from "../cli/config.ts";
import { DEFAULT_RETRY_BUDGET } from "../core/enqueue.ts";
import {
  buildAgentSelection,
  type AgentRole,
} from "../core/agents.ts";
import { QuayError } from "../core/errors.ts";
import {
  adminAuthAllowedHeaders,
  adminAuthErrorResponse,
  authorizeAdminRequest,
  type AdminRequestAuditContext,
} from "./auth.ts";
import {
  DEFAULT_PREAMBLE_BODY,
  DEFAULT_REVIEWER_PREAMBLE_BODY,
  type PreambleKind,
} from "../core/preamble.ts";
import { DEFAULT_RETRY_TEMPLATES } from "../core/retries.ts";
import type { RepoRow, RepoService } from "../core/repos/service.ts";
import { repoUpdateInputSchema } from "../core/repos/schema.ts";
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
  adminAudit?: (event: AdminAuditEvent) => void;
  paths: {
    reposRoot: string;
    worktreesRoot: string;
    artifactsRoot: string;
  };
  repoService: RepoService;
  tagService: TagService;
}

export interface AdminAuditEvent extends AdminRequestAuditContext {
  action: "changes.preview" | "changes.apply";
  method: string;
  path: string;
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

type RepoPatch = z.infer<typeof repoUpdateInputSchema>;
type AdminChange = z.infer<typeof changeSchema>;

interface AdminChangeOperation {
  op_id: string;
  type: string;
  scope: string;
  target: string;
  field?: string;
  before: unknown;
  after: unknown;
  summary: string;
}

interface AdminChangePreview {
  base_revision: string;
  current_revision: string;
  valid: true;
  summary: string[];
  operations: AdminChangeOperation[];
}

class AdminHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AdminHttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const tagNamespaceInputSchema = z
  .object({
    name: z.string().min(1),
    required: z.boolean(),
    values: z.array(z.string()),
  })
  .strict();

const repoUpdateChangeSchema = z
  .object({
    type: z.literal("repo.update"),
    repo_id: z.string().min(1),
    patch: repoUpdateInputSchema,
  })
  .strict()
  .refine((change) => Object.keys(change.patch).length > 0, {
    message: "repo.update patch must include at least one field",
    path: ["patch"],
  });

const tagReplaceChangeSchema = z
  .object({
    type: z.literal("tags.replace"),
    scope: z.enum(["deployment", "repo"]),
    repo_id: z.string().min(1).optional(),
    tag_namespaces: z.array(tagNamespaceInputSchema),
  })
  .strict()
  .superRefine((change, ctx) => {
    if (change.scope === "repo" && change.repo_id === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["repo_id"],
        message: "repo_id is required for repo tag changes",
      });
    }
    if (change.scope === "deployment" && change.repo_id !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["repo_id"],
        message: "repo_id is only valid for repo tag changes",
      });
    }
    const seen = new Set<string>();
    for (const [index, namespace] of change.tag_namespaces.entries()) {
      if (seen.has(namespace.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tag_namespaces", index, "name"],
          message: `duplicate namespace "${namespace.name}"`,
        });
      }
      seen.add(namespace.name);
    }
  });

const changeSchema = z.union([
  repoUpdateChangeSchema,
  tagReplaceChangeSchema,
]);

const changeRequestSchema = z
  .object({
    base_revision: z.string().min(1),
    changes: z.array(changeSchema).min(1),
  })
  .strict();

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
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": adminAuthAllowedHeaders(runtime),
          "Access-Control-Max-Age": "600",
        },
      });
    }

    const auth = authorizeAdminRequest(runtime, request);
    if (!auth.ok) {
      return adminAuthErrorResponse(auth.failure, cors.headers);
    }

    if (request.method === "POST") {
      if (isWriteRoute(segments, "preview")) {
        return handleAdminMutation(
          cors.headers,
          () => {
            recordAdminAudit(runtime, request, "changes.preview", auth.audit);
            return previewChanges(runtime, request);
          },
        );
      }
      if (isWriteRoute(segments, "apply")) {
        return handleAdminMutation(
          cors.headers,
          () => {
            recordAdminAudit(runtime, request, "changes.apply", auth.audit);
            return applyChanges(runtime, request);
          },
        );
      }
      if (!isVersionedRoute(segments)) {
        return errorResponse(
          404,
          "not_found",
          `route not found: ${url.pathname}`,
          cors.headers,
        );
      }
      return errorResponse(
        405,
        "method_not_allowed",
        `method ${request.method} is not allowed`,
        { ...cors.headers, Allow: "GET, OPTIONS" },
      );
    }

    if (request.method !== "GET") {
      return errorResponse(
        405,
        "method_not_allowed",
        `method ${request.method} is not allowed`,
        { ...cors.headers, Allow: "GET, POST, OPTIONS" },
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
      const body = buildGlobalReadModel(runtime);
      return jsonResponse(
        body,
        200,
        { ...cors.headers, ETag: quoteEtag(body.revision as string) },
      );
    }

    if (segments.length === 2 && segments[0] === "v1" && segments[1] === "tags") {
      const revision = computeAdminRevision(runtime);
      return jsonResponse(
        { revision, tag_namespaces: deploymentTagNamespaces(runtime) },
        200,
        { ...cors.headers, ETag: quoteEtag(revision) },
      );
    }

    if (segments.length === 2 && segments[0] === "v1" && segments[1] === "matrix") {
      const body = buildMatrixReadModel(runtime);
      return jsonResponse(
        body,
        200,
        { ...cors.headers, ETag: quoteEtag(body.revision as string) },
      );
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
      const body = buildRepoDetail(runtime, row);
      return jsonResponse(
        body,
        200,
        { ...cors.headers, ETag: quoteEtag(body.revision as string) },
      );
    }

    return errorResponse(
      404,
      "not_found",
      `route not found: ${url.pathname}`,
      cors.headers,
    );
  };
}

function recordAdminAudit(
  runtime: AdminApiRuntime,
  request: Request,
  action: AdminAuditEvent["action"],
  audit: AdminRequestAuditContext,
): void {
  runtime.adminAudit?.({
    action,
    method: request.method,
    path: new URL(request.url).pathname,
    ...audit,
  });
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
  if (segments.length === 3 && segments[1] === "changes") {
    return ["preview", "apply"].includes(segments[2] ?? "");
  }
  return segments.length === 3 && segments[1] === "repos";
}

function isWriteRoute(
  segments: string[],
  action: "preview" | "apply",
): boolean {
  return segments.length === 3 &&
    segments[0] === "v1" &&
    segments[1] === "changes" &&
    segments[2] === action;
}

function buildGlobalReadModel(runtime: AdminApiRuntime): Record<string, unknown> {
  const agentSelection = buildAgentSelection(runtime.config);
  const repos = runtime.repoService.list({ activeOnly: true });
  return {
    revision: computeAdminRevision(runtime),
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
    revision: computeAdminRevision(runtime),
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

  return { revision: computeAdminRevision(runtime), rows };
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

async function handleAdminMutation(
  corsHeaders: JsonHeaders,
  run: () => Promise<unknown>,
): Promise<Response> {
  try {
    const body = await run();
    const record = body !== null && typeof body === "object"
      ? body as Record<string, unknown>
      : {};
    const revision =
      typeof record.revision === "string"
        ? record.revision
        : typeof record.current_revision === "string"
          ? record.current_revision
          : undefined;
    return jsonResponse(
      body,
      200,
      revision === undefined
        ? corsHeaders
        : { ...corsHeaders, ETag: quoteEtag(revision) },
    );
  } catch (err) {
    return adminErrorResponse(err, corsHeaders);
  }
}

async function previewChanges(
  runtime: AdminApiRuntime,
  request: Request,
): Promise<AdminChangePreview> {
  const parsed = await parseChangeRequest(request);
  assertCurrentRevision(runtime, parsed.base_revision);
  return buildChangePreview(runtime, parsed.base_revision, parsed.changes);
}

async function applyChanges(
  runtime: AdminApiRuntime,
  request: Request,
): Promise<Record<string, unknown>> {
  const parsed = await parseChangeRequest(request);
  let preview: AdminChangePreview | undefined;
  let revision: string | undefined;
  let readModel: Record<string, unknown> | undefined;
  try {
    runtime.db.transaction(() => {
      assertCurrentRevision(runtime, parsed.base_revision);
      preview = buildChangePreview(
        runtime,
        parsed.base_revision,
        parsed.changes,
      );
      for (const change of parsed.changes) {
        applyOneChange(runtime, change);
      }
      revision = computeAdminRevision(runtime);
      readModel = buildAdminReadModel(runtime);
    })();
  } catch (err) {
    if (err instanceof QuayError || err instanceof AdminHttpError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new AdminHttpError(
      500,
      "apply_failed",
      `failed to apply changes: ${message}`,
    );
  }
  if (preview === undefined || revision === undefined || readModel === undefined) {
    throw new AdminHttpError(500, "apply_failed", "failed to apply changes");
  }
  return {
    previous_revision: parsed.base_revision,
    revision,
    preview,
    read_model: readModel,
  };
}

async function parseChangeRequest(request: Request): Promise<{
  base_revision: string;
  changes: AdminChange[];
}> {
  const raw = await readJsonBody(request);
  const unsupported = unsupportedChangeType(raw);
  if (unsupported !== null) {
    throw new AdminHttpError(
      422,
      "unsupported_change",
      `unsupported change type "${unsupported}"`,
      { supported_types: ["repo.update", "tags.replace"] },
    );
  }
  const result = changeRequestSchema.safeParse(raw);
  if (!result.success) {
    const summary = result.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new AdminHttpError(
      400,
      "validation_error",
      `change request invalid: ${summary}`,
      { issues: result.error.issues },
    );
  }
  return result.data;
}

async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === "") {
    throw new AdminHttpError(
      400,
      "validation_error",
      "request body must be a JSON object",
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AdminHttpError(
      400,
      "validation_error",
      `request body is not valid JSON: ${message}`,
    );
  }
}

function unsupportedChangeType(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object") return null;
  const changes = (raw as { changes?: unknown }).changes;
  if (!Array.isArray(changes)) return null;
  for (const change of changes) {
    if (change === null || typeof change !== "object") continue;
    const type = (change as { type?: unknown }).type;
    if (
      typeof type === "string" &&
      type !== "repo.update" &&
      type !== "tags.replace"
    ) {
      return type;
    }
  }
  return null;
}

function assertCurrentRevision(
  runtime: AdminApiRuntime,
  baseRevision: string,
): void {
  const current = computeAdminRevision(runtime);
  if (baseRevision !== current) {
    throw new AdminHttpError(
      409,
      "stale_revision",
      "submitted changes were based on a stale Admin API revision; reload before retrying",
      { base_revision: baseRevision, current_revision: current },
    );
  }
}

function buildChangePreview(
  runtime: AdminApiRuntime,
  baseRevision: string,
  changes: AdminChange[],
): AdminChangePreview {
  const operations: AdminChangeOperation[] = [];
  for (const [index, change] of changes.entries()) {
    if (change.type === "repo.update") {
      operations.push(...repoUpdateOperations(runtime, change, index));
      continue;
    }
    operations.push(...tagReplaceOperations(runtime, change, index));
  }
  return {
    base_revision: baseRevision,
    current_revision: computeAdminRevision(runtime),
    valid: true,
    summary: operations.length === 0
      ? ["No effective changes."]
      : operations.map((operation) => operation.summary),
    operations,
  };
}

function repoUpdateOperations(
  runtime: AdminApiRuntime,
  change: Extract<AdminChange, { type: "repo.update" }>,
  changeIndex: number,
): AdminChangeOperation[] {
  const repo = assertActiveRepo(runtime, change.repo_id);
  validateAgentPatch(runtime, change.repo_id, change.patch);
  const operations: AdminChangeOperation[] = [];
  for (const field of REPO_PATCH_FIELDS) {
    if (!(field in change.patch)) continue;
    const after = change.patch[field];
    const before = repo[field];
    if (before === after) continue;
    operations.push({
      op_id: `change-${changeIndex + 1}:${field}`,
      type: "repo.update",
      scope: "repo",
      target: change.repo_id,
      field,
      before,
      after,
      summary:
        `repo ${change.repo_id}: set ${field} from ${formatPreviewValue(before)} to ${formatPreviewValue(after)}`,
    });
  }
  return operations;
}

function tagReplaceOperations(
  runtime: AdminApiRuntime,
  change: Extract<AdminChange, { type: "tags.replace" }>,
  changeIndex: number,
): AdminChangeOperation[] {
  const repoId = change.scope === "repo" ? change.repo_id! : null;
  if (repoId !== null) assertActiveRepo(runtime, repoId);
  const desired = tagVocabFromChange(runtime, change);
  const current = runtime.tagService.getVocab(
    change.scope,
    repoId === null ? undefined : repoId,
  );
  const operations: AdminChangeOperation[] = [];
  const namespaces = [
    ...new Set([...Object.keys(current), ...Object.keys(desired)]),
  ].sort();
  for (const namespace of namespaces) {
    const before = current[namespace] ?? null;
    const after = desired[namespace] ?? null;
    if (stableJson(before) === stableJson(after)) continue;
    const target = repoId === null ? "deployment" : repoId;
    operations.push({
      op_id: `change-${changeIndex + 1}:tags:${namespace}`,
      type: "tag_namespace.replace",
      scope: change.scope,
      target,
      field: namespace,
      before,
      after,
      summary:
        `${target} tags: replace ${namespace} from ${formatPreviewValue(before)} to ${formatPreviewValue(after)}`,
    });
  }
  return operations;
}

function applyOneChange(runtime: AdminApiRuntime, change: AdminChange): void {
  if (change.type === "repo.update") {
    validateAgentPatch(runtime, change.repo_id, change.patch);
    runtime.repoService.update(change.repo_id, change.patch);
    return;
  }
  const repoId = change.scope === "repo" ? change.repo_id! : null;
  runtime.tagService.apply(change.scope, repoId, tagVocabFromChange(runtime, change));
}

const REPO_PATCH_FIELDS = [
  "repo_url",
  "base_branch",
  "package_manager",
  "install_cmd",
  "test_cmd",
  "ci_workflow_name",
  "contribution_guide_path",
  "agent_worker",
  "agent_reviewer",
  "model_worker",
  "model_reviewer",
] as const satisfies readonly (keyof RepoPatch)[];

function assertActiveRepo(runtime: AdminApiRuntime, repoId: string): RepoRow {
  const repo = runtime.repoService.get(repoId);
  if (repo === null) {
    throw new QuayError("unknown_repo", `repo "${repoId}" not found`, {
      repo_id: repoId,
    });
  }
  if (repo.archived_at !== null) {
    throw new QuayError("repo_archived", `repo "${repoId}" is archived`, {
      repo_id: repoId,
    });
  }
  return repo;
}

function validateAgentPatch(
  runtime: AdminApiRuntime,
  repoId: string,
  patch: RepoPatch,
): void {
  const selection = buildAgentSelection(runtime.config);
  const entries = [
    ["worker", patch.agent_worker],
    ["reviewer", patch.agent_reviewer],
  ] as const;
  for (const [role, agentName] of entries) {
    if (agentName === undefined || agentName === null) continue;
    const invocation = selection.invocations[agentName];
    if (invocation === undefined || invocation[role] === undefined) {
      throw new QuayError(
        "validation_error",
        `agent "${agentName}" is not registered for ${role} role`,
        { repo_id: repoId, role, agent: agentName },
      );
    }
  }
}

function tagVocabFromChange(
  runtime: AdminApiRuntime,
  change: Extract<AdminChange, { type: "tags.replace" }>,
): TagVocab {
  const desired = Object.fromEntries(
    [...change.tag_namespaces]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((namespace) => [
        namespace.name,
        {
          required: namespace.required,
          values: [...new Set(namespace.values)].sort(),
        },
      ]),
  );
  const validated = runtime.tagService.validateApply(
    change.scope,
    change.scope === "repo" ? change.repo_id! : null,
    desired,
  );
  return Object.fromEntries(
    Object.entries(validated).map(([namespace, spec]) => [
      namespace,
      { required: spec.required ?? false, values: spec.values },
    ]),
  );
}

function buildAdminReadModel(runtime: AdminApiRuntime): Record<string, unknown> {
  return {
    revision: computeAdminRevision(runtime),
    global: buildGlobalReadModel(runtime),
    matrix: buildMatrixReadModel(runtime),
    repos: runtime.repoService
      .list({ activeOnly: true })
      .map((repo) => buildRepoDetail(runtime, repo)),
  };
}

function computeAdminRevision(runtime: AdminApiRuntime): string {
  const state = {
    version: 1,
    repos: runtime.repoService.list({ activeOnly: true }),
    deployment_tags: runtime.tagService.getVocab("deployment"),
    repo_tags: Object.fromEntries(
      runtime.repoService
        .list({ activeOnly: true })
        .map((repo) => [
          repo.repo_id,
          runtime.tagService.getVocab("repo", repo.repo_id),
        ]),
    ),
  };
  const digest = createHash("sha256").update(stableJson(state)).digest("hex");
  return `sha256:${digest}`;
}

function stableJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function formatPreviewValue(value: unknown): string {
  if (value === null || value === undefined) return "unset";
  if (typeof value === "string") return JSON.stringify(value);
  return stableJson(value);
}

function quoteEtag(revision: string): string {
  return `"${revision}"`;
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
  if (!isAllowedCorsOrigin(origin, request)) {
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

function isAllowedCorsOrigin(origin: string, request: Request): boolean {
  if (
    ADMIN_API_ALLOWED_ORIGINS.includes(
      origin as typeof ADMIN_API_ALLOWED_ORIGINS[number],
    )
  ) {
    return true;
  }
  return origin === new URL(request.url).origin;
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

function adminErrorResponse(err: unknown, extraHeaders: JsonHeaders): Response {
  if (err instanceof AdminHttpError) {
    return errorResponse(
      err.status,
      err.code,
      err.message,
      extraHeaders,
      err.details,
    );
  }
  if (err instanceof QuayError) {
    return errorResponse(
      statusForQuayError(err),
      err.code,
      err.message,
      extraHeaders,
      err.details,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return errorResponse(
    500,
    "apply_failed",
    `Admin API request failed: ${message}`,
    extraHeaders,
  );
}

function statusForQuayError(err: QuayError): number {
  switch (err.code) {
    case "stale_revision":
      return 409;
    case "unsupported_change":
      return 422;
    case "repo_has_active_tasks":
      return 409;
    case "validation_error":
    case "unknown_repo":
    case "repo_archived":
    case "duplicate_repo":
      return 400;
    default:
      return 500;
  }
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  extraHeaders: JsonHeaders = {},
  details?: Record<string, unknown>,
): Response {
  return jsonResponse(
    details === undefined ? { error: code, message } : { error: code, message, details },
    status,
    extraHeaders,
  );
}
