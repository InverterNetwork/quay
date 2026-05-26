import { Button } from '../components/Button';
import { StatusDot } from '../components/StatusDot';
import { T } from '../components/Typography';

interface SaveFooterProps {
  count: number;
  summary: string;
  onDiscard: () => void;
  onPreview: () => void;
  onSave: () => void;
}

export function SaveFooter({ count, summary, onDiscard, onPreview, onSave }: SaveFooterProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'sticky',
        bottom: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 28px',
        background: 'var(--warn-soft)',
        borderTop: '1px solid var(--warn-line)',
        flexShrink: 0,
        zIndex: 4,
      }}
    >
      <StatusDot tone="warn" />
      <T kind="body-sm" style={{ fontWeight: 500, color: 'var(--warn-ink)' }}>
        {count} unsaved change{count !== 1 ? 's' : ''}
      </T>
      <T kind="mono-sm" color="var(--ink-3)">
        — {summary}
      </T>
      <span style={{ flex: 1 }} />
      <Button variant="ghost" size="md" onClick={onDiscard}>
        Discard
      </Button>
      <Button variant="secondary" size="md" onClick={onPreview}>
        Preview diff
      </Button>
      <Button variant="primary" size="md" onClick={onSave} kbd="⌘↵">
        Save changes
      </Button>
    </div>
  );
}
