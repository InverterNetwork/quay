import { useState } from 'react';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Chip } from '../components/Chip';
import { Segmented } from '../components/Segmented';
import { HStack } from '../components/Stack';
import { StatusDot } from '../components/StatusDot';
import { Toggle } from '../components/Toggle';
import { T } from '../components/Typography';
import { Icon } from '../icons/Icon';
import { Field } from './Field';
import { PreambleCard } from './PreambleCard';
import { Section, SubGroup } from './Section';
import { Toc, type TocItem } from './Toc';
import type {
  AdapterSummary,
  AgentInvocation,
  ConfigFieldSummary,
  GlobalConfigSummary,
  MatrixReadModel,
  RepoSummary,
} from '../store/data';
import type { ChangeEntry } from '../store/dirty';
import { MatrixScreen } from './MatrixScreen';
import { TagNamespaceEditor } from './TagNamespaceEditor';

const TOC: TocItem[] = [
  { id: 'ops', label: 'Operations' },
  { id: 'adapters', label: 'Adapters' },
  { id: 'registry', label: 'Agent registry' },
  { id: 'agents', label: 'Default agents' },
  { id: 'prompts', label: 'Default prompts' },
  { id: 'tags', label: 'Default tags' },
];

interface GlobalScreenProps {
  global: GlobalConfigSummary;
  matrix: MatrixReadModel;
  repos: RepoSummary[];
  quayVersion?: string;
  changes: ChangeEntry[];
  onChange: (entry: ChangeEntry) => void;
  onOpenPreamble: (kind: 'worker' | 'reviewer') => void;
}

export function GlobalScreen({
  global,
  matrix,
  repos,
  quayVersion,
  changes,
  onChange,
  onOpenPreamble,
}: GlobalScreenProps) {
  const [view, setView] = useState<'settings' | 'resolved'>('settings');
  const [activeAnchor, setActiveAnchor] = useState('prompts');

  return (
    <>
      <Header
        configPath={global.configPath}
        dataDir={global.dataDir}
        view={view}
        repoCount={repos.length}
        quayVersion={quayVersion}
        onView={setView}
      />
      {view === 'settings' ? (
        <SettingsBody
          global={global}
          changes={changes}
          onChange={onChange}
          onOpenPreamble={onOpenPreamble}
          active={activeAnchor}
          setActive={setActiveAnchor}
        />
      ) : (
        <MatrixScreen repos={repos} matrix={matrix} />
      )}
    </>
  );
}

interface HeaderProps {
  configPath: string | null;
  dataDir: string;
  view: 'settings' | 'resolved';
  repoCount: number;
  quayVersion?: string;
  onView: (v: 'settings' | 'resolved') => void;
}

function Header({ configPath, dataDir, view, repoCount, quayVersion, onView }: HeaderProps) {
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
        <Icon.Settings size={18} style={{ color: 'var(--accent)' }} />
        <T as="h1" kind="h1" style={{ fontSize: 26, letterSpacing: '-0.02em' }}>
          Global
        </T>
        <Badge tone="neutral" size="md" variant="outline">
          defaults for {repoCount} repo{repoCount === 1 ? '' : 's'}
        </Badge>
        <span style={{ flex: 1 }} />
        <Segmented
          value={view}
          onChange={onView}
          options={[
            { value: 'settings', label: 'Settings' },
            { value: 'resolved', label: 'Resolved across repos' },
          ]}
        />
        <Button variant="ghost" size="md" disabled title="Export is not exposed by the read-only Admin API v1">
          Export TOML
        </Button>
      </HStack>
      <HStack gap={14}>
        <T kind="mono-sm" color="var(--ink-3)">
          {configPath ?? 'no config file loaded'}
        </T>
        <T kind="mono-sm" color="var(--ink-4)">
          ·
        </T>
        <T kind="mono-sm" color="var(--ink-3)">
          data {dataDir}
        </T>
        <T kind="mono-sm" color="var(--ink-4)">
          ·
        </T>
        <T kind="mono-sm" color="var(--ink-3)">
          quay {quayVersion ?? 'version unknown'}
        </T>
      </HStack>
    </div>
  );
}

interface SettingsBodyProps {
  global: GlobalConfigSummary;
  changes: ChangeEntry[];
  onChange: (entry: ChangeEntry) => void;
  onOpenPreamble: (kind: 'worker' | 'reviewer') => void;
  active: string;
  setActive: (id: string) => void;
}

function SettingsBody({ global, changes, onChange, onOpenPreamble, active, setActive }: SettingsBodyProps) {
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
        <Section n="01" id="ops" title="Operations" hint="tick · supervisor · claims · paths">
          <SubGroup title="Concurrency" hint="how many workers tick may have in flight">
            {global.operations.concurrency.map((field) => (
              <ReadOnlyField key={field.key} field={field} />
            ))}
          </SubGroup>
          <SubGroup title="Budgets" hint="copied onto new tasks at enqueue time">
            {global.operations.budgets.map((field) => (
              <ReadOnlyField key={field.key} field={field} />
            ))}
          </SubGroup>
          <SubGroup title="Live-worker thresholds" hint="when does tick kill a stuck worker">
            {global.operations.liveWorkerThresholds.map((field) => (
              <ReadOnlyField key={field.key} field={field} />
            ))}
          </SubGroup>
          <SubGroup title="Claims" hint="orchestrator claim lifecycle">
            {global.operations.claims.map((field) => (
              <ReadOnlyField key={field.key} field={field} />
            ))}
          </SubGroup>
          <SubGroup title="Paths" columns={3}>
            {global.operations.paths.map((field) => (
              <ReadOnlyField key={field.key} field={field} />
            ))}
          </SubGroup>
        </Section>

        <Section n="02" id="adapters" title="Adapters" hint="how Quay reaches the outside world">
          {global.adapters.map((adapter) => (
            <AdapterCard key={adapter.name} adapter={adapter} />
          ))}
        </Section>

        <Section
          n="03"
          id="registry"
          title="Agent registry"
          hint="invocations available to all repos · each defines how to spawn"
          right={
            <Button
              variant="secondary"
              size="sm"
              leading={<Icon.Plus size={12} />}
              disabled
              title="Agent writes are not exposed by the read-only Admin API v1"
            >
              New invocation
            </Button>
          }
        >
          {global.agents.invocations.map((inv) => (
            <Card key={inv.name} padding={18} style={{ marginBottom: 12 }}>
              <HStack gap={10} style={{ marginBottom: 12 }}>
                <Icon.Bot size={14} style={{ color: 'var(--ink-3)' }} />
                <T kind="h4" style={{ fontFamily: 'var(--mono)' }}>
                  {inv.name}
                </T>
                {inv.roles.includes('worker') && (
                  <Badge tone="accent" size="sm" variant="outline">
                    worker
                  </Badge>
                )}
                {inv.roles.includes('reviewer') && (
                  <Badge tone="warn" size="sm" variant="outline">
                    reviewer
                  </Badge>
                )}
                {inv.capabilities.map((c) => (
                  <Chip key={c} tone="accent" selected>
                    {c}
                  </Chip>
                ))}
                <span style={{ flex: 1 }} />
                <T kind="mono-sm" color="var(--ink-3)">
                  {inv.usedByRepos} repos · {inv.usedByTasks} live tasks
                </T>
                <Icon.More size={14} style={{ color: 'var(--ink-4)' }} />
              </HStack>
              <AgentCommandList invocation={inv} />
            </Card>
          ))}
        </Section>

        <Section n="04" id="agents" title="Default agents" hint="what runs unless a repo overrides">
          <SubGroup title="Worker">
            <Field label="AGENT" value={global.agents.defaults.worker} source="global-only" />
            <Field label="MODEL" value={global.agents.defaults.workerModel ?? 'not configured'} source="global-only" />
          </SubGroup>
          <SubGroup title="Reviewer">
            <Field label="AGENT" value={global.agents.defaults.reviewer} source="global-only" />
            <Field label="MODEL" value={global.agents.defaults.reviewerModel ?? 'not configured'} source="global-only" />
          </SubGroup>
        </Section>

        <Section
          n="05"
          id="prompts"
          title="Default prompts"
          hint="preambles + attempt guidance · referenced by every spawn"
          right={
            <Button
              variant="ghost"
              size="sm"
              leading={<Icon.Sparkle size={12} />}
              disabled
              title="Composed prompt preview is not exposed by the read-only Admin API v1"
            >
              Composed preview
            </Button>
          }
        >
          {global.preambles.map((preamble) => (
            <PreambleCard
              key={preamble.kind}
              preamble={preamble}
              onEdit={() => onOpenPreamble(preamble.kind === 'review' ? 'reviewer' : 'worker')}
            />
          ))}

          <Card padding={18}>
            <HStack gap={10} style={{ marginBottom: 12 }}>
              <Icon.Sparkle size={14} style={{ color: 'var(--accent)' }} />
              <T as="h3" kind="h4">
                Attempt-guidance templates
              </T>
              <T kind="mono-sm" color="var(--ink-3)">
                · short per-reason inserts; routed by the spawner
              </T>
              <span style={{ flex: 1 }} />
              <Button
                variant="ghost"
                size="sm"
                leading={<Icon.Plus size={12} />}
                disabled
                title="Template writes are not exposed by the read-only Admin API v1"
              >
                New reason
              </Button>
            </HStack>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {global.retryTemplates.map((g) => (
                <div
                  key={g.reason}
                  style={{
                    border: '1px solid var(--line)',
                    borderRadius: 'var(--r-sm)',
                    background: 'var(--surface)',
                    padding: '10px 12px',
                  }}
                >
                  <HStack gap={6} style={{ marginBottom: 6 }}>
                    <T kind="mono" style={{ fontWeight: 500 }}>
                      {g.reason}
                    </T>
                    <Badge tone="accent" size="sm" variant="outline">
                      v{g.version}
                    </Badge>
                    <span style={{ flex: 1 }} />
                    <T kind="mono-sm" color="var(--ink-4)">
                      {g.refs} ref
                    </T>
                  </HStack>
                  <T
                    kind="body-sm"
                    color="var(--ink-2)"
                    style={{
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                      lineHeight: 1.45,
                    }}
                  >
                    {g.body}
                  </T>
                </div>
              ))}
            </div>
          </Card>
        </Section>

        <Section
          n="06"
          id="tags"
          title="Default tags"
          hint="deployment-wide namespaces · every repo inherits these"
        >
          <TagNamespaceEditor
            scope="deployment"
            baseline={global.tagNamespaces}
            changes={changes}
            onChange={onChange}
            emptyText="No deployment tag namespaces are configured."
          />
        </Section>
        <div style={{ height: 80 }} />
      </div>

      <Toc items={TOC} active={active} onSelect={setActive} />
    </div>
  );
}

const AGENT_ROLES: Array<'worker' | 'reviewer'> = ['worker', 'reviewer'];

function AgentCommandList({ invocation }: { invocation: AgentInvocation }) {
  const rows = AGENT_ROLES.flatMap((role) => {
    const command = invocation.commands[role];
    return command === undefined ? [] : [{ role, command }];
  });

  if (rows.length === 0) {
    return (
      <div
        style={{
          background: 'var(--surface-2)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--r-sm)',
          padding: '8px 12px',
        }}
      >
        <T kind="mono-sm" color="var(--ink-3)">
          no command registered
        </T>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {rows.map(({ role, command }) => (
        <div
          key={role}
          style={{
            background: 'var(--surface-2)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--r-sm)',
            padding: '8px 12px',
          }}
        >
          <HStack gap={8} style={{ marginBottom: 6 }}>
            <Badge tone={role === 'worker' ? 'accent' : 'warn'} size="sm" variant="outline">
              {role}
            </Badge>
          </HStack>
          <T
            kind="mono-sm"
            color="var(--ink-2)"
            style={{
              display: 'block',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              lineHeight: 1.55,
            }}
          >
            {command}
          </T>
        </div>
      ))}
    </div>
  );
}

function ReadOnlyField({ field }: { field: ConfigFieldSummary }) {
  return (
    <Field
      label={field.label}
      value={field.value ?? 'not configured'}
      source="global-only"
      suffix={field.unit ? <Chip>{field.unit}</Chip> : undefined}
      helper={field.source === 'default' ? 'default' : field.source === 'derived' ? 'derived' : undefined}
      computed={field.source === 'derived'}
    />
  );
}

function AdapterCard({ adapter }: { adapter: AdapterSummary }) {
  const columns = Math.min(3, Math.max(1, adapter.fields.length));
  return (
    <Card padding={18} style={{ marginBottom: 12 }}>
      <HStack gap={10} style={{ marginBottom: 14 }}>
        <T as="h3" kind="h4">
          {adapter.title}
        </T>
        <Toggle checked={adapter.enabled} disabled />
        <span style={{ flex: 1 }} />
        <HStack gap={5}>
          <StatusDot tone={adapter.statusTone} />
          <T kind="mono-sm" color={adapter.statusTone === 'warn' ? 'var(--warn-ink)' : 'var(--ink-3)'}>
            {adapter.statusText}
          </T>
        </HStack>
      </HStack>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, 1fr)`, gap: 14 }}>
        {adapter.fields.map((f) => (
          <Field
            key={f.label}
            label={f.label}
            value={f.value}
            source="global-only"
            mono={f.mono ?? true}
            suffix={f.dotTone ? <StatusDot tone={f.dotTone} /> : undefined}
          />
        ))}
      </div>
    </Card>
  );
}
