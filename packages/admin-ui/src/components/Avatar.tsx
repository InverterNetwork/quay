import type { CSSProperties } from 'react';
import { TONES, type Tone } from '../styles/tones';

interface AvatarProps {
  name?: string;
  size?: number;
  tone?: Tone;
  style?: CSSProperties;
}

export function Avatar({ name = '?', size = 24, tone = 'neutral', style }: AvatarProps) {
  const initial = (name || '?')
    .split(' ')
    .map((s) => s[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const t = TONES[tone];
  return (
    <span
      aria-label={`avatar for ${name}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: '50%',
        background: t.bg,
        color: t.fg,
        fontFamily: 'var(--sans)',
        fontSize: Math.round(size * 0.42),
        fontWeight: 600,
        border: `1px solid ${t.line}`,
        ...style,
      }}
    >
      {initial}
    </span>
  );
}
