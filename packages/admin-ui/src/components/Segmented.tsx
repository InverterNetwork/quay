import type { CSSProperties, ReactNode } from 'react';

export interface SegmentedOption<V extends string> {
  value: V;
  label: ReactNode;
  leading?: ReactNode;
}

interface SegmentedProps<V extends string> {
  value: V;
  options: SegmentedOption<V>[];
  onChange?: (next: V) => void;
  style?: CSSProperties;
}

export function Segmented<V extends string>({ value, options, onChange, style }: SegmentedProps<V>) {
  return (
    <span
      role="tablist"
      style={{
        display: 'inline-flex',
        background: 'var(--surface-2)',
        border: '1px solid var(--line-2)',
        borderRadius: 'var(--r-sm)',
        padding: 2,
        gap: 2,
        ...style,
      }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange?.(o.value)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '4px 10px',
              fontFamily: 'var(--sans)',
              fontSize: 12,
              fontWeight: 500,
              color: active ? 'var(--ink)' : 'var(--ink-3)',
              background: active ? 'var(--surface)' : 'transparent',
              border: `1px solid ${active ? 'var(--line)' : 'transparent'}`,
              borderRadius: 'var(--r-xs)',
              cursor: 'pointer',
            }}
          >
            {o.leading}
            {o.label}
          </button>
        );
      })}
    </span>
  );
}
