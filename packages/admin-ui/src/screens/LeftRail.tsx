import { Badge } from '../components/Badge';
import { Divider } from '../components/Divider';
import { Input } from '../components/Input';
import { Segmented } from '../components/Segmented';
import { HStack } from '../components/Stack';
import { T } from '../components/Typography';
import { Icon } from '../icons/Icon';
import type { RepoSummary } from '../store/data';

type ScopeKey = 'global' | string;

interface LeftRailProps {
  active: ScopeKey;
  repos: RepoSummary[];
  archived?: string[];
  empty?: boolean;
  loading?: boolean;
  error?: string | null;
  readOnly?: boolean;
  onSelect: (scope: ScopeKey) => void;
  onAddRepo: () => void;
}

export function LeftRail({
  active,
  repos,
  archived = [],
  empty,
  loading,
  error,
  readOnly,
  onSelect,
  onAddRepo,
}: LeftRailProps) {
  const visibleRepos = empty ? [] : repos;
  const visibleArchived = empty ? [] : archived;
  return (
    <aside
      style={{
        width: 240,
        borderRight: '1px solid var(--line)',
        background: 'var(--paper)',
        padding: '16px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        flexShrink: 0,
        overflow: 'hidden',
      }}
    >
      <T kind="caption" color="var(--ink-3)" style={{ padding: '4px 8px 6px' }}>
        SCOPE
      </T>

      <RailRow
        active={active === 'global'}
        onClick={() => onSelect('global')}
        icon={<Icon.Settings size={14} />}
        primary="Global"
        secondary="defaults for all repos"
      />

      <HStack gap={6} style={{ padding: '18px 8px 4px' }}>
        <T kind="caption" color="var(--ink-3)">
          REGISTERED REPOS
        </T>
        <T kind="mono-sm" color="var(--ink-4)">
          {visibleRepos.length}
        </T>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          aria-label="Register repo"
          onClick={onAddRepo}
          disabled={readOnly}
          title={readOnly ? 'Repo registration is not exposed by the read-only Admin API v1' : undefined}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            background: 'transparent',
            border: 0,
            color: 'var(--ink-3)',
            cursor: readOnly ? 'default' : 'pointer',
            opacity: readOnly ? 0.45 : 1,
          }}
        >
          <Icon.Plus size={12} />
        </button>
      </HStack>

      {!empty && !loading && !error && (
        <Input
          placeholder="Filter…"
          leading={<Icon.Search size={11} />}
          inputSize="sm"
          shellStyle={{ margin: '0 4px 6px', height: 26 }}
        />
      )}

      {loading && (
        <RailMessage icon={<Icon.Pulse size={12} />} text="Loading repos..." />
      )}

      {error && !loading && (
        <RailMessage icon={<Icon.Alert size={12} />} text="API unavailable" tone="danger" />
      )}

      {empty && (
        <div
          style={{
            padding: '14px 12px',
            background: 'var(--paper-2)',
            border: '1px dashed var(--line-2)',
            borderRadius: 'var(--r-sm)',
            margin: '4px 4px 0',
          }}
        >
          <T kind="body-sm" color="var(--ink-3)" style={{ display: 'block', lineHeight: 1.45 }}>
            {readOnly
              ? 'No repos yet. Register one from the Quay CLI, then reload this view.'
              : 'No repos yet. Register one to start enqueueing tasks.'}
          </T>
          <button
            type="button"
            onClick={onAddRepo}
            disabled={readOnly}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 5,
              width: '100%',
              marginTop: 10,
              height: 26,
              background: 'var(--surface)',
              border: '1px solid var(--line-2)',
              borderRadius: 'var(--r-sm)',
              fontFamily: 'var(--sans)',
              fontSize: 12,
              fontWeight: 500,
              color: 'var(--ink)',
              cursor: readOnly ? 'default' : 'pointer',
              opacity: readOnly ? 0.55 : 1,
            }}
          >
            <Icon.Plus size={11} /> Register repo
          </button>
        </div>
      )}

      {visibleRepos.map((r) => {
        const sel = active === r.id;
        const agentLabel =
          r.agent === 'inherits' ? 'inherits global' : r.agent.replace('hermes_codex_browser', 'hermes…');
        return (
          <div
            key={r.id}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(r.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(r.id);
              }
            }}
            style={{
              padding: '8px 10px',
              borderRadius: 'var(--r-sm)',
              background: sel ? 'var(--surface)' : 'transparent',
              border: `1px solid ${sel ? 'var(--line)' : 'transparent'}`,
              borderLeft: sel ? '2px solid var(--accent)' : '2px solid transparent',
              cursor: 'pointer',
            }}
          >
            <HStack gap={9}>
              <Icon.Repo size={12} style={{ color: sel ? 'var(--accent)' : 'var(--ink-3)' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <HStack gap={6}>
                  <span
                    style={{
                      fontFamily: 'var(--mono)',
                      fontSize: 12.5,
                      fontWeight: sel ? 600 : 500,
                      color: 'var(--ink)',
                      flex: 1,
                    }}
                  >
                    {r.id}
                  </span>
                  {r.active != null && r.active > 0 && (
                    <T kind="mono-sm" color="var(--ink-3)">
                      {r.active}
                    </T>
                  )}
                </HStack>
                <HStack gap={6} style={{ marginTop: 2 }}>
                  <T
                    kind="mono-sm"
                    color="var(--ink-3)"
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {agentLabel}
                  </T>
                  {r.overrides > 0 && (
                    <Badge tone="accent" size="sm" variant="outline">
                      {r.overrides}
                    </Badge>
                  )}
                </HStack>
              </div>
            </HStack>
          </div>
        );
      })}

      {visibleArchived.length > 0 && (
        <>
          <HStack gap={6} style={{ padding: '14px 8px 4px' }}>
            <T kind="caption" color="var(--ink-3)">
              ARCHIVED
            </T>
            <T kind="mono-sm" color="var(--ink-4)">
              {visibleArchived.length}
            </T>
          </HStack>
          {visibleArchived.map((a) => (
            <div key={a} style={{ padding: '6px 10px', opacity: 0.5 }}>
              <T kind="mono-sm" color="var(--ink-3)">
                {a}
              </T>
            </div>
          ))}
        </>
      )}

      <span style={{ flex: 1 }} />
      <Divider dashed style={{ margin: '8px 4px' }} />
      <div style={{ padding: '4px 8px' }}>
        <T kind="caption" color="var(--ink-3)" style={{ display: 'block' }}>
          FORMAT
        </T>
        <Segmented
          value="form"
          options={[
            { value: 'form', label: 'Form' },
            { value: 'toml', label: 'TOML' },
          ]}
          style={{ marginTop: 6 }}
        />
      </div>
    </aside>
  );
}

function RailMessage({
  icon,
  text,
  tone = 'neutral',
}: {
  icon: React.ReactNode;
  text: string;
  tone?: 'neutral' | 'danger';
}) {
  return (
    <div
      style={{
        margin: '4px 4px 0',
        padding: '10px 12px',
        borderRadius: 'var(--r-sm)',
        background: tone === 'danger' ? 'var(--danger-soft)' : 'var(--paper-2)',
        border: `1px solid ${tone === 'danger' ? 'var(--danger-line)' : 'var(--line-2)'}`,
      }}
    >
      <HStack gap={8}>
        {icon}
        <T kind="body-sm" color={tone === 'danger' ? 'var(--danger-ink)' : 'var(--ink-3)'}>
          {text}
        </T>
      </HStack>
    </div>
  );
}

interface RailRowProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  primary: string;
  secondary: string;
}

function RailRow({ active, onClick, icon, primary, secondary }: RailRowProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      style={{
        padding: '9px 10px',
        borderRadius: 'var(--r-sm)',
        background: active ? 'var(--surface)' : 'transparent',
        border: `1px solid ${active ? 'var(--line)' : 'transparent'}`,
        borderLeft: active ? '2px solid var(--accent)' : '2px solid transparent',
        cursor: 'pointer',
      }}
    >
      <HStack gap={9}>
        <span style={{ color: active ? 'var(--accent)' : 'var(--ink-3)', display: 'inline-flex' }}>
          {icon}
        </span>
        <div style={{ flex: 1 }}>
          <T kind="body-sm" style={{ fontWeight: active ? 600 : 500, display: 'block' }}>
            {primary}
          </T>
          <T kind="mono-sm" color="var(--ink-3)" style={{ display: 'block' }}>
            {secondary}
          </T>
        </div>
      </HStack>
    </div>
  );
}
