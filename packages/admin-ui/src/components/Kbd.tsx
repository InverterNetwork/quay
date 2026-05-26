import type { CSSProperties, ReactNode } from 'react';

interface KbdProps {
  size?: number;
  style?: CSSProperties;
  children?: ReactNode;
}

export function Kbd({ children, size = 11, style }: KbdProps) {
  return (
    <kbd
      style={{
        fontFamily: 'var(--mono)',
        fontSize: size,
        fontWeight: 500,
        padding: '1px 5px',
        borderRadius: 3,
        background: 'var(--surface-2)',
        color: 'var(--ink-3)',
        border: '1px solid var(--line)',
        lineHeight: 1.4,
        ...style,
      }}
    >
      {children}
    </kbd>
  );
}
