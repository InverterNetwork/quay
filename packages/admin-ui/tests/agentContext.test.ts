import { expect, test } from 'bun:test';
import { buildMissionControlAgentContext } from '../src/mission-control/agentContext';
import { buildConfigurationAgentContext } from '../src/screens/configurationAgentContext';
import type { MissionControlTask } from '../src/mission-control/taskState';
import type { GlobalConfigSummary, RepoSummary } from '../src/store/data';
import type { ChangeEntry } from '../src/store/dirty';

const capturedAt = '2026-05-30T09:00:00.000Z';

test('mission control context summarizes lane counts and caps visible tasks', () => {
  const tasks = Array.from({ length: 55 }, (_, index): MissionControlTask => ({
    id: `task-${index}`,
    ext: `BRIX-${index}`,
    repo: index % 2 === 0 ? 'quay' : 'brix',
    title: `Task ${index}`,
    branch: index % 3 === 0 ? 'feature/demo' : '—',
    state: index === 0 ? 'worktree_error' : index === 1 ? 'running' : index === 2 ? 'pr-open' : 'queued',
    pr: index === 2 ? 42 : null,
    budget: index % 5,
    total: 5,
    latest: 'latest event',
    agent: index % 4 === 0 ? '—' : 'hermes',
    age: '1m',
    updatedAt: capturedAt,
    authors: ['Mira Tonio'],
  }));

  const context = buildMissionControlAgentContext({
    scope: 'prod',
    urlPath: '/mission-control',
    capturedAt,
    tasks,
  });

  expect(context.view).toBe('mission-control');
  expect(context.payload.taskCounts).toMatchObject({ total: 55, attention: 1, running: 1, prLifecycle: 1 });
  expect(context.payload.visibleTasks).toHaveLength(50);
  expect(context.payload.limits).toEqual({ maxTasks: 50, truncatedFields: ['visibleTasks'] });
  expect(context.payload.visibleTasks[0]).toMatchObject({
    id: 'task-0',
    externalRef: 'BRIX-0',
    branch: 'feature/demo',
    attentionReason: 'worktree_error',
    agent: null,
  });
});

test('configuration context captures repo scope, dirty changes, effective agents, and preambles', () => {
  const global = makeGlobal();
  const repo = makeRepo();
  const changes: ChangeEntry[] = [
    {
      id: 'repo:quay:model_worker',
      scope: 'quay',
      label: 'quay model_worker',
      before: 'not configured',
      after: 'claude-sonnet-4',
      change: {
        type: 'repo.update',
        repo_id: 'quay',
        patch: { model_worker: 'claude-sonnet-4' },
      },
    },
    {
      id: 'repo:brix:model_worker',
      scope: 'brix',
      label: 'brix model_worker',
      before: 'not configured',
      after: 'claude-sonnet-4',
      change: {
        type: 'repo.update',
        repo_id: 'brix',
        patch: { model_worker: 'claude-sonnet-4' },
      },
    },
  ];

  const context = buildConfigurationAgentContext({
    scope: 'quay',
    urlPath: '/configuration/quay/',
    capturedAt,
    global,
    repo,
    changes,
  });

  expect(context.view).toBe('configuration');
  expect(context.payload.scopeType).toBe('repo');
  expect(context.payload.repoId).toBe('quay');
  expect(context.payload.dirtyChanges).toEqual([{ scope: 'quay', field: 'quay model_worker', before: null, after: 'claude-sonnet-4' }]);
  expect(context.payload.effectiveAgents).toMatchObject({
    worker: 'hermes-worker',
    reviewer: 'hermes-reviewer',
    workerModel: 'claude-sonnet-4',
  });
  expect(context.payload.visibleSettings.find((setting) => setting.key === 'model_worker')).toMatchObject({
    value: 'claude-sonnet-4',
    source: 'override',
  });
  expect(context.payload.preambles).toEqual([
    { id: 7, kind: 'worker', title: 'Worker default', source: 'global', refs: 3, summary: 'inherited' },
    { id: 8, kind: 'reviewer', title: 'Reviewer override', source: 'repo', refs: 2, summary: 'override 99' },
  ]);
});

test('configuration context reflects pending preamble edits in metadata', () => {
  const global = makeGlobal();
  const repo = makeRepo();
  const changes: ChangeEntry[] = [
    {
      id: 'repo:quay:preamble_worker',
      scope: 'quay',
      label: 'quay preamble_worker',
      before: 'not configured',
      after: '10',
      change: {
        type: 'repo.update',
        repo_id: 'quay',
        patch: { preamble_worker: 10 },
      },
    },
  ];

  const context = buildConfigurationAgentContext({
    scope: 'quay',
    urlPath: '/configuration/quay/',
    capturedAt,
    global,
    repo,
    changes,
  });

  expect(context.payload.visibleSettings.find((setting) => setting.key === 'preamble_worker')).toMatchObject({
    value: '10',
    source: 'override',
  });
  expect(context.payload.preambles?.[0]).toEqual({
    id: 10,
    kind: 'worker',
    title: 'Worker alternate',
    source: 'repo',
    refs: 4,
    summary: 'pending override 10',
  });
});

test('configuration context resolves cleared preamble overrides to inherited global metadata', () => {
  const global = makeGlobal();
  const repo = makeRepo();
  const changes: ChangeEntry[] = [
    {
      id: 'repo:quay:preamble_reviewer',
      scope: 'quay',
      label: 'quay preamble_reviewer',
      before: '99',
      after: 'not configured',
      change: {
        type: 'repo.update',
        repo_id: 'quay',
        patch: { preamble_reviewer: null },
      },
    },
  ];

  const context = buildConfigurationAgentContext({
    scope: 'quay',
    urlPath: '/configuration/quay/',
    capturedAt,
    global,
    repo,
    changes,
  });

  expect(context.payload.visibleSettings.find((setting) => setting.key === 'preamble_reviewer')).toMatchObject({
    value: null,
    source: 'inherits',
  });
  expect(context.payload.preambles?.[1]).toEqual({
    id: 11,
    kind: 'reviewer',
    title: 'Reviewer default',
    source: 'global',
    refs: 5,
    summary: 'pending inherit',
  });
});

function makeGlobal(): GlobalConfigSummary {
  return {
    revision: 'rev-1',
    configPath: '/tmp/quay.toml',
    dataDir: '/tmp/quay',
    paths: { dataDir: '/tmp/quay', reposRoot: '/tmp/repos', worktreeRoot: '/tmp/worktrees', artifactsRoot: '/tmp/artifacts' },
    operations: {
      concurrency: [{ key: 'max_workers', label: 'MAX_WORKERS', value: '8', source: 'config' }],
      budgets: [],
      liveWorkerThresholds: [],
      claims: [],
      paths: [],
    },
    ciPolicy: { ignoredCheckNames: [], ignoredWorkflowNames: [] },
    adapters: [],
    agents: {
      defaults: {
        worker: 'hermes-worker',
        reviewer: 'hermes-reviewer',
        workerModel: 'claude-sonnet-3.7',
        reviewerModel: 'claude-sonnet-3.7',
      },
      invocations: [],
    },
    preambles: [
      { kind: 'code', title: 'Worker default', version: 7, body: 'hidden', refs: 3, lastEdited: null, usedByRepos: 1, overrideRepos: 0 },
      { kind: 'code', title: 'Worker alternate', version: 10, body: 'hidden', refs: 4, lastEdited: null, usedByRepos: 0, overrideRepos: 0 },
      { kind: 'review', title: 'Reviewer default', version: 11, body: 'hidden', refs: 5, lastEdited: null, usedByRepos: 1, overrideRepos: 0 },
    ],
    retryTemplates: [],
    tagNamespaces: [],
  };
}

function makeRepo(): RepoSummary {
  return {
    revision: 'rev-1',
    id: 'quay',
    active: 2,
    agent: 'inherits',
    overrides: 1,
    url: 'git@github.com:InverterNetwork/quay.git',
    baseBranch: 'dev',
    createdAt: '2026-05-01T00:00:00.000Z',
    packageManager: 'bun',
    installCmd: 'bun install',
    testCmd: 'bun test',
    ciWorkflowName: 'CI',
    contributionGuidePath: null,
    agentWorker: null,
    agentReviewer: null,
    modelWorker: null,
    modelReviewer: null,
    preambleWorker: null,
    preambleReviewer: 99,
    ciPolicy: {
      ignoreMode: 'inherit',
      ignoredCheckNames: [],
      ignoredWorkflowNames: [],
      effectiveIgnoredCheckNames: ['lint'],
      effectiveIgnoredWorkflowNames: [],
    },
    effectivePreambles: {
      worker: {
        role: 'worker',
        kind: 'code',
        source: 'global',
        configuredPreambleId: null,
        effectivePreambleId: 7,
        title: 'Worker default',
        body: 'hidden',
        refs: 3,
        lastEdited: null,
      },
      reviewer: {
        role: 'reviewer',
        kind: 'review',
        source: 'repo',
        configuredPreambleId: 99,
        effectivePreambleId: 8,
        title: 'Reviewer override',
        body: 'hidden',
        refs: 2,
        lastEdited: null,
      },
    },
    tagNamespaces: [],
    inheritedTagNamespaces: [],
  };
}
