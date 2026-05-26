import type { CSSProperties, ReactNode } from 'react';

interface StackBase {
  gap?: number;
  align?: CSSProperties['alignItems'];
  justify?: CSSProperties['justifyContent'];
  wrap?: boolean;
  style?: CSSProperties;
  children?: ReactNode;
  className?: string;
}

export function HStack({ gap = 8, align = 'center', justify, wrap, style, children, className }: StackBase) {
  return (
    <div
      className={className}
      style={{
        display: 'flex',
        alignItems: align,
        gap,
        justifyContent: justify,
        flexWrap: wrap ? 'wrap' : 'nowrap',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function VStack({ gap = 8, align = 'stretch', justify, style, children, className }: StackBase) {
  return (
    <div
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap,
        alignItems: align,
        justifyContent: justify,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
