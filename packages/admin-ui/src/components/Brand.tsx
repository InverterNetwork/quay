import type { CSSProperties } from 'react';

interface MarkProps {
  size?: number;
  color?: string;
  style?: CSSProperties;
}

export function QuayMark({ size = 24, color = 'currentColor', style }: MarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={color}
      style={{ display: 'block', ...style }}
      aria-hidden="true"
    >
      <rect x="2" y="16" width="20" height="2.6" rx="1.3" />
      <rect x="12.5" y="6" width="7.5" height="7.5" rx="1.8" />
    </svg>
  );
}

export function QuayWordmark({ size = 22, color = 'currentColor', style }: MarkProps) {
  return (
    <span
      style={{
        fontFamily: 'var(--sans)',
        fontWeight: 600,
        fontSize: size,
        letterSpacing: '-0.012em',
        color,
        lineHeight: 1,
        display: 'inline-flex',
        alignItems: 'center',
        gap: size * 0.36,
        ...style,
      }}
    >
      <QuayMark size={size * 0.92} />
      <span style={{ paddingTop: 1 }}>Quay</span>
    </span>
  );
}
