import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Chip } from '../components/Chip';
import { Divider } from '../components/Divider';
import { HStack } from '../components/Stack';
import { T } from '../components/Typography';
import { Icon } from '../icons/Icon';

interface EmptyScreenProps {
  quayVersion?: string;
  readOnly?: boolean;
  onRegisterRepo: () => void;
}

export function EmptyScreen({ quayVersion, readOnly, onRegisterRepo }: EmptyScreenProps) {
  return (
    <>
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
            Welcome to Quay
          </T>
          <span style={{ flex: 1 }} />
          <T kind="mono-sm" color="var(--ink-3)">
            quay {quayVersion ?? 'version unknown'}
          </T>
        </HStack>
        <T kind="body" color="var(--ink-3)" style={{ maxWidth: 720, lineHeight: 1.55, display: 'block' }}>
          Quay is configured but no repositories are registered yet. Admin API v1 can preview and apply structured
          updates to existing config, but repo registration still happens from the Quay CLI.
        </T>
      </div>

      <div
        style={{
          flex: 1,
          padding: '32px 28px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'flex-start',
          overflow: 'auto',
        }}
      >
        <Card padding={32} style={{ width: 600, textAlign: 'left' }}>
          <T kind="caption" color="var(--accent-ink)" style={{ display: 'block', marginBottom: 8 }}>
            STEP 1
          </T>
          <T as="h2" kind="h2" style={{ letterSpacing: '-0.018em', display: 'block' }}>
            Register your first repo
          </T>
          <T kind="body" color="var(--ink-3)" style={{ display: 'block', marginTop: 8, lineHeight: 1.55 }}>
            Quay creates a bare clone and worktrees on demand. You'll need the repo URL, the base branch, and the
            install / test commands.
          </T>
          <HStack gap={10} style={{ marginTop: 16 }}>
            <Button
              variant="primary"
              leading={<Icon.Plus size={13} />}
              onClick={onRegisterRepo}
              disabled={readOnly}
              title={readOnly ? 'Repo registration is not exposed by Admin API v1' : undefined}
            >
              Register repo
            </Button>
            <Button
              variant="ghost"
              disabled={readOnly}
              title="Repo registration is not exposed by Admin API v1"
            >
              Register in UI
            </Button>
          </HStack>
          <Divider style={{ margin: '24px 0' }} />

          <T kind="caption" color="var(--ink-3)" style={{ display: 'block', marginBottom: 8 }}>
            OR EDIT GLOBAL DEFAULTS FIRST
          </T>
          <HStack gap={6} wrap>
            <Chip leading={<Icon.Bot size={11} />} interactive>
              Default agents
            </Chip>
            <Chip leading={<Icon.Anchor size={11} />} interactive>
              Default prompts
            </Chip>
            <Chip interactive>Default tag vocab</Chip>
            <Chip interactive>Adapters</Chip>
          </HStack>
        </Card>
      </div>
    </>
  );
}
