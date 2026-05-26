import type { CSSProperties, ReactNode } from 'react';
import { TONES, type Tone } from '../styles/tones';
import { Icon } from '../icons/Icon';

interface ChipProps {
  tone?: Tone;
  leading?: ReactNode;
  trailing?: ReactNode;
  onRemove?: () => void;
  onClick?: () => void;
  interactive?: boolean;
  selected?: boolean;
  style?: CSSProperties;
  children?: ReactNode;
  title?: string;
}

export function Chip({
  children,
  tone = 'neutral',
  leading,
  trailing,
  onRemove,
  onClick,
  interactive,
  selected,
  style,
  title,
}: ChipProps) {
  const t = TONES[tone];
  const isInteractive = interactive ?? Boolean(onClick);
  return (
    <span
      title={title}
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        height: 22,
        padding: '0 8px',
        fontFamily: 'var(--sans)',
        fontSize: 12,
        fontWeight: 500,
        color: selected ? t.fg : 'var(--ink-2)',
        background: selected ? t.bg : 'var(--surface)',
        border: `1px solid ${selected ? t.line : 'var(--line-2)'}`,
        borderRadius: 'var(--r-sm)',
        cursor: isInteractive ? 'pointer' : 'default',
        ...style,
      }}
    >
      {leading}
      {children}
      {trailing}
      {onRemove && (
        <button
          type="button"
          aria-label="remove"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            border: 0,
            background: 'transparent',
            color: 'var(--ink-3)',
            cursor: 'pointer',
          }}
        >
          <Icon.X size={11} />
        </button>
      )}
    </span>
  );
}
