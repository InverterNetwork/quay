import { useState } from 'react';
import { Button } from '../components/Button';
import { Overlay } from '../components/Overlay';
import { HStack } from '../components/Stack';
import { T } from '../components/Typography';
import { Icon } from '../icons/Icon';
import { Field } from './Field';

interface AddRepoDialogProps {
  onCancel: () => void;
  onSubmit: (repoId: string) => void;
}

export function AddRepoDialog({ onCancel, onSubmit }: AddRepoDialogProps) {
  const [repoId, setRepoId] = useState('acme-billing');
  const [url, setUrl] = useState('git@github.com:acme/billing.git');
  const [baseBranch, setBaseBranch] = useState('main');
  const [pm, setPm] = useState('bun');
  const [installCmd, setInstallCmd] = useState('bun install --frozen-lockfile');
  const [testCmd, setTestCmd] = useState('bun test');

  return (
    <Overlay intensity={0.45} onDismiss={onCancel} topOffset={80} ariaLabel="Register a new repo">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-repo-title"
        style={{
          width: 620,
          background: 'var(--paper)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--r-xl)',
          boxShadow: '0 24px 60px rgba(14, 14, 12, 0.32)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          animation: 'cv2-modal-in 160ms ease-out',
          maxHeight: '90vh',
        }}
      >
        <div style={{ padding: '20px 22px 14px', borderBottom: '1px solid var(--line)' }}>
          <T id="add-repo-title" as="h2" kind="h2" style={{ letterSpacing: '-0.018em' }}>
            Register a new repo
          </T>
          <T kind="body-sm" color="var(--ink-3)" style={{ display: 'block', marginTop: 6, lineHeight: 1.55 }}>
            Inherits global defaults — agent, models, preambles, tag vocab. You can override per-repo settings after
            registration.
          </T>
        </div>

        <div
          style={{
            padding: '18px 22px',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            overflow: 'auto',
            flex: 1,
          }}
        >
          <Field
            label="REPO_ID"
            value={repoId}
            source="repo-only"
            editable
            state="focused"
            helper="lowercase slug · used as the repos table key"
            onCommit={setRepoId}
          />
          <Field label="REPO_URL" value={url} source="repo-only" fullRow editable onCommit={setUrl} />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Field label="BASE_BRANCH" value={baseBranch} source="repo-only" editable onCommit={setBaseBranch} />
            <Field
              label="PACKAGE_MANAGER"
              value={pm}
              source="repo-only"
              editable
              onCommit={setPm}
              suffix={<Icon.Chevron size={11} dir="down" style={{ color: 'var(--ink-3)' }} />}
            />
          </div>
          <Field
            fullRow
            label="INSTALL_CMD"
            value={installCmd}
            source="repo-only"
            hint="autofilled from package_manager"
            editable
            onCommit={setInstallCmd}
          />
          <Field fullRow label="TEST_CMD" value={testCmd} source="repo-only" editable onCommit={setTestCmd} />

          <div
            style={{
              padding: 12,
              background: 'var(--accent-soft)',
              border: '1px solid var(--accent-line)',
              borderRadius: 'var(--r-sm)',
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
            }}
          >
            <Icon.Sparkle size={14} style={{ color: 'var(--accent)', marginTop: 2, flexShrink: 0 }} />
            <div>
              <T kind="body-sm" style={{ fontWeight: 500, display: 'block', color: 'var(--accent-ink)' }}>
                Inherits from Global
              </T>
              <T kind="body-sm" color="var(--ink-2)" style={{ display: 'block', marginTop: 2, lineHeight: 1.45 }}>
                Worker: claude · opus-4-1 · Reviewer: claude · opus-4-1 · Tag vocab: type (required), priority. Add
                overrides after registering.
              </T>
            </div>
          </div>
        </div>

        <div
          style={{
            padding: '14px 22px',
            borderTop: '1px solid var(--line)',
            background: 'var(--paper-2)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <T kind="mono-sm" color="var(--ink-3)">
            runs: quay repo add
          </T>
          <HStack gap={8}>
            <Button variant="ghost" size="md" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="primary" size="md" onClick={() => onSubmit(repoId)} disabled={!repoId.trim()}>
              Register and clone
            </Button>
          </HStack>
        </div>
      </div>
    </Overlay>
  );
}
