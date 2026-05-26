import type { CSSProperties, ElementType, ReactNode } from 'react';

export type TypoKind =
  | 'display'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'body'
  | 'body-sm'
  | 'body-strong'
  | 'small'
  | 'caption'
  | 'mono'
  | 'mono-sm'
  | 'mono-md'
  | 'serif-display'
  | 'serif-h';

interface TProps {
  as?: ElementType;
  kind?: TypoKind;
  color?: string;
  style?: CSSProperties;
  className?: string;
  children?: ReactNode;
  id?: string;
}

const variants: Record<TypoKind, CSSProperties> = {
  display:        { fontFamily: 'var(--serif)', fontSize: 56, lineHeight: 1.05, fontWeight: 400, letterSpacing: '-0.025em', fontStyle: 'italic' },
  h1:             { fontFamily: 'var(--sans)',  fontSize: 32, lineHeight: 1.18, fontWeight: 600, letterSpacing: '-0.022em' },
  h2:             { fontFamily: 'var(--sans)',  fontSize: 22, lineHeight: 1.25, fontWeight: 600, letterSpacing: '-0.018em' },
  h3:             { fontFamily: 'var(--sans)',  fontSize: 16, lineHeight: 1.35, fontWeight: 600, letterSpacing: '-0.012em' },
  h4:             { fontFamily: 'var(--sans)',  fontSize: 14, lineHeight: 1.4,  fontWeight: 600, letterSpacing: '-0.005em' },
  body:           { fontFamily: 'var(--sans)',  fontSize: 14, lineHeight: 1.5,  fontWeight: 400 },
  'body-sm':      { fontFamily: 'var(--sans)',  fontSize: 13, lineHeight: 1.5,  fontWeight: 400 },
  'body-strong':  { fontFamily: 'var(--sans)',  fontSize: 14, lineHeight: 1.5,  fontWeight: 500 },
  small:          { fontFamily: 'var(--sans)',  fontSize: 12, lineHeight: 1.45, fontWeight: 400 },
  caption:        { fontFamily: 'var(--sans)',  fontSize: 11, lineHeight: 1.4,  fontWeight: 500, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--ink-3)' },
  mono:           { fontFamily: 'var(--mono)',  fontSize: 12, lineHeight: 1.5,  fontWeight: 400, fontFeatureSettings: '"zero","ss01"' },
  'mono-sm':      { fontFamily: 'var(--mono)',  fontSize: 11, lineHeight: 1.4,  fontWeight: 400, fontFeatureSettings: '"zero","ss01"' },
  'mono-md':      { fontFamily: 'var(--mono)',  fontSize: 13, lineHeight: 1.5,  fontWeight: 400 },
  'serif-display':{ fontFamily: 'var(--serif)', fontSize: 36, lineHeight: 1.1,  fontWeight: 400, letterSpacing: '-0.02em', fontStyle: 'italic' },
  'serif-h':      { fontFamily: 'var(--serif)', fontSize: 22, lineHeight: 1.2,  fontWeight: 400, fontStyle: 'italic' },
};

export function T({ as: Tag = 'span', kind = 'body', color, style, className, children, id }: TProps) {
  const variant = variants[kind];
  return (
    <Tag
      id={id}
      className={className}
      style={{
        display: 'inline',
        color: color ?? variant.color ?? 'inherit',
        ...variant,
        ...(color ? { color } : null),
        ...style,
      }}
    >
      {children}
    </Tag>
  );
}
