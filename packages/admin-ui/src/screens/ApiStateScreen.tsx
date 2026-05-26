import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { HStack } from '../components/Stack';
import { T } from '../components/Typography';
import { Icon } from '../icons/Icon';

interface LoadingScreenProps {
  baseUrl: string;
}

export function ApiLoadingScreen({ baseUrl }: LoadingScreenProps) {
  return (
    <div style={{ flex: 1, padding: '32px 28px', background: 'var(--paper-2)' }}>
      <Card padding={24} style={{ maxWidth: 620 }}>
        <HStack gap={10} align="center">
          <Icon.Pulse size={16} style={{ color: 'var(--accent)' }} />
          <T as="h2" kind="h2">
            Connecting to Quay
          </T>
        </HStack>
        <T kind="body" color="var(--ink-3)" style={{ display: 'block', marginTop: 10, lineHeight: 1.55 }}>
          Reading <T kind="mono-sm">{baseUrl}</T>
        </T>
      </Card>
    </div>
  );
}

interface ErrorScreenProps {
  baseUrl: string;
  error: string;
  onRetry: () => void;
}

export function ApiErrorScreen({ baseUrl, error, onRetry }: ErrorScreenProps) {
  return (
    <div style={{ flex: 1, padding: '32px 28px', background: 'var(--paper-2)' }}>
      <Card padding={24} style={{ maxWidth: 720, borderColor: 'var(--danger-line)' }}>
        <HStack gap={10} align="center">
          <Icon.Alert size={16} style={{ color: 'var(--danger)' }} />
          <T as="h2" kind="h2">
            Quay Admin API unavailable
          </T>
          <span style={{ flex: 1 }} />
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Retry
          </Button>
        </HStack>
        <T kind="body" color="var(--ink-2)" style={{ display: 'block', marginTop: 12, lineHeight: 1.55 }}>
          {error}
        </T>
        <div
          style={{
            marginTop: 14,
            padding: '10px 12px',
            background: 'var(--surface-2)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--r-sm)',
          }}
        >
          <T kind="mono-sm" color="var(--ink-2)">
            {baseUrl}
          </T>
        </div>
      </Card>
    </div>
  );
}
