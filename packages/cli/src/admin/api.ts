import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { SQLQueryBindings } from "bun:sqlite";
import { z } from "zod";
import type { QuayConfig } from "../cli/config.ts";
import { DEFAULT_RETRY_BUDGET } from "../core/enqueue.ts";
import {
  buildAgentSelection,
  type AgentRole,
} from "../core/agents.ts";
import { QuayError } from "../core/errors.ts";
import { ciPolicyFromConfig, resolveCiIgnorePolicy } from "../core/ci_policy.ts";
import { TASK_STATES, type TaskState } from "../core/task_state.ts";
import {
  adminAuthAllowedHeaders,
  adminAuthErrorResponse,
  authorizeAdminRequest,
  type AdminRequestAuditContext,
} from "./auth.ts";
import {
  assertPreambleKind,
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
  timestamp: string;
  success: boolean;
  status: number;
  operation_summary: string[];
  target_resources: string[];
  error_code?: string;
  error_message?: string;
}

type AdminAuditOutcome = Omit<
  AdminAuditEvent,
  keyof AdminRequestAuditContext | "action" | "method" | "path" | "timestamp"
>;
type AdminAuditMutationDetails = Pick<
  AdminAuditEvent,
  "operation_summary" | "target_resources"
>;

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

type AdminMissionControlAttnReason =
  | "changes"
  | "ci"
  | "slack"
  | "brief"
  | "budget"
  | "loop"
  | "worktree";

interface AdminMissionControlTask {
  id: string;
  ext: string;
  repo: string;
  title: string;
  branch: string;
  state: TaskState;
  pr: number | null;
  budget: number;
  total: number;
  latest: string;
  agent: string;
  age: string;
  updatedAt: string;
  authors: string[];
  attn?: AdminMissionControlAttnReason;
  attnTone?: "warn" | "danger";
}

interface AdminMissionControlReadModel {
  refreshedAt: string;
  activeTaskCount: number;
  hasAttention: boolean;
  tasks: AdminMissionControlTask[];
}

interface AdminRepoEffectivePreamble {
  role: "worker" | "reviewer";
  kind: PreambleKind;
  source: "repo" | "global";
  configured_preamble_id: number | null;
  effective_preamble_id: number;
  title: string;
  body: string;
  refs: number;
  last_edited: string | null;
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

const mutationAuditErrorDetails = new WeakMap<object, AdminAuditMutationDetails>();

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
      const allowedMethods = allowedMethodsForRoute(segments);
      if (allowedMethods === null) {
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
          "Access-Control-Allow-Methods": allowedMethods,
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
          request,
          runtime,
          "changes.preview",
          auth.audit,
          () => previewChanges(runtime, request),
        );
      }
      if (isWriteRoute(segments, "apply")) {
        return handleAdminMutation(
          cors.headers,
          request,
          runtime,
          "changes.apply",
          auth.audit,
          () => applyChanges(runtime, request),
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
        { ...cors.headers, Allow: allowedMethodsForRoute(segments) ?? "GET, OPTIONS" },
      );
    }

    if (request.method !== "GET") {
      return errorResponse(
        405,
        "method_not_allowed",
        `method ${request.method} is not allowed`,
        { ...cors.headers, Allow: allowedMethodsForRoute(segments) ?? "GET, POST, OPTIONS" },
      );
    }

    if (allowedMethodsForRoute(segments) === "POST, OPTIONS") {
      return errorResponse(
        405,
        "method_not_allowed",
        `method ${request.method} is not allowed`,
        { ...cors.headers, Allow: "POST, OPTIONS" },
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

    if (segments.length === 2 && segments[0] === "v1" && segments[1] === "tasks") {
      return jsonResponse(
        await buildMissionControlReadModel(runtime),
        200,
        cors.headers,
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
  outcome: AdminAuditOutcome,
): void {
  runtime.adminAudit?.({
    action,
    method: request.method,
    path: new URL(request.url).pathname,
    timestamp: new Date().toISOString(),
    ...audit,
    ...outcome,
  });
}

function isVersionedRoute(segments: string[]): boolean {
  return allowedMethodsForRoute(segments) !== null;
}

function allowedMethodsForRoute(segments: string[]): string | null {
  if (segments[0] !== "v1") return null;
  if (segments.length === 2) {
    return [
      "global",
      "matrix",
      "meta",
      "repos",
      "tags",
      "tasks",
    ].includes(segments[1] ?? "") ? "GET, OPTIONS" : null;
  }
  if (segments.length === 3 && segments[1] === "changes") {
    return ["preview", "apply"].includes(segments[2] ?? "")
      ? "POST, OPTIONS"
      : null;
  }
  return segments.length === 3 && segments[1] === "repos"
    ? "GET, OPTIONS"
    : null;
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

interface MissionControlTaskRow {
  task_id: string;
  repo_id: string;
  external_ref: string | null;
  state: string;
  branch_name: string;
  pr_number: number | null;
  attempts_consumed: number;
  retry_budget: number;
  authors_json: string | null;
  worker_agent: string | null;
  worker_model: string | null;
  reviewer_agent: string | null;
  reviewer_model: string | null;
  goal_objective: string | null;
  objective_file_path: string | null;
  updated_at: string;
  created_at: string;
}

interface MissionControlEventRow {
  task_id: string;
  event_type: string;
  occurred_at: string;
}

const TASK_STATE_SET = new Set<string>(TASK_STATES);
const MISSION_CONTROL_TERMINAL_STATE_LIST = [
  "merged",
  "cancelled",
  "closed_unmerged",
] as const satisfies readonly TaskState[];
const MISSION_CONTROL_TERMINAL_STATES = new Set<TaskState>(MISSION_CONTROL_TERMINAL_STATE_LIST);
const MISSION_CONTROL_ACTIVE_STATES = TASK_STATES.filter(
  (state) => !MISSION_CONTROL_TERMINAL_STATES.has(state),
);
const MISSION_CONTROL_ACTIVE_TASK_LIMIT = 200;
const MISSION_CONTROL_TERMINAL_TASK_LIMIT = 50;
const MISSION_CONTROL_EVENTS_PER_TASK = 5;

function sqlPlaceholders(values: readonly unknown[]): string {
  if (values.length === 0) throw new Error("SQL placeholder list cannot be empty");
  return values.map(() => "?").join(", ");
}

async function buildMissionControlReadModel(
  runtime: AdminApiRuntime,
): Promise<AdminMissionControlReadModel> {
  const rows = missionControlTaskRows(runtime.db);
  const eventsByTask = recentMissionControlEventsByTask(
    runtime.db,
    rows.map((row) => row.task_id),
  );
  const now = new Date();
  const tasks = (
    await Promise.all(
      rows.map((row) =>
        missionControlTaskFromRow(row, now, eventsByTask.get(row.task_id) ?? []),
      ),
    )
  ).filter((task): task is AdminMissionControlTask => task !== null);

  return {
    refreshedAt: now.toISOString(),
    activeTaskCount: missionControlActiveTaskCount(runtime.db),
    hasAttention: tasks.some((task) => task.attn !== undefined),
    tasks,
  };
}

function missionControlTaskRows(db: DB): MissionControlTaskRow[] {
  return db
    .query<MissionControlTaskRow, SQLQueryBindings[]>(
      `WITH candidate_tasks AS (
         SELECT t.task_id, t.repo_id, t.external_ref, t.state, t.branch_name,
                t.pr_number, t.attempts_consumed, t.retry_budget, t.authors_json,
                t.worker_agent, t.worker_model, t.reviewer_agent, t.reviewer_model,
                tg.objective AS goal_objective,
                (
                  SELECT ar.file_path
                    FROM artifacts ar
                   WHERE ar.task_id = t.task_id
                     AND ar.kind = 'task_objective'
                     AND ar.attempt_id IS NULL
                   ORDER BY ar.artifact_id ASC
                   LIMIT 1
                ) AS objective_file_path,
                t.updated_at, t.created_at,
                CASE
                  WHEN t.state IN (${sqlPlaceholders(MISSION_CONTROL_TERMINAL_STATE_LIST)})
                  THEN 1
                  ELSE 0
                END AS terminal_bucket
           FROM tasks t
           JOIN repos r ON r.repo_id = t.repo_id
           LEFT JOIN task_goals tg ON tg.task_id = t.task_id
          WHERE r.archived_at IS NULL
            AND t.state IN (${sqlPlaceholders(TASK_STATES)})
       ),
       ranked_tasks AS (
         SELECT candidate_tasks.*,
                ROW_NUMBER() OVER (
                  PARTITION BY terminal_bucket
                  ORDER BY updated_at DESC, task_id ASC
                ) AS bucket_rank
           FROM candidate_tasks
       )
       SELECT task_id, repo_id, external_ref, state, branch_name,
              pr_number, attempts_consumed, retry_budget, authors_json,
              worker_agent, worker_model, reviewer_agent, reviewer_model,
              goal_objective, objective_file_path, updated_at, created_at
         FROM ranked_tasks
        WHERE (terminal_bucket = 0 AND bucket_rank <= ?)
           OR (terminal_bucket = 1 AND bucket_rank <= ?)
        ORDER BY terminal_bucket ASC, updated_at DESC, task_id ASC`,
    )
    .all(
      ...MISSION_CONTROL_TERMINAL_STATE_LIST,
      ...TASK_STATES,
      MISSION_CONTROL_ACTIVE_TASK_LIMIT,
      MISSION_CONTROL_TERMINAL_TASK_LIMIT,
    );
}

function missionControlActiveTaskCount(db: DB): number {
  const row = db
    .query<{ count: number }, SQLQueryBindings[]>(
      `SELECT COUNT(*) AS count
         FROM tasks t
         JOIN repos r ON r.repo_id = t.repo_id
        WHERE r.archived_at IS NULL
          AND t.state IN (${sqlPlaceholders(MISSION_CONTROL_ACTIVE_STATES)})`,
    )
    .get(...MISSION_CONTROL_ACTIVE_STATES);
  return row?.count ?? 0;
}

async function missionControlTaskFromRow(
  row: MissionControlTaskRow,
  now: Date,
  recentEvents: readonly MissionControlEventRow[],
): Promise<AdminMissionControlTask | null> {
  const state = toTaskState(row.state);
  if (state === null) return null;
  const attention = deriveMissionControlAttention(state, recentEvents);
  const task: AdminMissionControlTask = {
    id: row.task_id,
    ext: row.external_ref ?? "—",
    repo: row.repo_id,
    title: await titleForMissionControl(row),
    branch: row.branch_name.trim() === "" ? "—" : row.branch_name,
    state,
    pr: row.pr_number,
    budget: row.attempts_consumed,
    total: row.retry_budget,
    latest: formatLatestMissionControlEvent(recentEvents[0]),
    agent: missionControlAgent(row, state),
    age: formatAge(row.updated_at, now),
    updatedAt: row.updated_at,
    authors: parseMissionControlAuthors(row.authors_json),
  };
  if (attention !== null) {
    task.attn = attention.reason;
    task.attnTone = attention.tone;
  }
  return task;
}

function toTaskState(state: string): TaskState | null {
  if (TASK_STATE_SET.has(state)) return state as TaskState;
  return null;
}

function recentMissionControlEventsByTask(
  db: DB,
  taskIds: readonly string[],
): Map<string, MissionControlEventRow[]> {
  if (taskIds.length === 0) return new Map();
  const rows = db
    .query<MissionControlEventRow, SQLQueryBindings[]>(
      `WITH ranked_events AS (
         SELECT task_id, event_type, occurred_at,
                ROW_NUMBER() OVER (
                  PARTITION BY task_id
                  ORDER BY occurred_at DESC, event_id DESC
                ) AS event_rank
           FROM events
          WHERE task_id IN (${sqlPlaceholders(taskIds)})
       )
       SELECT task_id, event_type, occurred_at
         FROM ranked_events
        WHERE event_rank <= ?
        ORDER BY task_id ASC, event_rank ASC`,
    )
    .all(...taskIds, MISSION_CONTROL_EVENTS_PER_TASK);
  const byTask = new Map<string, MissionControlEventRow[]>();
  for (const row of rows) {
    const events = byTask.get(row.task_id);
    if (events === undefined) {
      byTask.set(row.task_id, [row]);
    } else {
      events.push(row);
    }
  }
  return byTask;
}

function deriveMissionControlAttention(
  state: TaskState,
  recentEvents: readonly MissionControlEventRow[],
): { reason: AdminMissionControlAttnReason; tone: "warn" | "danger" } | null {
  if (state === "worktree_error") return { reason: "worktree", tone: "danger" };
  if (state === "non_budget_loop") return { reason: "loop", tone: "danger" };
  if (state === "orchestrator_loop") return { reason: "loop", tone: "danger" };

  const latest = recentEvents[0]?.event_type;
  if (latest === "ci_failed") return { reason: "ci", tone: "danger" };
  if (latest === "budget_exhausted") return { reason: "budget", tone: "danger" };
  if (state === "waiting_human") return { reason: "slack", tone: "warn" };
  if (state === "awaiting-next-brief") return { reason: "brief", tone: "warn" };
  if (latest === "changes_requested") return { reason: "changes", tone: "warn" };

  return null;
}

async function titleForMissionControl(row: MissionControlTaskRow): Promise<string> {
  const fromGoal = summarizeTaskObjective(row.goal_objective);
  if (fromGoal !== null) return fromGoal;
  const fromArtifact = summarizeTaskObjective(await readOptionalTextFile(row.objective_file_path));
  if (fromArtifact !== null) return fromArtifact;
  return row.external_ref ?? row.task_id;
}

function summarizeTaskObjective(value: string | null): string | null {
  if (value === null) return null;
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine
      .trim()
      .replace(/^#+\s*/, "")
      .replace(/^[-*]\s*/, "");
    if (line !== "") return line.length > 120 ? `${line.slice(0, 117)}...` : line;
  }
  return null;
}

async function readOptionalTextFile(path: string | null): Promise<string | null> {
  if (path === null) return null;
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function formatLatestMissionControlEvent(event: MissionControlEventRow | undefined): string {
  if (event === undefined) return "no events recorded";
  switch (event.event_type) {
    case "ci_failed":
      return "CI failed";
    case "budget_exhausted":
      return "budget exhausted";
    case "changes_requested":
      return "changes requested";
    case "review_requested":
      return "review requested";
    case "spawned":
      return "worker spawned";
    case "pr_opened":
      return "PR opened";
    case "ci_passed":
      return "CI passed";
    case "pr_merged":
      return "PR merged";
    default:
      return event.event_type.replace(/_/g, " ");
  }
}

function missionControlAgent(row: MissionControlTaskRow, state: TaskState): string {
  if (state === "pr-review") {
    return row.reviewer_model ?? row.reviewer_agent ?? row.worker_model ?? row.worker_agent ?? "—";
  }
  return row.worker_model ?? row.worker_agent ?? row.reviewer_model ?? row.reviewer_agent ?? "—";
}

function parseMissionControlAuthors(authorsJson: string | null): string[] {
  if (authorsJson === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(authorsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const authors: string[] = [];
  for (const entry of parsed) {
    if (typeof entry === "string" && entry.trim() !== "") {
      authors.push(entry.trim());
      continue;
    }
    if (entry !== null && typeof entry === "object") {
      const name = (entry as { name?: unknown }).name;
      if (typeof name === "string" && name.trim() !== "") authors.push(name.trim());
    }
  }
  return authors;
}

function formatAge(timestamp: string, now: Date): string {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return "—";
  const seconds = Math.max(0, Math.floor((now.getTime() - parsed) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
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
    ci_policy: {
      ignored_check_names: ciPolicyFromConfig(runtime.config).ignoredCheckNames,
      ignored_workflow_names: ciPolicyFromConfig(runtime.config).ignoredWorkflowNames,
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
  const globalCiPolicy = ciPolicyFromConfig(runtime.config);
  const effectiveCiPolicy = resolveCiIgnorePolicy(globalCiPolicy, row);
  return {
    revision: computeAdminRevision(runtime),
    ...row,
    active_task_count: countActiveTasks(runtime.db, row.repo_id),
    effective_preambles: {
      worker: buildRepoEffectivePreamble(runtime, row, "worker"),
      reviewer: buildRepoEffectivePreamble(runtime, row, "reviewer"),
    },
    ci_policy: {
      ignore_mode: row.ci_ignore_mode,
      ignored_check_names: row.ignored_check_names,
      ignored_workflow_names: row.ignored_workflow_names,
      effective_ignored_check_names: effectiveCiPolicy.ignoredCheckNames,
      effective_ignored_workflow_names: effectiveCiPolicy.ignoredWorkflowNames,
    },
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
      "PROMPTS",
      "worker preamble",
      "preamble_worker",
      latestPreamble(runtime.db, "code")?.preamble_id.toString() ?? null,
      repos,
      (repo) => repo.preamble_worker?.toString() ?? null,
    ),
    matrixRow(
      "PROMPTS",
      "reviewer preamble",
      "preamble_reviewer",
      latestPreamble(runtime.db, "review")?.preamble_id.toString() ?? null,
      repos,
      (repo) => repo.preamble_reviewer?.toString() ?? null,
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
  request: Request,
  runtime: AdminApiRuntime,
  action: AdminAuditEvent["action"],
  audit: AdminRequestAuditContext,
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
    const response = jsonResponse(
      body,
      200,
      revision === undefined
        ? corsHeaders
        : { ...corsHeaders, ETag: quoteEtag(revision) },
    );
    recordAdminAudit(runtime, request, action, audit, {
      success: true,
      status: response.status,
      ...auditDetailsFromMutationBody(body),
    });
    return response;
  } catch (err) {
    const response = adminErrorResponse(err, corsHeaders);
    recordAdminAudit(runtime, request, action, audit, {
      success: false,
      status: response.status,
      ...auditDetailsFromMutationError(err),
    });
    return response;
  }
}

async function previewChanges(
  runtime: AdminApiRuntime,
  request: Request,
): Promise<AdminChangePreview> {
  const parsed = await parseChangeRequest(request);
  try {
    assertCurrentRevision(runtime, parsed.base_revision);
    return buildChangePreview(runtime, parsed.base_revision, parsed.changes);
  } catch (err) {
    throwWithMutationAuditDetails(err, auditDetailsFromChanges(parsed.changes));
  }
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
    if (err instanceof QuayError || err instanceof AdminHttpError) {
      throwWithMutationAuditDetails(err, auditDetailsFromChanges(parsed.changes));
    }
    const message = err instanceof Error ? err.message : String(err);
    throwWithMutationAuditDetails(new AdminHttpError(
      500,
      "apply_failed",
      `failed to apply changes: ${message}`,
    ), auditDetailsFromChanges(parsed.changes));
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

function auditDetailsFromMutationBody(body: unknown): {
  operation_summary: string[];
  target_resources: string[];
} {
  const preview = adminChangePreviewFromBody(body);
  if (preview === null) {
    return { operation_summary: [], target_resources: [] };
  }
  return {
    operation_summary: preview.operations.map(auditOperationSummary),
    target_resources: targetResourcesFromOperations(preview.operations),
  };
}

function auditDetailsFromMutationError(err: unknown): {
  operation_summary: string[];
  target_resources: string[];
  error_code: string;
  error_message: string;
} {
  const details = err !== null &&
    (typeof err === "object" || typeof err === "function")
    ? mutationAuditErrorDetails.get(err)
    : undefined;
  return {
    operation_summary: details?.operation_summary ?? [],
    target_resources: details?.target_resources ?? [],
    error_code: errorCodeForAudit(err),
    error_message: errorMessageForAudit(err),
  };
}

function throwWithMutationAuditDetails(
  err: unknown,
  details: AdminAuditMutationDetails,
): never {
  if (err !== null && (typeof err === "object" || typeof err === "function")) {
    mutationAuditErrorDetails.set(err, details);
  }
  throw err;
}

function auditDetailsFromChanges(changes: AdminChange[]): AdminAuditMutationDetails {
  return {
    operation_summary: changes.flatMap(auditChangeSummaries),
    target_resources: targetResourcesFromChanges(changes),
  };
}

function auditChangeSummaries(change: AdminChange): string[] {
  if (change.type === "repo.update") {
    return REPO_PATCH_FIELDS
      .filter((field) => field in change.patch)
      .map((field) => `repo ${change.repo_id}: update ${field}`);
  }
  const prefix = change.scope === "deployment"
    ? "deployment tags"
    : `repo ${change.repo_id!} tags`;
  return change.tag_namespaces
    .map((namespace) => `${prefix}: replace ${namespace.name}`);
}

function targetResourcesFromChanges(changes: AdminChange[]): string[] {
  const targets = new Set<string>();
  for (const change of changes) {
    if (change.type === "repo.update") {
      targets.add(`repo:${change.repo_id}`);
      continue;
    }
    targets.add(change.scope === "deployment" ? "deployment" : `repo:${change.repo_id!}`);
  }
  return [...targets].sort();
}

function adminChangePreviewFromBody(body: unknown): AdminChangePreview | null {
  if (isAdminChangePreview(body)) return body;
  if (body !== null && typeof body === "object") {
    const preview = (body as { preview?: unknown }).preview;
    if (isAdminChangePreview(preview)) return preview;
  }
  return null;
}

function isAdminChangePreview(value: unknown): value is AdminChangePreview {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { operations?: unknown };
  return Array.isArray(candidate.operations) &&
    candidate.operations.every(isAdminChangeOperation);
}

function isAdminChangeOperation(value: unknown): value is AdminChangeOperation {
  if (value === null || typeof value !== "object") return false;
  const op = value as Record<string, unknown>;
  return typeof op.type === "string" &&
    typeof op.scope === "string" &&
    typeof op.target === "string" &&
    (op.field === undefined || typeof op.field === "string");
}

function auditOperationSummary(operation: AdminChangeOperation): string {
  if (operation.type === "repo.update") {
    return operation.field === undefined
      ? `repo ${operation.target}: update repository settings`
      : `repo ${operation.target}: update ${operation.field}`;
  }
  if (operation.type === "tag_namespace.replace") {
    const prefix = operation.scope === "deployment"
      ? "deployment tags"
      : `repo ${operation.target} tags`;
    return operation.field === undefined
      ? `${prefix}: replace tag namespace`
      : `${prefix}: replace ${operation.field}`;
  }
  return `${operation.scope} ${operation.target}: ${operation.type}`;
}

function targetResourcesFromOperations(
  operations: AdminChangeOperation[],
): string[] {
  const targets = new Set<string>();
  for (const operation of operations) {
    if (operation.scope === "deployment") {
      targets.add("deployment");
    } else {
      targets.add(`repo:${operation.target}`);
    }
  }
  return [...targets].sort();
}

function errorCodeForAudit(err: unknown): string {
  if (err instanceof AdminHttpError || err instanceof QuayError) return err.code;
  return "apply_failed";
}

function errorMessageForAudit(err: unknown): string {
  if (err instanceof AdminHttpError || err instanceof QuayError) return err.message;
  return err instanceof Error ? err.message : String(err);
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
  validatePreamblePatch(runtime, change.repo_id, change.patch);
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
    validatePreamblePatch(runtime, change.repo_id, change.patch);
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
  "preamble_worker",
  "preamble_reviewer",
  "ci_ignore_mode",
  "ignored_check_names",
  "ignored_workflow_names",
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

function validatePreamblePatch(
  runtime: AdminApiRuntime,
  repoId: string,
  patch: RepoPatch,
): void {
  const entries = [
    ["worker", "code", patch.preamble_worker],
    ["reviewer", "review", patch.preamble_reviewer],
  ] as const;
  for (const [role, kind, preambleId] of entries) {
    if (preambleId === undefined || preambleId === null) continue;
    try {
      assertPreambleKind(runtime.db, preambleId, kind, `repo ${repoId} ${role}`);
    } catch (err) {
      if (err instanceof QuayError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new QuayError("validation_error", message, {
        repo_id: repoId,
        role,
        preamble_id: preambleId,
      });
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
    ci_policy: ciPolicyFromConfig(runtime.config),
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
    const overrideRepos = preambleId === 0
      ? 0
      : countRepoPreambleOverrides(runtime.db, kind, preambleId);
    return {
      kind,
      title: kind === "review" ? "Reviewer preamble" : "Worker preamble",
      version: preambleId,
      body,
      refs: preambleId === 0 ? 0 : countPreambleRefs(runtime.db, preambleId),
      last_edited: row?.created_at ?? null,
      used_by_repos: repoCount - countReposWithAnyPreambleOverride(runtime.db, kind) + overrideRepos,
      override_repos: overrideRepos,
    };
  });
}

function buildRepoEffectivePreamble(
  runtime: AdminApiRuntime,
  repo: RepoRow,
  role: "worker" | "reviewer",
): AdminRepoEffectivePreamble {
  const kind: PreambleKind = role === "worker" ? "code" : "review";
  const configured =
    role === "worker" ? repo.preamble_worker : repo.preamble_reviewer;
  const row = configured === null
    ? latestPreamble(runtime.db, kind)
    : preambleById(runtime.db, configured);
  const body = row?.body ??
    (kind === "review" ? DEFAULT_REVIEWER_PREAMBLE_BODY : DEFAULT_PREAMBLE_BODY);
  const effectiveId = row?.preamble_id ?? 0;
  return {
    role,
    kind,
    source: configured === null ? "global" : "repo",
    configured_preamble_id: configured,
    effective_preamble_id: effectiveId,
    title: kind === "review" ? "Reviewer preamble" : "Worker preamble",
    body,
    refs: effectiveId === 0 ? 0 : countPreambleRefs(runtime.db, effectiveId),
    last_edited: row?.created_at ?? null,
  };
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

function preambleById(
  db: DB,
  preambleId: number,
): { preamble_id: number; body: string; created_at: string } | null {
  return (
    db
      .query<
        { preamble_id: number; body: string; created_at: string },
        [number]
      >(
        `SELECT preamble_id, body, created_at
           FROM preambles
          WHERE preamble_id = ?`,
      )
      .get(preambleId) ?? null
  );
}

function countPreambleRefs(db: DB, preambleId: number): number {
  return db
    .query<{ n: number }, [number]>(
      "SELECT COUNT(*) AS n FROM attempts WHERE preamble_id = ?",
    )
    .get(preambleId)?.n ?? 0;
}

function countRepoPreambleOverrides(
  db: DB,
  kind: PreambleKind,
  preambleId: number,
): number {
  const column = kind === "review" ? "preamble_reviewer" : "preamble_worker";
  return db
    .query<{ n: number }, [number]>(
      `SELECT COUNT(*) AS n
         FROM repos
        WHERE archived_at IS NULL
          AND ${column} = ?`,
    )
    .get(preambleId)?.n ?? 0;
}

function countReposWithAnyPreambleOverride(db: DB, kind: PreambleKind): number {
  const column = kind === "review" ? "preamble_reviewer" : "preamble_worker";
  return db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n
         FROM repos
        WHERE archived_at IS NULL
          AND ${column} IS NOT NULL`,
    )
    .get()?.n ?? 0;
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
