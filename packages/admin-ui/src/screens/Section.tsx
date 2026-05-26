import type { ReactNode } from 'react';
import { HStack } from '../components/Stack';
import { T } from '../components/Typography';
import { Card } from '../components/Card';

interface SectionProps {
  n: string;
  id: string;
  title: string;
  hint?: string;
  right?: ReactNode;
  children?: ReactNode;
  narrow?: boolean;
}

export function Section({ n, id, title, hint, right, children, narrow }: SectionProps) {
  return (
    <section
      id={id}
      style={{
        marginBottom: 32,
        scrollMarginTop: 80,
        maxWidth: narrow ? 720 : 'none',
      }}
    >
      <HStack gap={12} align="baseline" style={{ marginBottom: 14 }}>
        <T kind="mono" color="var(--ink-4)" style={{ fontSize: 12, letterSpacing: '0.04em' }}>
          {n}
        </T>
        <T as="h2" kind="h2" style={{ letterSpacing: '-0.018em' }}>
          {title}
        </T>
        {hint && (
          <T kind="body-sm" color="var(--ink-3)">
            {hint}
          </T>
        )}
        <span style={{ flex: 1 }} />
        {right}
      </HStack>
      {children}
    </section>
  );
}

interface SubGroupProps {
  title: string;
  hint?: string;
  columns?: number;
  children?: ReactNode;
}

export function SubGroup({ title, hint, columns = 2, children }: SubGroupProps) {
  return (
    <Card padding={20} style={{ marginBottom: 12 }}>
      <HStack gap={10} align="baseline" style={{ marginBottom: 14 }}>
        <T as="h3" kind="h4">
          {title}
        </T>
        {hint && (
          <T kind="mono-sm" color="var(--ink-3)">
            · {hint}
          </T>
        )}
      </HStack>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${columns}, 1fr)`,
          gap: 14,
        }}
      >
        {children}
      </div>
    </Card>
  );
}
