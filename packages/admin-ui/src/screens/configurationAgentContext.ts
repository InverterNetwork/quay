import { capturedAt, type AgentContextBuildBase, type AgentUiContext, type ConfigurationContext } from '../agent/agentContext';
import type { ConfigFieldSummary, GlobalConfigSummary, RepoEffectivePreamble, RepoSummary } from '../store/data';
import type { ChangeEntry } from '../store/dirty';

type ConfigurationPreamble = NonNullable<ConfigurationContext['preambles']>[number];

interface BuildConfigurationAgentContextInput extends AgentContextBuildBase {
  global: GlobalConfigSummary | null;
  repo: RepoSummary | null;
  changes: ChangeEntry[];
}

export function buildConfigurationAgentContext({
  scope,
  urlPath,
  capturedAt: capturedAtInput,
  global,
  repo,
  changes,
}: BuildConfigurationAgentContextInput): AgentUiContext {
  const scopeType = repo ? 'repo' : 'global';
  const activeChanges = changes.filter((change) => (repo ? change.scope === repo.id : change.scope === 'global'));
  const dirtyChanges = activeChanges.map((change) => ({
    scope: change.scope,
    field: change.label,
    before: nullableDisplay(change.before),
    after: nullableDisplay(change.after),
  }));
  const payload: ConfigurationContext = {
    scopeType,
    repoId: repo?.id ?? null,
    dirtyChanges,
    visibleSettings: repo && global ? repoVisibleSettings(repo, global, changes) : globalVisibleSettings(global),
    effectiveAgents: repo && global ? repoEffectiveAgents(repo, global, changes) : globalEffectiveAgents(global),
    preambles: repo && global ? repoPreambles(repo, global, changes) : globalPreambles(global),
  };
  const dirtyText = dirtyChanges.length === 0 ? 'no unsaved changes' : `${dirtyChanges.length} unsaved change${dirtyChanges.length === 1 ? '' : 's'}`;

  return {
    view: 'configuration',
    scope,
    urlPath,
    capturedAt: capturedAt(capturedAtInput),
    summary: repo
      ? `Configuration: repo ${repo.id}, ${dirtyText}.`
      : `Configuration: global defaults for ${global ? global.agents.invocations.length : 0} agent invocation${global?.agents.invocations.length === 1 ? '' : 's'}, ${dirtyText}.`,
    payload,
  };
}

function globalVisibleSettings(global: GlobalConfigSummary | null): ConfigurationContext['visibleSettings'] {
  if (!global) return [];
  return [
    ...fieldGroup('operations.concurrency', global.operations.concurrency),
    ...fieldGroup('operations.budgets', global.operations.budgets),
    ...fieldGroup('operations.liveWorkerThresholds', global.operations.liveWorkerThresholds),
    ...fieldGroup('operations.claims', global.operations.claims),
    ...fieldGroup('operations.paths', global.operations.paths),
    {
      key: 'ci_policy.ignored_check_names',
      label: 'IGNORED_CHECK_NAMES',
      value: formatList(global.ciPolicy.ignoredCheckNames),
      source: 'global',
    },
    {
      key: 'ci_policy.ignored_workflow_names',
      label: 'IGNORED_WORKFLOW_NAMES',
      value: formatList(global.ciPolicy.ignoredWorkflowNames),
      source: 'global',
    },
    ...global.adapters.map((adapter) => ({
      key: `adapter.${adapter.name}.status`,
      label: `${adapter.title} status`,
      value: adapter.statusText,
      source: adapter.enabled ? 'adapter' : 'disabled',
    })),
    {
      key: 'agents.defaults.worker',
      label: 'DEFAULT_WORKER_AGENT',
      value: global.agents.defaults.worker,
      source: 'global',
    },
    {
      key: 'agents.defaults.reviewer',
      label: 'DEFAULT_REVIEWER_AGENT',
      value: global.agents.defaults.reviewer,
      source: 'global',
    },
    {
      key: 'agents.defaults.worker_model',
      label: 'DEFAULT_WORKER_MODEL',
      value: global.agents.defaults.workerModel,
      source: 'global',
    },
    {
      key: 'agents.defaults.reviewer_model',
      label: 'DEFAULT_REVIEWER_MODEL',
      value: global.agents.defaults.reviewerModel,
      source: 'global',
    },
  ];
}

function repoVisibleSettings(repo: RepoSummary, global: GlobalConfigSummary, changes: ChangeEntry[]): ConfigurationContext['visibleSettings'] {
  const value = repoPendingValue(repo, changes);
  return [
    { key: 'repo_url', label: 'REPO_URL', value: value('repo_url', repo.url), source: 'repo-only' },
    { key: 'repo_id', label: 'REPO_ID', value: repo.id, source: 'repo-only' },
    { key: 'base_branch', label: 'BASE_BRANCH', value: value('base_branch', repo.baseBranch), source: 'repo-only' },
    { key: 'package_manager', label: 'PACKAGE_MANAGER', value: value('package_manager', repo.packageManager ?? ''), source: 'repo-only' },
    { key: 'test_cmd', label: 'TEST_CMD', value: value('test_cmd', repo.testCmd ?? null), source: 'repo-only' },
    { key: 'install_cmd', label: 'INSTALL_CMD', value: value('install_cmd', repo.installCmd ?? ''), source: 'repo-only' },
    { key: 'ci_workflow_name', label: 'CI_WORKFLOW', value: value('ci_workflow_name', repo.ciWorkflowName ?? null), source: 'repo-only' },
    {
      key: 'contribution_guide_path',
      label: 'CONTRIBUTION_GUIDE',
      value: value('contribution_guide_path', repo.contributionGuidePath ?? null),
      source: 'repo-only',
    },
    { key: 'ci_policy.ignore_mode', label: 'IGNORE_MODE', value: repo.ciPolicy.ignoreMode, source: 'repo-only' },
    {
      key: 'ci_policy.effective_ignored_check_names',
      label: 'EFFECTIVE_CHECK_NAMES',
      value: formatList(repo.ciPolicy.effectiveIgnoredCheckNames),
      source: 'derived',
    },
    {
      key: 'ci_policy.effective_ignored_workflow_names',
      label: 'EFFECTIVE_WORKFLOW_NAMES',
      value: formatList(repo.ciPolicy.effectiveIgnoredWorkflowNames),
      source: 'derived',
    },
    {
      key: 'agent_worker',
      label: 'WORKER_AGENT',
      value: value('agent_worker', repo.agentWorker ?? null) ?? global.agents.defaults.worker,
      source: value('agent_worker', repo.agentWorker ?? null) ? 'override' : 'inherits',
    },
    {
      key: 'model_worker',
      label: 'WORKER_MODEL',
      value: value('model_worker', repo.modelWorker ?? null) ?? global.agents.defaults.workerModel,
      source: value('model_worker', repo.modelWorker ?? null) ? 'override' : 'inherits',
    },
    {
      key: 'agent_reviewer',
      label: 'REVIEWER_AGENT',
      value: value('agent_reviewer', repo.agentReviewer ?? null) ?? global.agents.defaults.reviewer,
      source: value('agent_reviewer', repo.agentReviewer ?? null) ? 'override' : 'inherits',
    },
    {
      key: 'model_reviewer',
      label: 'REVIEWER_MODEL',
      value: value('model_reviewer', repo.modelReviewer ?? null) ?? global.agents.defaults.reviewerModel,
      source: value('model_reviewer', repo.modelReviewer ?? null) ? 'override' : 'inherits',
    },
    {
      key: 'preamble_worker',
      label: 'WORKER_PREAMBLE_ID',
      value: value('preamble_worker', idString(repo.preambleWorker)),
      source: value('preamble_worker', idString(repo.preambleWorker)) ? 'override' : 'inherits',
    },
    {
      key: 'preamble_reviewer',
      label: 'REVIEWER_PREAMBLE_ID',
      value: value('preamble_reviewer', idString(repo.preambleReviewer)),
      source: value('preamble_reviewer', idString(repo.preambleReviewer)) ? 'override' : 'inherits',
    },
  ];
}

function fieldGroup(prefix: string, fields: ConfigFieldSummary[]): ConfigurationContext['visibleSettings'] {
  return fields.map((field) => ({
    key: `${prefix}.${field.key}`,
    label: field.label,
    value: field.value,
    source: field.source,
  }));
}

function globalEffectiveAgents(global: GlobalConfigSummary | null): ConfigurationContext['effectiveAgents'] {
  if (!global) return undefined;
  return {
    worker: global.agents.defaults.worker,
    reviewer: global.agents.defaults.reviewer,
    workerModel: global.agents.defaults.workerModel,
    reviewerModel: global.agents.defaults.reviewerModel,
  };
}

function repoEffectiveAgents(repo: RepoSummary, global: GlobalConfigSummary, changes: ChangeEntry[]): ConfigurationContext['effectiveAgents'] {
  const value = repoPendingValue(repo, changes);
  return {
    worker: value('agent_worker', repo.agentWorker ?? null) ?? global.agents.defaults.worker,
    reviewer: value('agent_reviewer', repo.agentReviewer ?? null) ?? global.agents.defaults.reviewer,
    workerModel: value('model_worker', repo.modelWorker ?? null) ?? global.agents.defaults.workerModel,
    reviewerModel: value('model_reviewer', repo.modelReviewer ?? null) ?? global.agents.defaults.reviewerModel,
  };
}

function globalPreambles(global: GlobalConfigSummary | null): ConfigurationContext['preambles'] {
  if (!global) return undefined;
  return global.preambles.map((preamble) => ({
    id: preamble.version,
    kind: preamble.kind === 'code' ? 'worker' : 'reviewer',
    title: preamble.title,
    source: 'global',
    refs: preamble.refs,
    summary: `v${preamble.version} used by ${preamble.usedByRepos} repo${preamble.usedByRepos === 1 ? '' : 's'}`,
  }));
}

function repoPreambles(repo: RepoSummary, global: GlobalConfigSummary, changes: ChangeEntry[]): ConfigurationContext['preambles'] {
  const value = repoPendingValue(repo, changes);
  return [
    repoPreamble('worker', repo.effectivePreambles.worker, global, value('preamble_worker', idString(repo.preambleWorker))),
    repoPreamble('reviewer', repo.effectivePreambles.reviewer, global, value('preamble_reviewer', idString(repo.preambleReviewer))),
  ];
}

function repoPreamble(
  role: 'worker' | 'reviewer',
  preamble: RepoEffectivePreamble,
  global: GlobalConfigSummary,
  pendingId: string | null,
): ConfigurationPreamble {
  if (pendingId !== idString(preamble.configuredPreambleId)) {
    if (pendingId === null) {
      const inherited = global.preambles.find((item) => item.kind === (role === 'worker' ? 'code' : 'review')) ?? null;
      return {
        id: inherited?.version ?? preamble.effectivePreambleId,
        kind: role,
        title: inherited?.title ?? preamble.title,
        source: 'global',
        refs: inherited?.refs ?? preamble.refs,
        summary: 'pending inherit',
      };
    }

    const pending = preambleById(global, pendingId);
    return {
      id: Number(pendingId),
      kind: role,
      title: pending?.title ?? `Preamble ${pendingId}`,
      source: 'repo',
      refs: pending?.refs,
      summary: pending ? `pending override ${pendingId}` : `pending override ${pendingId} (metadata not loaded)`,
    };
  }

  return {
    id: preamble.effectivePreambleId,
    kind: role,
    title: preamble.title,
    source: preamble.source,
    refs: preamble.refs,
    summary: preamble.configuredPreambleId === null ? 'inherited' : `override ${preamble.configuredPreambleId}`,
  };
}

function preambleById(global: GlobalConfigSummary, id: string | null) {
  if (id === null) return null;
  const numericId = Number(id);
  if (!Number.isFinite(numericId)) return null;
  return global.preambles.find((preamble) => preamble.version === numericId) ?? null;
}

function repoPendingValue(repo: RepoSummary, changes: ChangeEntry[]) {
  return (field: string, fallback: string | null): string | null => {
    const entry = changes.find((change) => change.id === `repo:${repo.id}:${field}`);
    if (entry?.change.type !== 'repo.update') return fallback;
    const pending = entry.change.patch[field as keyof typeof entry.change.patch];
    if (typeof pending === 'number') return String(pending);
    if (typeof pending === 'boolean') return pending ? 'on' : 'off';
    return pending === undefined ? fallback : pending;
  };
}

function nullableDisplay(value: string): string | null {
  return value === 'not configured' ? null : value;
}

function formatList(values: string[]): string | null {
  return values.length === 0 ? null : values.join(', ');
}

function idString(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}
