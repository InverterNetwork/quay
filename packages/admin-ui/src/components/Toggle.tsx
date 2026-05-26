import type { CSSProperties, ReactNode } from 'react';
import { TONES, type Tone } from '../styles/tones';
import { T } from './Typography';

interface ToggleProps {
  checked?: boolean;
  onChange?: (next: boolean) => void;
  label?: ReactNode;
  tone?: Tone;
  style?: CSSProperties;
  disabled?: boolean;
}

export function Toggle({ checked = false, onChange, label, tone = 'accent', style, disabled }: ToggleProps) {
  const t = TONES[tone];
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: 0,
        background: 'transparent',
        border: 0,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        ...style,
      }}
    >
      <span
        style={{
          position: 'relative',
          width: 28,
          height: 16,
          background: checked ? t.dot : 'var(--line-2)',
          borderRadius: 999,
          transition: 'background 120ms',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: checked ? 14 : 2,
            width: 12,
            height: 12,
            borderRadius: '50%',
            background: '#fff',
            boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
            transition: 'left 120ms',
          }}
        />
      </span>
      {label && <T kind="body-sm">{label}</T>}
    </button>
  );
}
