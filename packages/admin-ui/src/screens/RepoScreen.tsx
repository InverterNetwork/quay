import { useState } from 'react';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { HStack } from '../components/Stack';
import { T } from '../components/Typography';
import { Icon } from '../icons/Icon';
import { ComposedPreview } from './ComposedPreview';
import { Field } from './Field';
import { Section, SubGroup } from './Section';
import { Toc, type TocItem } from './Toc';
import type { GlobalConfigSummary, PreambleSummary, RepoSummary } from '../store/data';
import type { ChangeEntry, RepoUpdateChange } from '../store/dirty';
import { TagNamespaceEditor } from './TagNamespaceEditor';

const TOC: TocItem[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'identity', label: 'Identity & checkout' },
  { id: 'agents', label: 'Agents' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'tags', label: 'Tags' },
];

interface RepoScreenProps {
  repo: RepoSummary;
  global: GlobalConfigSummary;
  changes: ChangeEntry[];
  onChange: (entry: ChangeEntry) => void;
  onArchive: (repoId: string) => void;
}

export function RepoScreen({ repo, global, changes, onChange, onArchive }: RepoScreenProps) {
  const [active, setActive] = useState('prompts');

  return (
    <>
      <RepoHeader repo={repo} onArchive={onArchive} />
      <Body
        repo={repo}
        global={global}
        changes={changes}
        onChange={onChange}
        active={active}
        setActive={setActive}
      />
    </>
  );
}

function RepoHeader({ repo, onArchive }: { repo: RepoSummary; onArchive: (id: string) => void }) {
  return (
    <div
      style={{
        padding: '24px 28px 18px',
        borderBottom: '1px solid var(--line)',
        background: 'var(--paper)',
        flexShrink: 0,
      }}
    >
      <HStack gap={12} align="baseline" style={{ marginBottom: 6 }}>
        <Icon.Repo size={18} style={{ color: 'var(--accent)' }} />
        <T as="h1" kind="h1" style={{ fontSize: 26, letterSpacing: '-0.02em', fontFamily: 'var(--mono)' }}>
          {repo.id}
        </T>
        <Badge tone="good" dot>
          ACTIVE
        </Badge>
        {repo.active != null && (
          <Badge tone="accent" size="md">
            {repo.active} ACTIVE TASKS
          </Badge>
        )}
        <span style={{ flex: 1 }} />
        <Button variant="ghost" size="md" leading={<Icon.ExternalLink size={13} />}>
          Source
        </Button>
        <Button
          variant="danger"
          size="md"
          onClick={() => onArchive(repo.id)}
          disabled
          title="Archive is not exposed by the read-only Admin API v1"
        >
          Archive repo
        </Button>
      </HStack>
      <HStack gap={14}>
        <T kind="mono-sm" color="var(--ink-3)">
          {repo.url}
        </T>
        <T kind="mono-sm" color="var(--ink-4)">
          ·
        </T>
        <T kind="mono-sm" color="var(--ink-3)">
          {repo.packageManager ?? 'package manager unknown'}
        </T>
        <T kind="mono-sm" color="var(--ink-4)">
          ·
        </T>
        <T kind="mono-sm" color="var(--ink-3)">
          {repo.overrides} overrides from Global
        </T>
      </HStack>
    </div>
  );
}

interface BodyProps {
  repo: RepoSummary;
  global: GlobalConfigSummary;
  changes: ChangeEntry[];
  onChange: (entry: ChangeEntry) => void;
  active: string;
  setActive: (id: string) => void;
}

function Body({ repo, global, changes, onChange, active, setActive }: BodyProps) {
  const workerPreamble = global.preambles.find((preamble) => preamble.kind === 'code') ?? null;
  const reviewerPreamble = global.preambles.find((preamble) => preamble.kind === 'review') ?? null;
  const field = createRepoFieldAccess(repo, changes, onChange);

  return (
    <div
      style={{
        flex: 1,
        overflow: 'auto',
        display: 'flex',
        padding: '32px 28px 0',
        gap: 28,
        alignItems: 'flex-start',
      }}
      onScroll={(e) => {
        const top = (e.target as HTMLDivElement).scrollTop + 120;
        for (const item of TOC) {
          const el = document.getElementById(item.id);
          if (el && el.offsetTop > top) break;
          if (el) setActive(item.id);
        }
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* 01 · Overview */}
        <Section n="01" id="overview" title="Overview">
          <Card padding={20}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 24 }}>
              {[
                { l: 'Base branch', v: repo.baseBranch, s: 'repo registry' },
                { l: 'Package', v: repo.packageManager ?? 'unknown', s: 'install runtime' },
                { l: 'Active tasks', v: String(repo.active ?? 0), s: 'Admin API detail' },
                { l: 'Created', v: repo.createdAt.slice(0, 10), s: 'repo registry' },
              ].map((b) => (
                <div key={b.l}>
                  <T kind="caption" color="var(--ink-3)" style={{ display: 'block' }}>
                    {b.l}
                  </T>
                  <T kind="h3" style={{ display: 'block', marginTop: 4, fontFamily: 'var(--mono)' }}>
                    {b.v}
                  </T>
                  <T kind="mono-sm" color="var(--ink-3)" style={{ display: 'block', marginTop: 2 }}>
                    {b.s}
                  </T>
                </div>
              ))}
            </div>
          </Card>
        </Section>

        {/* 02 · Identity */}
        <Section n="02" id="identity" title="Identity & checkout" hint="repo-only · no global equivalent">
          <SubGroup title="Source">
            <Field
              fullRow
              label="REPO_URL"
              value={field.value('repo_url', repo.url)}
              source="repo-only"
              dirty={field.dirty('repo_url')}
              editable
              onCommit={(next) => field.commit('repo_url', next)}
            />
            <Field label="REPO_ID" value={repo.id} source="repo-only" computed />
            <Field
              label="BASE_BRANCH"
              value={field.value('base_branch', repo.baseBranch)}
              source="repo-only"
              dirty={field.dirty('base_branch')}
              editable
              onCommit={(next) => field.commit('base_branch', next)}
            />
          </SubGroup>
          <SubGroup title="Build" hint="run inside each new worktree">
            <Field
              label="PACKAGE_MANAGER"
              value={field.value('package_manager', repo.packageManager ?? '')}
              source="repo-only"
              dirty={field.dirty('package_manager')}
              editable
              onCommit={(next) => field.commit('package_manager', next)}
            />
            <Field
              label="TEST_CMD"
              value={field.value('test_cmd', repo.testCmd ?? null)}
              source="repo-only"
              dirty={field.dirty('test_cmd')}
              editable
              onCommit={(next) => field.commit('test_cmd', next)}
            />
            <Field
              fullRow
              label="INSTALL_CMD"
              value={field.value('install_cmd', repo.installCmd ?? '')}
              source="repo-only"
              dirty={field.dirty('install_cmd')}
              editable
              onCommit={(next) => field.commit('install_cmd', next)}
            />
            <Field
              label="CI_WORKFLOW"
              value={field.value('ci_workflow_name', repo.ciWorkflowName ?? null)}
              source="repo-only"
              dirty={field.dirty('ci_workflow_name')}
              editable
              onCommit={(next) => field.commit('ci_workflow_name', next)}
            />
            <Field
              label="CONTRIBUTION_GUIDE"
              value={field.value('contribution_guide_path', repo.contributionGuidePath ?? null)}
              source="repo-only"
              dirty={field.dirty('contribution_guide_path')}
              editable
              onCommit={(next) => field.commit('contribution_guide_path', next)}
            />
          </SubGroup>
        </Section>

        {/* 03 · Agents */}
        <Section
          n="03"
          id="agents"
          title="Agents"
          hint="overrides global default for this repo · task may further override at enqueue"
        >
          <SubGroup title="Worker">
            <Field
              label="AGENT"
              value={field.value('agent_worker', repo.agentWorker ?? null)}
              source={field.value('agent_worker', repo.agentWorker ?? null) ? 'override' : 'inherits'}
              inheritedValue={global.agents.defaults.worker}
              dirty={field.dirty('agent_worker')}
              editable
              onCommit={(next) => field.commit('agent_worker', next)}
            />
            <Field
              label="MODEL"
              value={field.value('model_worker', repo.modelWorker ?? null)}
              source={field.value('model_worker', repo.modelWorker ?? null) ? 'override' : 'inherits'}
              inheritedValue={global.agents.defaults.workerModel ?? 'not configured'}
              dirty={field.dirty('model_worker')}
              editable
              onCommit={(next) => field.commit('model_worker', next)}
            />
          </SubGroup>
          <SubGroup title="Reviewer">
            <Field
              label="AGENT"
              value={field.value('agent_reviewer', repo.agentReviewer ?? null)}
              source={field.value('agent_reviewer', repo.agentReviewer ?? null) ? 'override' : 'inherits'}
              inheritedValue={global.agents.defaults.reviewer}
              dirty={field.dirty('agent_reviewer')}
              editable
              onCommit={(next) => field.commit('agent_reviewer', next)}
            />
            <Field
              label="MODEL"
              value={field.value('model_reviewer', repo.modelReviewer ?? null)}
              source={field.value('model_reviewer', repo.modelReviewer ?? null) ? 'override' : 'inherits'}
              inheritedValue={global.agents.defaults.reviewerModel ?? 'not configured'}
              dirty={field.dirty('model_reviewer')}
              editable
              onCommit={(next) => field.commit('model_reviewer', next)}
            />
          </SubGroup>
        </Section>

        {/* 04 · Prompts */}
        <Section n="04" id="prompts" title="Prompts" hint="inherit · extend · replace · per kind">
          <div style={{ display: 'flex', gap: 18, alignItems: 'stretch' }}>
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
              {workerPreamble && <RepoPreambleCard preamble={workerPreamble} role="worker" />}
              {reviewerPreamble && <RepoPreambleCard preamble={reviewerPreamble} role="reviewer" />}
            </div>
            <ComposedPreview preamble={workerPreamble} guidanceTemplates={global.retryTemplates} repoId={repo.id} />
          </div>
        </Section>

        {/* 05 · Tags */}
        <Section
          n="05"
          id="tags"
          title="Tags"
          hint="extends deployment vocab"
        >
          <TagNamespaceEditor
            scope="repo"
            repoId={repo.id}
            baseline={repo.tagNamespaces}
            inherited={repo.inheritedTagNamespaces}
            changes={changes}
            onChange={onChange}
            emptyText="This repo does not define additional tag namespaces."
          />
        </Section>
        <div style={{ height: 80 }} />
      </div>

      <Toc items={TOC} active={active} onSelect={setActive} />
    </div>
  );
}

type RepoPatch = RepoUpdateChange['patch'];
type RepoPatchKey = keyof RepoPatch;

function createRepoFieldAccess(
  repo: RepoSummary,
  changes: ChangeEntry[],
  onChange: (entry: ChangeEntry) => void,
) {
  const baseline: Record<RepoPatchKey, string | null> = {
    repo_url: repo.url,
    base_branch: repo.baseBranch,
    package_manager: repo.packageManager ?? '',
    install_cmd: repo.installCmd ?? '',
    test_cmd: repo.testCmd ?? null,
    ci_workflow_name: repo.ciWorkflowName ?? null,
    contribution_guide_path: repo.contributionGuidePath ?? null,
    agent_worker: repo.agentWorker ?? null,
    agent_reviewer: repo.agentReviewer ?? null,
    model_worker: repo.modelWorker ?? null,
    model_reviewer: repo.modelReviewer ?? null,
  };

  function changeId(key: RepoPatchKey): string {
    return `repo:${repo.id}:${key}`;
  }

  function pendingValue(key: RepoPatchKey): string | null | undefined {
    const entry = changes.find((change) => change.id === changeId(key));
    if (entry?.change.type !== 'repo.update') return undefined;
    return entry.change.patch[key];
  }

  function normalize(key: RepoPatchKey, value: string): string | null {
    const trimmed = value.trim();
    if (NULLABLE_REPO_FIELDS.has(key) && trimmed === '') return null;
    return trimmed;
  }

  return {
    value(key: RepoPatchKey, fallback: string | null): string | null {
      const pending = pendingValue(key);
      return pending === undefined ? fallback : pending;
    },
    dirty(key: RepoPatchKey): boolean {
      return changes.some((change) => change.id === changeId(key));
    },
    commit(key: RepoPatchKey, value: string): void {
      const after = normalize(key, value);
      onChange({
        id: changeId(key),
        scope: repo.id,
        label: `${repo.id} ${key}`,
        before: formatFieldValue(baseline[key]),
        after: formatFieldValue(after),
        change: {
          type: 'repo.update',
          repo_id: repo.id,
          patch: { [key]: after } as RepoPatch,
        },
      });
    },
  };
}

const NULLABLE_REPO_FIELDS = new Set<RepoPatchKey>([
  'test_cmd',
  'ci_workflow_name',
  'contribution_guide_path',
  'agent_worker',
  'agent_reviewer',
  'model_worker',
  'model_reviewer',
]);

function formatFieldValue(value: string | null): string {
  return value === null || value === '' ? 'not configured' : value;
}

function RepoPreambleCard({ preamble, role }: { preamble: PreambleSummary; role: 'worker' | 'reviewer' }) {
  return (
    <Card padding={18}>
      <HStack gap={10} style={{ marginBottom: 12 }}>
        <Icon.Anchor size={14} style={{ color: role === 'worker' ? 'var(--accent)' : 'var(--ink-3)' }} />
        <T as="h3" kind="h4">
          {role === 'worker' ? 'Worker preamble' : 'Reviewer preamble'}
        </T>
        <Badge tone={role === 'worker' ? 'accent' : 'neutral'} size="sm" variant={role === 'worker' ? 'solid' : 'outline'}>
          inherits global v{preamble.version}
        </Badge>
        <span style={{ flex: 1 }} />
      </HStack>
      <T kind="body-sm" color="var(--ink-3)" style={{ display: 'block', marginBottom: 10, lineHeight: 1.5 }}>
        No repo-specific preamble override is exposed by the read-only Admin API v1.
      </T>
      <div
        style={{
          background: 'var(--surface-2)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--r-sm)',
          padding: '10px 14px',
          fontFamily: 'var(--mono)',
          fontSize: 12,
          lineHeight: 1.6,
          color: 'var(--ink-2)',
          whiteSpace: 'pre-wrap',
        }}
      >
        {preamble.body}
      </div>
      <HStack gap={6} style={{ marginTop: 10 }}>
        <T kind="mono-sm" color="var(--ink-3)">
          {preamble.body.length} bytes · {preamble.body.split('\n').length} lines
        </T>
        <span style={{ flex: 1 }} />
      </HStack>
    </Card>
  );
}
