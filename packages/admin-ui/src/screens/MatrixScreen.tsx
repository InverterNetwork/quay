import type { ReactElement } from 'react';
import { Badge } from '../components/Badge';
import { Chip } from '../components/Chip';
import { HStack } from '../components/Stack';
import { T } from '../components/Typography';
import { Icon } from '../icons/Icon';
import type { MatrixReadModel, MatrixRow, RepoSummary } from '../store/data';

export function MatrixScreen({ repos, matrix }: { repos: RepoSummary[]; matrix: MatrixReadModel }) {
  const colsTemplate = `220px 160px repeat(${Math.max(repos.length, 1)}, minmax(160px, 1fr)) 60px`;
  const rows = matrix.rows;
  const overrideCount = rows.reduce(
    (sum, row) => sum + (row.def == null ? 0 : Object.values(row.vals).filter((value) => value != null).length),
    0,
  );

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <Toolbar rowCount={rows.length} overrideCount={overrideCount} />

      <div style={{ flex: 1, overflow: 'auto' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: colsTemplate,
            borderBottom: '1px solid var(--ink)',
            background: 'var(--surface-2)',
            position: 'sticky',
            top: 0,
            zIndex: 1,
          }}
        >
          <div style={{ padding: '10px 14px' }}>
            <T kind="caption" color="var(--ink-2)">
              KEY
            </T>
          </div>
          <div style={{ padding: '10px 12px', borderLeft: '1px solid var(--line)' }}>
            <T kind="caption" color="var(--ink-2)">
              GLOBAL DEFAULT
            </T>
          </div>
          {repos.map((repo) => (
            <div key={repo.id} style={{ padding: '10px 12px', borderLeft: '1px solid var(--line)' }}>
              <T kind="mono" style={{ fontWeight: 600, display: 'block' }}>
                {repo.id}
              </T>
              <T kind="mono-sm" color="var(--ink-3)">
                {repo.overrides} overrides
              </T>
            </div>
          ))}
          <div style={{ padding: '10px 8px', borderLeft: '1px solid var(--line)', textAlign: 'center' }}>
            <T kind="caption" color="var(--ink-3)">
              ···
            </T>
          </div>
        </div>

        <Rows rows={rows} repos={repos.map((repo) => repo.id)} colsTemplate={colsTemplate} />
      </div>
    </div>
  );
}

function Toolbar({ rowCount, overrideCount }: { rowCount: number; overrideCount: number }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 28px',
        borderBottom: '1px solid var(--line)',
        background: 'var(--paper)',
      }}
    >
      <Chip tone="accent" selected interactive>
        All keys
        <T kind="mono-sm" color="var(--ink-3)" style={{ marginLeft: 4 }}>
          {rowCount}
        </T>
      </Chip>
      <Chip interactive>
        Overrides only
        <T kind="mono-sm" color="var(--ink-4)" style={{ marginLeft: 4 }}>
          {overrideCount}
        </T>
      </Chip>
      <Chip leading={<Icon.Filter size={11} />} interactive>
        Group: agents ▾
      </Chip>
      <span style={{ flex: 1 }} />
      <HStack gap={10}>
        <T kind="caption" color="var(--ink-3)">
          LEGEND
        </T>
        <HStack gap={4}>
          <span
            aria-hidden="true"
            style={{
              width: 14,
              height: 14,
              background: 'var(--accent-soft)',
              border: '1px solid var(--accent)',
              borderRadius: 2,
            }}
          />
          <T kind="mono-sm" color="var(--ink-3)">
            override
          </T>
        </HStack>
        <T kind="mono-sm" color="var(--ink-3)">
          ↑ inherits
        </T>
      </HStack>
    </div>
  );
}

interface CellProps {
  value: string | null;
  inherited?: string | null;
  wins?: boolean;
}

function Cell({ value, inherited, wins }: CellProps) {
  if (value == null && inherited == null) {
    return (
      <div
        style={{
          padding: '8px 12px',
          color: 'var(--ink-4)',
          textAlign: 'center',
          opacity: 0.4,
          borderLeft: '1px solid var(--line)',
        }}
      >
        —
      </div>
    );
  }
  const isOverride = value != null;
  return (
    <div
      style={{
        padding: '8px 12px',
        background: wins ? 'var(--accent-soft)' : 'transparent',
        borderLeft: '1px solid var(--line)',
        borderTop: wins ? '1px solid var(--accent)' : undefined,
        borderBottom: wins ? '1px solid var(--accent)' : undefined,
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        minHeight: 38,
      }}
    >
      <T
        kind="mono-sm"
        color={isOverride ? 'var(--ink)' : 'var(--ink-3)'}
        style={{
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontStyle: isOverride ? 'normal' : 'italic',
        }}
      >
        {isOverride ? value : `↑ ${inherited}`}
      </T>
      {wins && (
        <Badge tone="accent" size="sm" variant="solid">
          override
        </Badge>
      )}
    </div>
  );
}

function Rows({
  rows,
  repos,
  colsTemplate,
}: {
  rows: MatrixRow[];
  repos: string[];
  colsTemplate: string;
}) {
  const elements: ReactElement[] = [];
  let lastGroup: string | null = null;
  rows.forEach((r, ix) => {
    if (r.group !== lastGroup) {
      elements.push(
        <div
          key={`group-${r.group}`}
          style={{
            padding: '10px 14px',
            background: 'var(--paper-2)',
            borderBottom: '1px solid var(--line)',
            borderTop: lastGroup ? '1px solid var(--line-2)' : undefined,
          }}
        >
          <T kind="caption" color="var(--ink-2)" style={{ fontWeight: 600, letterSpacing: '0.08em' }}>
            {r.group}
          </T>
        </div>,
      );
      lastGroup = r.group;
    }
    elements.push(
      <div
        key={`row-${ix}`}
        style={{
          display: 'grid',
          gridTemplateColumns: colsTemplate,
          borderBottom: '1px solid var(--line)',
          alignItems: 'stretch',
        }}
      >
        <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <T kind="body-sm" style={{ fontWeight: 500, display: 'block' }}>
            {r.label}
          </T>
          <T kind="mono-sm" color="var(--ink-3)" style={{ display: 'block' }}>
            {r.key}
          </T>
        </div>
        <Cell value={r.def} inherited={null} />
        {repos.map((rc) => {
          const v = r.vals[rc];
          return <Cell key={rc} value={v ?? null} inherited={v == null ? r.def : null} wins={v != null && r.def != null} />;
        })}
        <div
          style={{
            padding: '10px 8px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderLeft: '1px solid var(--line)',
          }}
        >
          <Icon.More size={13} style={{ color: 'var(--ink-4)' }} />
        </div>
      </div>,
    );
  });
  return <>{elements}</>;
}
