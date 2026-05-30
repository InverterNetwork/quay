export interface AgentUiContext {
  view: 'mission-control' | 'configuration';
  scope: string;
  urlPath: string;
  capturedAt: string;
  summary: string;
  payload: MissionControlContext | ConfigurationContext;
}

export interface MissionControlContext {
  taskCounts: {
    total: number;
    attention: number;
    running: number;
    prLifecycle: number;
    waiting: number;
    terminal: number;
  };
  filters: {
    repo: string | null;
    lane: string | null;
    sort: string | null;
  };
  visibleTasks: Array<{
    id: string;
    externalRef: string | null;
    repo: string;
    title: string;
    branch: string | null;
    state: string;
    attentionReason: string | null;
    pr: number | null;
    latest: string;
    budget: string;
    agent: string | null;
    model?: string | null;
    updatedAt: string | null;
    authors?: string[];
  }>;
  selectedTaskId?: string | null;
  limits: {
    maxTasks: 50;
    truncatedFields: string[];
  };
}

export interface ConfigurationContext {
  scopeType: 'global' | 'repo';
  repoId: string | null;
  dirtyChanges: Array<{
    scope: string;
    field: string;
    before: string | null;
    after: string | null;
  }>;
  visibleSettings: Array<{
    key: string;
    label: string;
    value: string | null;
    source: string;
  }>;
  effectiveAgents?: {
    worker: string | null;
    reviewer: string | null;
    workerModel?: string | null;
    reviewerModel?: string | null;
  };
  preambles?: Array<{
    id: number;
    kind: 'worker' | 'reviewer';
    title: string;
    source: 'global' | 'repo';
    refs?: number;
    summary?: string;
  }>;
}

export interface AgentContextBuildBase {
  scope: string;
  urlPath: string;
  capturedAt?: string;
}

export function capturedAt(value?: string): string {
  return value ?? new Date().toISOString();
}
