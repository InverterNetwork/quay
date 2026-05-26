import type { CSSProperties } from 'react';
import { TONES, type Tone } from '../styles/tones';

interface StatusDotProps {
  tone?: Tone;
  pulse?: boolean;
  size?: number;
  label?: string;
  style?: CSSProperties;
}

export function StatusDot({ tone = 'good', pulse, size = 8, label, style }: StatusDotProps) {
  const t = TONES[tone];
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ position: 'relative', display: 'inline-flex', width: size, height: size, ...style }}
    >
      <span
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: '50%',
          background: t.dot,
        }}
      />
      {pulse && (
        <span
          style={{
            position: 'absolute',
            inset: -3,
            borderRadius: '50%',
            background: t.dot,
            opacity: 0.25,
            animation: 'hf-pulse 1.8s ease-in-out infinite',
          }}
        />
      )}
    </span>
  );
}
