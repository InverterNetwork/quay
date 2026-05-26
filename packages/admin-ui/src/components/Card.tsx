import type { CSSProperties, ReactNode } from 'react';

interface CardProps {
  padding?: number;
  raised?: boolean;
  accent?: boolean;
  style?: CSSProperties;
  children?: ReactNode;
  id?: string;
}

export function Card({ children, padding = 16, raised, accent, style, id }: CardProps) {
  return (
    <div
      id={id}
      style={{
        background: 'var(--surface)',
        border: `1px solid ${accent ? 'var(--accent-line)' : 'var(--line)'}`,
        borderRadius: 'var(--r-lg)',
        padding,
        boxShadow: raised ? 'var(--shadow-md)' : 'none',
        ...style,
      }}
    >
      {children}
    </div>
  );
}
