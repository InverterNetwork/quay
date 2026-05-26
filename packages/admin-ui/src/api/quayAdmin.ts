import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AdapterSummary,
  AgentInvocation,
  ConfigFieldSummary,
  GlobalConfigSummary,
  GuidanceTemplate,
  MatrixReadModel,
  MatrixRow,
  PreambleSummary,
  RepoSummary,
  TagNamespace,
} from '../store/data';
import type { AdminChange } from '../store/dirty';

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:9731';
const EXPECTED_API_VERSION = 'v1';

export interface QuayAdminMeta {
  service: 'quay';
  api_version: 'v1';
  quay_version: string;
}

export interface QuayAdminRepo {
  repo_id: string;
  repo_url: string;
  base_branch: string;
  package_manager: string;
  install_cmd: string;
  test_cmd: string | null;
  ci_workflow_name: string | null;
  contribution_guide_path: string | null;
  agent_worker: string | null;
  agent_reviewer: string | null;
  model_worker: string | null;
  model_reviewer: string | null;
  preamble_worker: number | null;
  preamble_reviewer: number | null;
  archived_at: string | null;
  created_at: string;
}

export interface QuayAdminRepoDetail extends QuayAdminRepo {
  revision: string;
  active_task_count: number;
  effective_preambles: {
    worker: QuayAdminRepoEffectivePreamble;
    reviewer: QuayAdminRepoEffectivePreamble;
  };
  tag_namespaces: QuayAdminTagNamespace[];
  inherited_tag_namespaces: QuayAdminTagNamespace[];
}

interface QuayAdminRepoEffectivePreamble {
  role: 'worker' | 'reviewer';
  kind: 'code' | 'review';
  source: 'repo' | 'global';
  configured_preamble_id: number | null;
  effective_preamble_id: number;
  title: string;
  body: string;
  refs: number;
  last_edited: string | null;
}

interface QuayAdminField {
  key: string;
  label: string;
  value: string | null;
  source: 'config' | 'database' | 'default' | 'derived';
  unit?: string;
}

interface QuayAdminAdapterField {
  label: string;
  value: string;
  dot_tone?: 'good' | 'warn';
  mono?: boolean;
}

interface QuayAdminAdapter {
  name: string;
  title: string;
  enabled: boolean;
  status: 'disabled' | 'ready' | 'missing_env';
  status_tone: 'good' | 'warn' | 'neutral';
  status_text: string;
  fields: QuayAdminAdapterField[];
}

interface QuayAdminAgentDefaults {
  worker: string;
  reviewer: string;
  worker_model: string | null;
  reviewer_model: string | null;
}

interface QuayAdminAgentInvocation {
  name: string;
  roles: Array<'worker' | 'reviewer'>;
  commands: Partial<Record<'worker' | 'reviewer', string>>;
  capabilities: string[];
  used_by_repos: number;
  used_by_tasks: number;
}

interface QuayAdminPreamble {
  kind: 'code' | 'review';
  title: string;
  version: number;
  body: string;
  refs: number;
  last_edited: string | null;
  used_by_repos: number;
  override_repos: number;
}

interface QuayAdminGuidanceTemplate {
  reason: string;
  body: string;
  version: number;
  refs: number;
}

interface QuayAdminTagNamespace {
  name: string;
  required: boolean;
  values: string[];
  inherited_by?: number;
  extended_by?: number;
}

interface QuayAdminGlobal {
  revision: string;
  config_path: string | null;
  data_dir: string;
  paths: {
    data_dir: string;
    repos_root: string;
    worktree_root: string;
    artifacts_root: string;
  };
  operations: {
    concurrency: QuayAdminField[];
    budgets: QuayAdminField[];
    live_worker_thresholds: QuayAdminField[];
    claims: QuayAdminField[];
    paths: QuayAdminField[];
  };
  adapters: QuayAdminAdapter[];
  agents: {
    defaults: QuayAdminAgentDefaults;
    invocations: QuayAdminAgentInvocation[];
  };
  preambles: QuayAdminPreamble[];
  retry_templates: QuayAdminGuidanceTemplate[];
  tag_namespaces: QuayAdminTagNamespace[];
}

interface QuayAdminMatrixRow {
  group: string;
  label: string;
  key: string;
  default_value: string | null;
  values: Record<string, string | null>;
}

interface QuayAdminMatrix {
  revision: string;
  rows: QuayAdminMatrixRow[];
}

interface QuayAdminErrorBody {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface QuayAdminChangeOperation {
  op_id: string;
  type: string;
  scope: string;
  target: string;
  field?: string;
  before: unknown;
  after: unknown;
  summary: string;
}

export interface QuayAdminChangePreview {
  base_revision: string;
  current_revision: string;
  valid: true;
  summary: string[];
  operations: QuayAdminChangeOperation[];
}

export interface QuayAdminApplyResponse {
  previous_revision: string;
  revision: string;
  preview: QuayAdminChangePreview;
  read_model: unknown;
}

export class QuayAdminRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    message: string,
    status: number,
    code: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'QuayAdminRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface AdminReadModel {
  baseUrl: string;
  error: string | null;
  loading: boolean;
  global: GlobalConfigSummary | null;
  matrix: MatrixReadModel | null;
  meta: QuayAdminMeta | null;
  repos: RepoSummary[];
  revision: string | null;
  reload: () => void;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function getQuayAdminBaseUrl(): string {
  const configured =
    window.__QUAY_API_BASE_URL__ ??
    import.meta.env.VITE_QUAY_API_BASE_URL ??
    DEFAULT_API_BASE_URL;
  return trimTrailingSlash(configured);
}

async function readJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(`${getQuayAdminBaseUrl()}${path}`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const errorBody = body as Partial<QuayAdminErrorBody> | null;
    throw new QuayAdminRequestError(
      errorBody?.message ?? `Quay Admin API request failed with HTTP ${response.status}`,
      response.status,
      errorBody?.error ?? 'request_failed',
      errorBody?.details,
    );
  }
  return body as T;
}

async function writeJson<T>(path: string, payload: unknown, signal: AbortSignal): Promise<T> {
  const response = await fetch(`${getQuayAdminBaseUrl()}${path}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const errorBody = body as Partial<QuayAdminErrorBody> | null;
    throw new QuayAdminRequestError(
      errorBody?.message ?? `Quay Admin API request failed with HTTP ${response.status}`,
      response.status,
      errorBody?.error ?? 'request_failed',
      errorBody?.details,
    );
  }
  return body as T;
}

export function fetchMeta(signal: AbortSignal): Promise<QuayAdminMeta> {
  return readJson<QuayAdminMeta>('/v1/meta', signal);
}

export function fetchRepos(signal: AbortSignal): Promise<QuayAdminRepo[]> {
  return readJson<QuayAdminRepo[]>('/v1/repos', signal);
}

export function fetchRepoDetail(repoId: string, signal: AbortSignal): Promise<QuayAdminRepoDetail> {
  return readJson<QuayAdminRepoDetail>(`/v1/repos/${encodeURIComponent(repoId)}`, signal);
}

export function fetchGlobal(signal: AbortSignal): Promise<QuayAdminGlobal> {
  return readJson<QuayAdminGlobal>('/v1/global', signal);
}

export function fetchMatrix(signal: AbortSignal): Promise<QuayAdminMatrix> {
  return readJson<QuayAdminMatrix>('/v1/matrix', signal);
}

export function previewChanges(
  baseRevision: string,
  changes: AdminChange[],
  signal: AbortSignal,
): Promise<QuayAdminChangePreview> {
  return writeJson<QuayAdminChangePreview>('/v1/changes/preview', {
    base_revision: baseRevision,
    changes,
  }, signal);
}

export function applyChanges(
  baseRevision: string,
  changes: AdminChange[],
  signal: AbortSignal,
): Promise<QuayAdminApplyResponse> {
  return writeJson<QuayAdminApplyResponse>('/v1/changes/apply', {
    base_revision: baseRevision,
    changes,
  }, signal);
}

export function useQuayAdminReadModel(): AdminReadModel {
  const baseUrl = useMemo(getQuayAdminBaseUrl, []);
  const [requestId, setRequestId] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [global, setGlobal] = useState<GlobalConfigSummary | null>(null);
  const [matrix, setMatrix] = useState<MatrixReadModel | null>(null);
  const [meta, setMeta] = useState<QuayAdminMeta | null>(null);
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [revision, setRevision] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    Promise.all([
      fetchMeta(controller.signal),
      fetchRepos(controller.signal),
      fetchGlobal(controller.signal),
      fetchMatrix(controller.signal),
    ])
      .then(async ([nextMeta, nextRepos, nextGlobal, nextMatrix]) => {
        if (nextMeta.service !== 'quay' || nextMeta.api_version !== EXPECTED_API_VERSION) {
          throw new Error(`Unsupported Quay Admin API ${nextMeta.service}/${nextMeta.api_version}`);
        }
        const repoDetails = await Promise.all(
          nextRepos.map((repo) => fetchRepoDetail(repo.repo_id, controller.signal)),
        );
        setMeta(nextMeta);
        setGlobal(toGlobalSummary(nextGlobal));
        setMatrix(toMatrixReadModel(nextMatrix));
        setRepos(repoDetails.map(toRepoSummary));
        setRevision(nextGlobal.revision);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setMeta(null);
        setGlobal(null);
        setMatrix(null);
        setRepos([]);
        setRevision(null);
        setError(errorMessage(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [requestId]);

  const reload = useCallback(() => setRequestId((id) => id + 1), []);

  return { baseUrl, error, global, loading, matrix, meta, repos, revision, reload };
}

function toRepoSummary(repo: QuayAdminRepoDetail): RepoSummary {
  const overrideFields = [
    repo.agent_worker,
    repo.agent_reviewer,
    repo.model_worker,
    repo.model_reviewer,
    repo.preamble_worker,
    repo.preamble_reviewer,
  ].filter(Boolean);

  return {
    revision: repo.revision,
    id: repo.repo_id,
    active: repo.active_task_count,
    agent: repo.agent_worker ?? 'inherits',
    overrides: overrideFields.length,
    url: repo.repo_url,
    baseBranch: repo.base_branch,
    createdAt: repo.created_at,
    packageManager: repo.package_manager,
    installCmd: repo.install_cmd,
    testCmd: repo.test_cmd,
    ciWorkflowName: repo.ci_workflow_name,
    contributionGuidePath: repo.contribution_guide_path,
    agentWorker: repo.agent_worker,
    agentReviewer: repo.agent_reviewer,
    modelWorker: repo.model_worker,
    modelReviewer: repo.model_reviewer,
    preambleWorker: repo.preamble_worker,
    preambleReviewer: repo.preamble_reviewer,
    effectivePreambles: {
      worker: toRepoEffectivePreamble(repo.effective_preambles.worker),
      reviewer: toRepoEffectivePreamble(repo.effective_preambles.reviewer),
    },
    tagNamespaces: repo.tag_namespaces.map(toTagNamespace),
    inheritedTagNamespaces: repo.inherited_tag_namespaces.map(toTagNamespace),
  };
}

function toRepoEffectivePreamble(preamble: QuayAdminRepoEffectivePreamble) {
  return {
    role: preamble.role,
    kind: preamble.kind,
    source: preamble.source,
    configuredPreambleId: preamble.configured_preamble_id,
    effectivePreambleId: preamble.effective_preamble_id,
    title: preamble.title,
    body: preamble.body,
    refs: preamble.refs,
    lastEdited: preamble.last_edited,
  };
}

function toGlobalSummary(global: QuayAdminGlobal): GlobalConfigSummary {
  return {
    revision: global.revision,
    configPath: global.config_path,
    dataDir: global.data_dir,
    paths: {
      dataDir: global.paths.data_dir,
      reposRoot: global.paths.repos_root,
      worktreeRoot: global.paths.worktree_root,
      artifactsRoot: global.paths.artifacts_root,
    },
    operations: {
      concurrency: global.operations.concurrency.map(toFieldSummary),
      budgets: global.operations.budgets.map(toFieldSummary),
      liveWorkerThresholds: global.operations.live_worker_thresholds.map(toFieldSummary),
      claims: global.operations.claims.map(toFieldSummary),
      paths: global.operations.paths.map(toFieldSummary),
    },
    adapters: global.adapters.map(toAdapterSummary),
    agents: {
      defaults: {
        worker: global.agents.defaults.worker,
        reviewer: global.agents.defaults.reviewer,
        workerModel: global.agents.defaults.worker_model,
        reviewerModel: global.agents.defaults.reviewer_model,
      },
      invocations: global.agents.invocations.map(toAgentInvocation),
    },
    preambles: global.preambles.map(toPreambleSummary),
    retryTemplates: global.retry_templates.map(toGuidanceTemplate),
    tagNamespaces: global.tag_namespaces.map(toTagNamespace),
  };
}

function toFieldSummary(field: QuayAdminField): ConfigFieldSummary {
  return {
    key: field.key,
    label: field.label,
    value: field.value,
    source: field.source,
    unit: field.unit,
  };
}

function toAdapterSummary(adapter: QuayAdminAdapter): AdapterSummary {
  return {
    name: adapter.name,
    title: adapter.title,
    enabled: adapter.enabled,
    status: adapter.status,
    statusTone: adapter.status_tone,
    statusText: adapter.status_text,
    fields: adapter.fields.map((field) => ({
      label: field.label,
      value: field.value,
      dotTone: field.dot_tone,
      mono: field.mono,
    })),
  };
}

function toAgentInvocation(invocation: QuayAdminAgentInvocation): AgentInvocation {
  return {
    name: invocation.name,
    roles: invocation.roles,
    commands: invocation.commands,
    capabilities: invocation.capabilities,
    usedByRepos: invocation.used_by_repos,
    usedByTasks: invocation.used_by_tasks,
  };
}

function toPreambleSummary(preamble: QuayAdminPreamble): PreambleSummary {
  return {
    kind: preamble.kind,
    title: preamble.title,
    version: preamble.version,
    body: preamble.body,
    refs: preamble.refs,
    lastEdited: preamble.last_edited,
    usedByRepos: preamble.used_by_repos,
    overrideRepos: preamble.override_repos,
  };
}

function toGuidanceTemplate(template: QuayAdminGuidanceTemplate): GuidanceTemplate {
  return {
    reason: template.reason,
    body: template.body,
    version: template.version,
    refs: template.refs,
  };
}

function toTagNamespace(namespace: QuayAdminTagNamespace): TagNamespace {
  return {
    name: namespace.name,
    required: namespace.required,
    values: namespace.values,
    inheritedBy: namespace.inherited_by,
    extendedBy: namespace.extended_by,
  };
}

function toMatrixReadModel(matrix: QuayAdminMatrix): MatrixReadModel {
  return { revision: matrix.revision, rows: matrix.rows.map(toMatrixRow) };
}

function toMatrixRow(row: QuayAdminMatrixRow): MatrixRow {
  return {
    group: row.group,
    label: row.label,
    key: row.key,
    def: row.default_value,
    vals: row.values,
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof TypeError) return 'Cannot reach the Quay Admin API.';
  if (err instanceof Error) return err.message;
  return 'Quay Admin API request failed.';
}
