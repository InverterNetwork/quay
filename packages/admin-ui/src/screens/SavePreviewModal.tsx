import { useEffect, useMemo, useState } from 'react';
import { applyChanges, previewChanges, QuayAdminRequestError } from '../api/quayAdmin';
import type { QuayAdminChangePreview } from '../api/quayAdmin';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Overlay } from '../components/Overlay';
import { HStack } from '../components/Stack';
import { T } from '../components/Typography';
import { Icon } from '../icons/Icon';
import type { ChangeEntry } from '../store/dirty';

interface SavePreviewModalProps {
  baseRevision: string;
  changes: ChangeEntry[];
  onCancel: () => void;
  onApplied: () => void;
  onReloadRequired: () => void;
}

type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; preview: QuayAdminChangePreview }
  | { status: 'error'; message: string; code: string };

export function SavePreviewModal({
  baseRevision,
  changes,
  onCancel,
  onApplied,
  onReloadRequired,
}: SavePreviewModalProps) {
  const [previewState, setPreviewState] = useState<PreviewState>({ status: 'loading' });
  const [applying, setApplying] = useState(false);
  const adminChanges = useMemo(() => changes.map((change) => change.change), [changes]);
  const isStale = previewState.status === 'error' && previewState.code === 'stale_revision';

  useEffect(() => {
    const controller = new AbortController();
    setPreviewState({ status: 'loading' });
    previewChanges(baseRevision, adminChanges, controller.signal)
      .then((preview) => setPreviewState({ status: 'ready', preview }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setPreviewState({
          status: 'error',
          code: err instanceof QuayAdminRequestError ? err.code : 'preview_failed',
          message: err instanceof Error ? err.message : 'Preview request failed.',
        });
      });
    return () => controller.abort();
  }, [adminChanges, baseRevision]);

  function apply() {
    const controller = new AbortController();
    setApplying(true);
    applyChanges(baseRevision, adminChanges, controller.signal)
      .then(() => onApplied())
      .catch((err: unknown) => {
        setPreviewState({
          status: 'error',
          code: err instanceof QuayAdminRequestError ? err.code : 'apply_failed',
          message: err instanceof Error ? err.message : 'Apply request failed.',
        });
      })
      .finally(() => setApplying(false));
  }

  return (
    <Overlay intensity={0.45} onDismiss={onCancel} topOffset={60} ariaLabel="Review changes">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-modal-title"
        style={{
          width: 820,
          background: 'var(--paper)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--r-xl)',
          boxShadow: '0 24px 60px rgba(14, 14, 12, 0.28)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          maxHeight: '90vh',
          animation: 'cv2-modal-in 160ms ease-out',
        }}
      >
        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--line)' }}>
          <HStack gap={10} align="baseline">
            <T id="save-modal-title" as="h2" kind="h2" style={{ letterSpacing: '-0.018em' }}>
              Review changes
            </T>
            <Badge tone="accent" size="md">
              server preview
            </Badge>
            <Badge tone="warn" size="sm">
              {changes.length} change{changes.length === 1 ? '' : 's'}
            </Badge>
            <span style={{ flex: 1 }} />
            <T kind="mono-sm" color="var(--ink-3)">
              {shortRevision(baseRevision)}
            </T>
          </HStack>
        </div>

        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14, overflow: 'auto', flex: 1 }}>
          <T kind="caption">SUBMITTED CHANGES</T>
          {changes.map((change) => (
            <div
              key={change.id}
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--line)',
                borderRadius: 'var(--r-sm)',
                padding: 14,
              }}
            >
              <HStack gap={8} style={{ marginBottom: 8 }}>
                <T kind="mono" style={{ fontWeight: 500 }}>
                  {change.label}
                </T>
                <Badge tone="neutral" size="sm" variant="outline">
                  {change.scope}
                </Badge>
              </HStack>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 24px 1fr',
                  gap: 10,
                  alignItems: 'center',
                }}
              >
                <ValueBox label="before" value={change.before} tone="danger" />
                <Icon.Arrow size={14} dir="right" style={{ color: 'var(--ink-4)', justifySelf: 'center' }} />
                <ValueBox label="after" value={change.after} tone="good" />
              </div>
            </div>
          ))}

          <T kind="caption" style={{ marginTop: 4 }}>
            SERVER PREVIEW
          </T>
          {previewState.status === 'loading' && (
            <T kind="body-sm" color="var(--ink-3)">
              Generating preview from Quay Admin API...
            </T>
          )}
          {previewState.status === 'error' && (
            <div
              style={{
                padding: 14,
                background: isStale ? 'var(--warn-soft)' : 'var(--danger-soft)',
                border: `1px solid ${isStale ? 'var(--warn-line)' : 'var(--danger-line)'}`,
                borderRadius: 'var(--r-sm)',
              }}
            >
              <HStack gap={8} style={{ marginBottom: 6 }}>
                <Icon.Alert size={14} style={{ color: isStale ? 'var(--warn-ink)' : 'var(--danger-ink)' }} />
                <T kind="mono" style={{ fontWeight: 500, color: isStale ? 'var(--warn-ink)' : 'var(--danger-ink)' }}>
                  {previewState.code}
                </T>
              </HStack>
              <T kind="body-sm" color="var(--ink-2)" style={{ lineHeight: 1.45 }}>
                {previewState.message}
              </T>
            </div>
          )}
          {previewState.status === 'ready' && (
            <div style={{ display: 'grid', gap: 10 }}>
              {previewState.preview.summary.map((line) => (
                <div
                  key={line}
                  style={{
                    padding: '10px 12px',
                    background: 'var(--surface)',
                    border: '1px solid var(--line)',
                    borderRadius: 'var(--r-sm)',
                  }}
                >
                  <T kind="body-sm" style={{ lineHeight: 1.45 }}>
                    {line}
                  </T>
                </div>
              ))}
              <T kind="mono-sm" color="var(--ink-3)">
                {previewState.preview.operations.length} operation
                {previewState.preview.operations.length === 1 ? '' : 's'} validated
              </T>
            </div>
          )}
        </div>

        <div
          style={{
            padding: '14px 22px',
            borderTop: '1px solid var(--line)',
            background: 'var(--paper-2)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          {isStale && (
            <Button variant="secondary" size="md" leading={<Icon.Refresh size={13} />} onClick={onReloadRequired}>
              Reload
            </Button>
          )}
          <span style={{ flex: 1 }} />
          <Button variant="ghost" size="md" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={apply}
            disabled={changes.length === 0 || previewState.status !== 'ready' || applying}
          >
            {applying ? 'Applying...' : `Apply ${changes.length} change${changes.length === 1 ? '' : 's'}`}
          </Button>
        </div>
      </div>
    </Overlay>
  );
}

function ValueBox({ label, value, tone }: { label: string; value: string; tone: 'danger' | 'good' }) {
  return (
    <div
      style={{
        padding: '6px 12px',
        background: `var(--${tone}-soft)`,
        border: `1px solid var(--${tone}-line)`,
        borderRadius: 'var(--r-xs)',
      }}
    >
      <T kind="mono-sm" color="var(--ink-3)" style={{ display: 'block' }}>
        {label}
      </T>
      <T
        kind="mono-md"
        style={{
          display: 'block',
          marginTop: 2,
          color: `var(--${tone}-ink)`,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {value}
      </T>
    </div>
  );
}

function shortRevision(revision: string): string {
  if (revision.startsWith('sha256:')) return `rev ${revision.slice(7, 15)}`;
  return revision === '' ? 'revision unavailable' : `rev ${revision.slice(0, 8)}`;
}
