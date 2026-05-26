export interface RepoSummary {
  revision: string;
  id: string;
  active?: number;
  agent: string;
  overrides: number;
  archived?: boolean;
  url: string;
  barePath?: string;
  baseBranch: string;
  createdAt: string;
  packageManager?: string;
  installCmd?: string;
  testCmd?: string | null;
  ciWorkflowName?: string | null;
  contributionGuidePath?: string | null;
  agentWorker?: string | null;
  agentReviewer?: string | null;
  modelWorker?: string | null;
  modelReviewer?: string | null;
  preambleWorker?: number | null;
  preambleReviewer?: number | null;
  effectivePreambles: {
    worker: RepoEffectivePreamble;
    reviewer: RepoEffectivePreamble;
  };
  tagNamespaces: TagNamespace[];
  inheritedTagNamespaces: TagNamespace[];
}

export interface RepoEffectivePreamble {
  role: 'worker' | 'reviewer';
  kind: 'code' | 'review';
  source: 'repo' | 'global';
  configuredPreambleId: number | null;
  effectivePreambleId: number;
  title: string;
  body: string;
  refs: number;
  lastEdited: string | null;
}

export interface AgentInvocation {
  name: string;
  roles: Array<'worker' | 'reviewer'>;
  commands: Partial<Record<'worker' | 'reviewer', string>>;
  capabilities: string[];
  usedByRepos: number;
  usedByTasks: number;
}

export interface PreambleSummary {
  kind: 'code' | 'review';
  title: string;
  version: number;
  body: string;
  refs: number;
  lastEdited: string | null;
  usedByRepos: number;
  overrideRepos: number;
}

export interface GuidanceTemplate {
  reason: string;
  body: string;
  version: number;
  refs: number;
}

export interface TagNamespace {
  name: string;
  required: boolean;
  values: string[];
  inheritedBy?: number;
  extendedBy?: number;
}

export interface ConfigFieldSummary {
  key: string;
  label: string;
  value: string | null;
  source: 'config' | 'database' | 'default' | 'derived';
  unit?: string;
}

export interface AdapterFieldSummary {
  label: string;
  value: string;
  dotTone?: 'good' | 'warn';
  mono?: boolean;
}

export interface AdapterSummary {
  name: string;
  title: string;
  enabled: boolean;
  status: 'disabled' | 'ready' | 'missing_env';
  statusTone: 'good' | 'warn' | 'neutral';
  statusText: string;
  fields: AdapterFieldSummary[];
}

export interface AgentDefaults {
  worker: string;
  reviewer: string;
  workerModel: string | null;
  reviewerModel: string | null;
}

export interface GlobalConfigSummary {
  revision: string;
  configPath: string | null;
  dataDir: string;
  paths: {
    dataDir: string;
    reposRoot: string;
    worktreeRoot: string;
    artifactsRoot: string;
  };
  operations: {
    concurrency: ConfigFieldSummary[];
    budgets: ConfigFieldSummary[];
    liveWorkerThresholds: ConfigFieldSummary[];
    claims: ConfigFieldSummary[];
    paths: ConfigFieldSummary[];
  };
  adapters: AdapterSummary[];
  agents: {
    defaults: AgentDefaults;
    invocations: AgentInvocation[];
  };
  preambles: PreambleSummary[];
  retryTemplates: GuidanceTemplate[];
  tagNamespaces: TagNamespace[];
}

export interface MatrixRow {
  group: string;
  label: string;
  key: string;
  def: string | null;
  vals: Record<string, string | null>;
}

export interface MatrixReadModel {
  revision: string;
  rows: MatrixRow[];
}
