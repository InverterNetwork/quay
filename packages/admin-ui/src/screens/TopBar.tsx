import { Avatar } from '../components/Avatar';
import { Divider } from '../components/Divider';
import { Input } from '../components/Input';
import { Kbd } from '../components/Kbd';
import { HStack } from '../components/Stack';
import { StatusDot } from '../components/StatusDot';
import { T } from '../components/Typography';
import { QuayWordmark } from '../components/Brand';
import { Icon } from '../icons/Icon';
import { Button } from '../components/Button';
import type { Tone } from '../styles/tones';

interface BackendStatus {
  tone: Tone;
  label: string;
  pulse?: boolean;
}

interface TopBarProps {
  scope: string;
  mode: 'light' | 'dark';
  backendStatus: BackendStatus;
  onModeToggle: () => void;
}

export function TopBar({ scope, mode, backendStatus, onModeToggle }: TopBarProps) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        height: 56,
        padding: '0 20px',
        background: 'var(--paper)',
        borderBottom: '1px solid var(--line)',
        flexShrink: 0,
      }}
    >
      <QuayWordmark size={20} />
      <HStack gap={6} style={{ marginLeft: 4 }}>
        <T kind="mono-sm" color="var(--ink-3)">
          prod
        </T>
        <T kind="mono-sm" color="var(--ink-4)">
          /
        </T>
        <T kind="mono-sm" color="var(--ink-3)">
          configuration
        </T>
        <T kind="mono-sm" color="var(--ink-4)">
          /
        </T>
        <T kind="mono-sm" color="var(--ink)">
          {scope}
        </T>
      </HStack>
      <span style={{ flex: 1 }} />
      <HStack gap={6}>
        <StatusDot tone={backendStatus.tone} label={backendStatus.label} pulse={backendStatus.pulse} />
        <T kind="mono-sm" color="var(--ink-3)">
          {backendStatus.label}
        </T>
      </HStack>
      <Divider vertical style={{ height: 24 }} />
      <Input
        placeholder="Find setting, repo, prompt…"
        leading={<Icon.Search size={13} />}
        trailing={<Kbd>⌘K</Kbd>}
        shellStyle={{ width: 280 }}
      />
      <Button
        variant="ghost"
        size="sm"
        onClick={onModeToggle}
        aria-label={`Switch to ${mode === 'light' ? 'dark' : 'light'} mode`}
      >
        {mode === 'light' ? <Icon.Moon size={14} /> : <Icon.Sun size={14} />}
      </Button>
      <Avatar name="Mira Tonio" size={28} tone="accent" />
    </header>
  );
}
