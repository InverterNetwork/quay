import type { ReactNode } from 'react';
import { Avatar } from '../components/Avatar';
import { Divider } from '../components/Divider';
import { HStack } from '../components/Stack';
import { T } from '../components/Typography';
import { Icon } from '../icons/Icon';

export type AppRoute = 'mission-control' | 'configuration';

interface PrimarySidebarProps {
  route: AppRoute;
  missionControlCount: number;
  missionControlAttention: boolean;
  onNavigate: (route: AppRoute) => void;
}

export function PrimarySidebar({
  route,
  missionControlCount,
  missionControlAttention,
  onNavigate,
}: PrimarySidebarProps) {
  return (
    <aside
      style={{
        width: 220,
        padding: '20px 12px',
        background: 'var(--paper)',
        borderRight: '1px solid var(--line)',
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        flexShrink: 0,
      }}
    >
      <T kind="caption" color="var(--ink-3)" style={{ padding: '4px 8px 6px' }}>
        Workspace
      </T>
      <SidebarItem
        active={route === 'mission-control'}
        icon={<Icon.Anchor size={15} />}
        label="Mission Control"
        count={missionControlCount}
        countColor={missionControlAttention ? 'var(--danger)' : 'var(--ink-4)'}
        onClick={() => onNavigate('mission-control')}
      />

      <div style={{ flex: 1 }} />

      <Divider dashed style={{ margin: '8px 0' }} />
      <SidebarItem
        active={route === 'configuration'}
        icon={<Icon.Settings size={15} />}
        label="Configuration"
        onClick={() => onNavigate('configuration')}
      />
      <Divider dashed style={{ margin: '8px 0' }} />
      <HStack gap={10} style={{ padding: '0 8px' }}>
        <Avatar name="Quay Admin" size={22} tone="accent" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <T kind="body-sm" style={{ display: 'block' }}>
            Quay Admin
          </T>
          <T kind="mono-sm" color="var(--ink-3)" style={{ display: 'block' }}>
            local session
          </T>
        </div>
      </HStack>
    </aside>
  );
}

interface SidebarItemProps {
  active: boolean;
  icon: ReactNode;
  label: string;
  count?: number;
  countColor?: string;
  onClick: () => void;
}

function SidebarItem({ active, icon, label, count, countColor, onClick }: SidebarItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        height: 30,
        width: '100%',
        padding: '0 8px',
        borderRadius: 'var(--r-sm)',
        background: active ? 'var(--surface)' : 'transparent',
        border: `1px solid ${active ? 'var(--line)' : 'transparent'}`,
        color: active ? 'var(--ink)' : 'var(--ink-2)',
        cursor: 'pointer',
        textAlign: 'left',
      }}
    >
      <span style={{ display: 'inline-flex', color: active ? 'var(--accent)' : 'var(--ink-3)' }}>{icon}</span>
      <T kind="body-sm" style={{ fontWeight: active ? 500 : 400, flex: 1 }}>
        {label}
      </T>
      {count !== undefined && (
        <T kind="mono-sm" color={countColor ?? 'var(--ink-4)'}>
          {count}
        </T>
      )}
    </button>
  );
}
