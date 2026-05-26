import { useState } from 'react';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Overlay } from '../components/Overlay';
import { HStack } from '../components/Stack';
import { T } from '../components/Typography';
import { Icon } from '../icons/Icon';
import type { PreambleSummary } from '../store/data';

interface PreambleDrawerProps {
  kind: 'worker' | 'reviewer';
  preamble: PreambleSummary;
  onClose: () => void;
}

const TABS = ['Edit', 'Diff vs v2', 'Versions', 'Used by'] as const;
type Tab = (typeof TABS)[number];

interface PreambleVersion {
  v: number;
  ts: string;
  who: string;
  msg: string;
  refs: number;
  current?: boolean;
}

export function PreambleDrawer({ kind: _kind, preamble, onClose }: PreambleDrawerProps) {
  const [tab, setTab] = useState<Tab>('Edit');
  const versions: PreambleVersion[] = [
    {
      v: preamble.version,
      ts: preamble.lastEdited ?? 'not yet stored',
      who: 'quay',
      msg: 'Current read-only Admin API version.',
      refs: preamble.refs,
      current: true,
    },
  ];

  return (
    <Overlay intensity={0.4} onDismiss={onClose} align="right" ariaLabel={`${preamble.title} drawer`}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        style={{
          width: 720,
          height: '100vh',
          background: 'var(--paper)',
          borderLeft: '1px solid var(--line)',
          boxShadow: '-12px 0 32px rgba(14, 14, 12, 0.18)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          animation: 'cv2-drawer-in 200ms cubic-bezier(0.2, 0.8, 0.2, 1)',
        }}
      >
        <Header preamble={preamble} onClose={onClose} />
        <Tabs tab={tab} onTab={setTab} />
        <Body tab={tab} preamble={preamble} versions={versions} />
        <Footer preamble={preamble} onClose={onClose} />
      </div>
    </Overlay>
  );
}

function Header({ preamble, onClose }: { preamble: PreambleSummary; onClose: () => void }) {
  return (
    <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)', background: 'var(--paper)' }}>
      <HStack gap={10} style={{ marginBottom: 8 }}>
        <Icon.Anchor size={15} style={{ color: 'var(--accent)' }} />
        <T id="drawer-title" as="h2" kind="h2" style={{ letterSpacing: '-0.018em' }}>
          {preamble.title}
        </T>
        <Badge tone="accent" size="md">
          v{preamble.version}
        </Badge>
        <Badge tone="neutral" size="md" variant="outline">
          global
        </Badge>
        <Badge tone="neutral" size="md" variant="outline">
          kind={preamble.kind}
        </Badge>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close drawer">
          <Icon.X size={14} />
        </Button>
      </HStack>
      <HStack gap={12}>
        <T kind="mono-sm" color="var(--ink-3)">
          preambles.preamble_id={preamble.version}
        </T>
        <T kind="mono-sm" color="var(--ink-4)">
          ·
        </T>
        <T kind="mono-sm" color="var(--ink-3)">
          {preamble.refs} attempts reference this version
        </T>
        <T kind="mono-sm" color="var(--ink-4)">
          ·
        </T>
        <T kind="mono-sm" color="var(--ink-3)">
          last edited {preamble.lastEdited ?? 'not yet stored'}
        </T>
      </HStack>
    </div>
  );
}

function Tabs({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  return (
    <div
      role="tablist"
      style={{
        display: 'flex',
        gap: 14,
        padding: '0 22px',
        borderBottom: '1px solid var(--line)',
        background: 'var(--paper)',
      }}
    >
      {TABS.map((label) => {
        const active = label === tab;
        return (
          <button
            key={label}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onTab(label)}
            style={{
              padding: '10px 0',
              borderBottom: active ? '2px solid var(--ink)' : '2px solid transparent',
              background: 'transparent',
              border: 0,
              borderRadius: 0,
              cursor: 'pointer',
            }}
          >
            <T
              kind="body-sm"
              style={{
                fontWeight: active ? 600 : 500,
                color: active ? 'var(--ink)' : 'var(--ink-3)',
              }}
            >
              {label}
            </T>
          </button>
        );
      })}
    </div>
  );
}

function Body({ tab, preamble, versions }: { tab: Tab; preamble: PreambleSummary; versions: PreambleVersion[] }) {
  const metrics = preambleMetrics(preamble.body);
  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      <div style={{ flex: 1, padding: '14px 22px', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div
          style={{
            flex: 1,
            overflow: 'auto',
            background: 'var(--surface)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--r-md)',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              padding: '6px 12px',
              borderBottom: '1px solid var(--line)',
              background: 'var(--surface-2)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Icon.Anchor size={11} style={{ color: 'var(--ink-3)' }} />
            <T kind="mono-sm" color="var(--ink-3)">
              preamble.md · {formatCount(metrics.bytes)} bytes · {formatCount(metrics.lines)} lines ·{' '}
              {formatCount(metrics.rules)} rules
            </T>
            <span style={{ flex: 1 }} />
            <T kind="mono-sm" color="var(--accent-ink)">
              read-only
            </T>
          </div>
          {tab === 'Edit' && <EditorView preamble={preamble} />}
          {tab === 'Diff vs v2' && (
            <div style={{ padding: 24 }}>
              <T kind="body" color="var(--ink-3)">
                Diff view — not yet designed. See README.
              </T>
            </div>
          )}
          {tab === 'Versions' && (
            <div style={{ padding: 24 }}>
              <T kind="body" color="var(--ink-3)">
                See the versions rail on the right.
              </T>
            </div>
          )}
          {tab === 'Used by' && (
            <div style={{ padding: 24 }}>
              <T kind="body" color="var(--ink-3)">
                Used-by view — not yet designed. See README.
              </T>
            </div>
          )}
        </div>
      </div>
      <VersionsRail versions={versions} />
    </div>
  );
}

function EditorView({ preamble }: { preamble: PreambleSummary }) {
  return (
    <div
      style={{
        flex: 1,
        padding: '10px 0',
        overflow: 'auto',
        fontFamily: 'var(--mono)',
        fontSize: 12.5,
        lineHeight: 1.65,
      }}
    >
      {preamble.body.split('\n').map((line, i) => (
        <div key={i} style={{ display: 'flex', minHeight: 22 }}>
          <span
            style={{
              width: 38,
              color: 'var(--ink-4)',
              textAlign: 'right',
              padding: '0 12px 0 8px',
              userSelect: 'none',
              fontSize: 11,
            }}
          >
            {line.trim() ? i + 1 : ''}
          </span>
          <span
            style={{
              flex: 1,
              color: line.match(/^\d+\./) ? 'var(--ink)' : 'var(--ink-2)',
              whiteSpace: 'pre-wrap',
              paddingRight: 16,
              fontWeight: line.match(/^\d+\./) ? 500 : 400,
            }}
          >
            {line || ' '}
          </span>
        </div>
      ))}
    </div>
  );
}

function VersionsRail({ versions }: { versions: PreambleVersion[] }) {
  return (
    <div
      style={{
        width: 220,
        borderLeft: '1px solid var(--line)',
        background: 'var(--paper)',
        padding: '14px 14px',
        overflow: 'auto',
      }}
    >
      <HStack gap={6}>
        <T kind="caption">VERSIONS</T>
        <T kind="mono-sm" color="var(--ink-4)">
          {versions.length}
        </T>
      </HStack>
      <T kind="mono-sm" color="var(--ink-3)" style={{ display: 'block', marginTop: 2 }}>
        append-only
      </T>
      <div style={{ position: 'relative', marginTop: 12 }}>
        <div
          aria-hidden="true"
          style={{ position: 'absolute', left: 11, top: 8, bottom: 8, width: 1, background: 'var(--line)' }}
        />
        {versions.map((v) => (
          <div key={v.v} style={{ display: 'flex', gap: 8, padding: '6px 0', position: 'relative' }}>
            <div
              style={{
                width: 22,
                height: 22,
                borderRadius: '50%',
                flexShrink: 0,
                background: v.current ? 'var(--accent-soft)' : 'var(--surface)',
                border: `1px solid ${v.current ? 'var(--accent-line)' : 'var(--line-2)'}`,
                color: v.current ? 'var(--accent-ink)' : 'var(--ink-3)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: 'var(--mono)',
                fontSize: 10,
                fontWeight: 600,
                zIndex: 1,
              }}
            >
              v{v.v}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <HStack gap={5}>
                <T kind="body-sm" style={{ fontWeight: 500 }}>
                  {v.who}
                </T>
                {v.current && (
                  <Badge tone="accent" size="sm">
                    cur
                  </Badge>
                )}
              </HStack>
              <T kind="mono-sm" color="var(--ink-4)" style={{ display: 'block' }}>
                {v.ts}
              </T>
              <T
                kind="body-sm"
                color="var(--ink-2)"
                style={{ display: 'block', marginTop: 3, lineHeight: 1.35, fontSize: 12 }}
              >
                {v.msg}
              </T>
              <T kind="mono-sm" color="var(--ink-3)" style={{ display: 'block', marginTop: 2 }}>
                {v.refs} ref
              </T>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Footer({ preamble, onClose }: { preamble: PreambleSummary; onClose: () => void }) {
  const metrics = preambleMetrics(preamble.body);
  return (
    <div
      style={{
        padding: '12px 22px',
        borderTop: '1px solid var(--line)',
        background: 'var(--paper-2)',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <T kind="mono-sm" color="var(--ink-3)">
        tokens {formatCount(metrics.tokens)}
      </T>
      <T kind="mono-sm" color="var(--ink-4)">
        ·
      </T>
      <T kind="mono-sm" color="var(--ink-3)">
        {formatCount(metrics.bytes)} bytes
      </T>
      <span style={{ flex: 1 }} />
      <Button variant="primary" size="md" onClick={onClose}>
        Close
      </Button>
    </div>
  );
}

function preambleMetrics(body: string) {
  const lines = body.split('\n');
  return {
    bytes: body.length,
    lines: lines.length,
    rules: lines.filter((line) => /^\s*\d+[.)]\s+/.test(line)).length,
    tokens: Math.ceil(body.length / 4),
  };
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}
