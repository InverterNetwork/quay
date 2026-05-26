import type { CSSProperties, ReactNode } from 'react';
import { TONES, type Tone } from '../styles/tones';

export type BadgeVariant = 'soft' | 'outline' | 'solid';
export type BadgeSize = 'sm' | 'md' | 'lg';

interface BadgeProps {
  tone?: Tone;
  variant?: BadgeVariant;
  size?: BadgeSize;
  dot?: boolean;
  style?: CSSProperties;
  children?: ReactNode;
}

const sizes: Record<BadgeSize, { h: number; px: number; fs: number; gap: number }> = {
  sm: { h: 18, px: 6,  fs: 10, gap: 4 },
  md: { h: 22, px: 8,  fs: 11, gap: 5 },
  lg: { h: 26, px: 10, fs: 12, gap: 6 },
};

export function Badge({ children, tone = 'neutral', variant = 'soft', size = 'md', dot, style }: BadgeProps) {
  const t = TONES[tone];
  const s = sizes[size];
  const variantStyles = {
    soft:    { bg: t.bg,            fg: t.fg, border: 'transparent' },
    outline: { bg: 'transparent',   fg: t.fg, border: t.line },
    solid:   { bg: t.dot,           fg: '#fff', border: t.dot },
  }[variant];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: s.gap,
        height: s.h,
        padding: `0 ${s.px}px`,
        fontFamily: 'var(--sans)',
        fontSize: s.fs,
        fontWeight: 500,
        letterSpacing: '0.01em',
        background: variantStyles.bg,
        color: variantStyles.fg,
        border: `1px solid ${variantStyles.border}`,
        borderRadius: 999,
        ...style,
      }}
    >
      {dot && (
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: t.dot,
            flexShrink: 0,
          }}
        />
      )}
      {children}
    </span>
  );
}
