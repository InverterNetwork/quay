import { forwardRef } from 'react';
import type { CSSProperties, InputHTMLAttributes, ReactNode } from 'react';

export type InputSize = 'sm' | 'md' | 'lg';

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  leading?: ReactNode;
  trailing?: ReactNode;
  invalid?: boolean;
  shellStyle?: CSSProperties;
  inputSize?: InputSize;
}

const heights: Record<InputSize, number> = { sm: 28, md: 32, lg: 38 };

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { leading, trailing, invalid, inputSize = 'md', shellStyle, style, ...rest },
  ref,
) {
  const height = heights[inputSize];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        height,
        padding: '0 10px',
        background: 'var(--surface)',
        border: `1px solid ${invalid ? 'var(--danger-line)' : 'var(--line-2)'}`,
        borderRadius: 'var(--r-sm)',
        ...shellStyle,
      }}
    >
      {leading && <span style={{ color: 'var(--ink-3)', display: 'inline-flex' }}>{leading}</span>}
      <input
        ref={ref}
        {...rest}
        style={{
          fontFamily: 'var(--sans)',
          fontSize: 13,
          color: 'var(--ink)',
          flex: 1,
          minWidth: 0,
          background: 'transparent',
          border: 0,
          outline: 'none',
          ...style,
        }}
      />
      {trailing}
    </span>
  );
});
