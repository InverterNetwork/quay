import { useEffect, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { Overlay } from '../components/Overlay';
import { HStack } from '../components/Stack';
import { T } from '../components/Typography';
import { Icon } from '../icons/Icon';

interface ArchiveConfirmDialogProps {
  repoId: string;
  activeTasks?: number | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ArchiveConfirmDialog({
  repoId,
  activeTasks,
  onCancel,
  onConfirm,
}: ArchiveConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const matches = typed === repoId;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <Overlay intensity={0.5} dismissOnBackdrop={false} onDismiss={onCancel} topOffset={140} ariaLabel="Archive repo">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="archive-title"
        style={{
          width: 540,
          background: 'var(--paper)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--r-xl)',
          boxShadow: '0 24px 60px rgba(14, 14, 12, 0.32)',
          display: 'flex',
          flexDirection: 'column',
          animation: 'cv2-modal-in 160ms ease-out',
        }}
      >
        <div style={{ padding: '20px 22px 14px' }}>
          <HStack gap={10} align="baseline">
            <Icon.Alert size={18} style={{ color: 'var(--danger)' }} />
            <T id="archive-title" as="h2" kind="h2" style={{ letterSpacing: '-0.018em' }}>
              Archive{' '}
              <span style={{ fontFamily: 'var(--mono)' }}>{repoId}</span>?
            </T>
          </HStack>
          <T kind="body" color="var(--ink-2)" style={{ display: 'block', marginTop: 12, lineHeight: 1.55 }}>
            {activeTasks == null
              ? 'Active task counts are not exposed by the read-only Admin API yet. No archive request will be sent from this UI version.'
              : `${activeTasks} active tasks will continue running to completion. No new tasks will spawn from this repo.`}
          </T>
          <T kind="body-sm" color="var(--ink-3)" style={{ display: 'block', marginTop: 8, lineHeight: 1.5 }}>
            This is reversible — archived repos can be restored from the{' '}
            <T
              kind="mono-sm"
              color="var(--ink-3)"
              style={{
                background: 'var(--surface-2)',
                padding: '1px 5px',
                borderRadius: 3,
                border: '1px solid var(--line)',
              }}
            >
              Archived
            </T>{' '}
            section in the left rail.
          </T>
        </div>

        <div style={{ padding: '8px 22px 16px' }}>
          <T kind="caption" color="var(--ink-3)" style={{ display: 'block', marginBottom: 6 }}>
            TYPE THE REPO NAME TO CONFIRM
          </T>
          <div
            style={{
              padding: '8px 12px',
              minHeight: 38,
              background: 'var(--surface)',
              border: `1.5px solid ${matches ? 'var(--good)' : 'var(--danger)'}`,
              borderRadius: 'var(--r-sm)',
              boxShadow: `0 0 0 3px ${matches ? 'var(--good-soft)' : 'var(--danger-soft)'}`,
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <input
              ref={inputRef}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && matches) onConfirm();
              }}
              style={{
                flex: 1,
                fontFamily: 'var(--mono)',
                fontSize: 13,
                color: 'var(--ink)',
                background: 'transparent',
                border: 0,
                outline: 'none',
              }}
            />
            {matches && <Icon.Check size={14} style={{ color: 'var(--good)' }} />}
          </div>
        </div>

        <div
          style={{
            padding: '14px 22px',
            borderTop: '1px solid var(--line)',
            background: 'var(--paper-2)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
          }}
        >
          <Button variant="ghost" size="md" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" size="md" onClick={onConfirm} disabled={!matches}>
            Archive repo
          </Button>
        </div>
      </div>
    </Overlay>
  );
}
