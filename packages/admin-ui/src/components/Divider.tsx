import type { CSSProperties } from 'react';

interface DividerProps {
  vertical?: boolean;
  dashed?: boolean;
  style?: CSSProperties;
}

export function Divider({ vertical, dashed, style }: DividerProps) {
  return (
    <div
      aria-hidden="true"
      style={{
        flexShrink: 0,
        width: vertical ? 1 : '100%',
        height: vertical ? '100%' : 1,
        background: dashed ? 'transparent' : 'var(--line)',
        borderLeft: dashed && vertical ? '1px dashed var(--line-2)' : undefined,
        borderTop: dashed && !vertical ? '1px dashed var(--line-2)' : undefined,
        ...style,
      }}
    />
  );
}
