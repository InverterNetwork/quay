import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Chip } from '../components/Chip';
import { HStack } from '../components/Stack';
import { T } from '../components/Typography';
import { Icon } from '../icons/Icon';
import type { PreambleSummary } from '../store/data';

interface PreambleCardProps {
  preamble: PreambleSummary;
  onEdit: () => void;
}

export function PreambleCard({ preamble, onEdit }: PreambleCardProps) {
  const lines = preamble.body.split('\n').length;
  return (
    <Card padding={18} style={{ marginBottom: 14 }}>
      <HStack gap={10} align="baseline" style={{ marginBottom: 10 }}>
        <Icon.Anchor size={14} style={{ color: 'var(--accent)' }} />
        <T as="h3" kind="h4">
          {preamble.title}
        </T>
        <Badge tone="accent" size="sm">
          v{preamble.version}
        </Badge>
        <Badge tone="neutral" size="sm" variant="outline">
          kind={preamble.kind}
        </Badge>
        <span style={{ flex: 1 }} />
        <T kind="mono-sm" color="var(--ink-3)">
          {preamble.refs} attempts ref · last edited {preamble.lastEdited ?? 'not yet stored'}
        </T>
        <Button variant="ghost" size="sm" disabled title="Version history is not exposed by the read-only Admin API v1">
          Versions
        </Button>
        <Button variant="secondary" size="sm" onClick={onEdit}>
          View
        </Button>
      </HStack>

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
          maxHeight: 220,
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <pre style={{ margin: 0, fontFamily: 'inherit', whiteSpace: 'pre-wrap' }}>{preamble.body}</pre>
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: 56,
            background: 'linear-gradient(to bottom, transparent, var(--surface-2))',
            pointerEvents: 'none',
          }}
        />
      </div>
      <HStack gap={6} style={{ marginTop: 10 }}>
        <T kind="mono-sm" color="var(--ink-3)">
          {preamble.body.length} bytes · {lines} lines
        </T>
        <span style={{ flex: 1 }} />
        <T kind="caption" color="var(--ink-3)">
          USED BY
        </T>
        <Chip leading={<Icon.Repo size={11} />}>{preamble.usedByRepos} repos</Chip>
        <Chip tone="accent" selected leading={<Icon.Repo size={11} />}>
          {preamble.overrideRepos} override
        </Chip>
      </HStack>
    </Card>
  );
}
