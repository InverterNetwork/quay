import { useState } from 'react';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Segmented } from '../components/Segmented';
import { HStack } from '../components/Stack';
import { T } from '../components/Typography';
import { Icon } from '../icons/Icon';
import { TONES, type Tone } from '../styles/tones';
import type { GuidanceTemplate, PreambleSummary } from '../store/data';

interface PreviewSection {
  tone: Tone;
  label: string;
  src: string;
  body: string;
}

interface ComposedPreviewProps {
  preamble: PreambleSummary | null;
  guidanceTemplates: GuidanceTemplate[];
  repoId: string;
}

export function ComposedPreview({ preamble, guidanceTemplates, repoId }: ComposedPreviewProps) {
  const [reason, setReason] = useState(guidanceTemplates[0]?.reason ?? 'initial');
  const selectedTemplate =
    guidanceTemplates.find((template) => template.reason === reason) ?? guidanceTemplates[0] ?? null;
  const sections = buildSections(preamble, selectedTemplate, repoId);
  return (
    <Card
      padding={0}
      style={{
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        width: 360,
        alignSelf: 'stretch',
      }}
    >
      <div
        style={{
          padding: '12px 14px',
          borderBottom: '1px solid var(--line)',
          background: 'var(--surface-2)',
        }}
      >
        <HStack gap={6}>
          <Icon.Sparkle size={13} style={{ color: 'var(--accent)' }} />
          <T as="h3" kind="h4">
            Composed preview
          </T>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" size="sm">
            Full
          </Button>
        </HStack>
        <T kind="mono-sm" color="var(--ink-3)" style={{ display: 'block', marginTop: 4 }}>
          what a worker sees for this repo
        </T>
      </div>

      <div
        style={{
          padding: '10px 14px',
          borderBottom: '1px solid var(--line)',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        <HStack gap={6}>
          <T kind="caption" color="var(--ink-3)" style={{ width: 56 }}>
            reason
          </T>
          <Segmented
            value={reason}
            onChange={setReason}
            options={(guidanceTemplates.length > 0 ? guidanceTemplates : [{ reason: 'initial' }]).slice(0, 4).map((g) => ({
              value: g.reason,
              label: g.reason,
            }))}
          />
        </HStack>
      </div>

      <div
        style={{
          padding: 14,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          overflow: 'hidden',
        }}
      >
        {sections.map((s, i) => {
          const t = TONES[s.tone];
          return (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <HStack gap={6}>
                <span
                  aria-hidden="true"
                  style={{ width: 3, height: 12, background: t.dot, borderRadius: 1 }}
                />
                <T kind="caption" color={t.fg}>
                  {s.label}
                </T>
                <span style={{ flex: 1 }} />
                <T kind="mono-sm" color="var(--ink-4)" style={{ fontSize: 10 }}>
                  {s.src}
                </T>
              </HStack>
              <div
                style={{
                  padding: '6px 9px',
                  background: 'var(--surface-2)',
                  border: `1px solid ${t.line}`,
                  borderRadius: 'var(--r-sm)',
                  fontFamily: 'var(--mono)',
                  fontSize: 10.5,
                  lineHeight: 1.5,
                  color: 'var(--ink-2)',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {s.body}
              </div>
            </div>
          );
        })}
      </div>

      <div
        style={{
          padding: '10px 14px',
          borderTop: '1px solid var(--line)',
          background: 'var(--surface-2)',
          marginTop: 'auto',
        }}
      >
        <HStack gap={10}>
          <T kind="caption" color="var(--ink-3)">
            tokens
          </T>
          <T kind="mono-sm" style={{ fontWeight: 500 }}>
            {estimateTokens(sections)}
          </T>
          <span style={{ flex: 1 }} />
          <T kind="caption" color="var(--ink-3)">
            bytes
          </T>
          <T kind="mono-sm" style={{ fontWeight: 500 }}>
            {sections.reduce((sum, section) => sum + section.body.length, 0)}
          </T>
        </HStack>
      </div>
    </Card>
  );
}

function buildSections(
  preamble: PreambleSummary | null,
  template: GuidanceTemplate | null,
  repoId: string,
): PreviewSection[] {
  return [
    {
      tone: 'accent',
      label: '1 · PREAMBLE',
      src: preamble ? `${preamble.title} v${preamble.version} · global` : 'not exposed',
      body: preamble ? previewText(preamble.body) : 'No worker preamble is exposed by the Admin API.',
    },
    {
      tone: 'neutral',
      label: '2 · TASK OBJECTIVE',
      src: repoId,
      body: '<quay-task-objective>\nTask objective is captured at enqueue time.\n</quay-task-objective>',
    },
    {
      tone: 'warn',
      label: '3 · ATTEMPT GUIDANCE',
      src: template ? `${template.reason} · v${template.version}` : 'not exposed',
      body: template
        ? `<quay-current-attempt-guidance reason="${template.reason}">\n${previewText(template.body)}\n</quay-current-attempt-guidance>`
        : 'No retry templates are exposed by the Admin API.',
    },
  ];
}

function previewText(value: string): string {
  const lines = value.split('\n');
  if (lines.length <= 6 && value.length <= 420) return value;
  return `${lines.slice(0, 6).join('\n')}\n[...]`;
}

function estimateTokens(sections: PreviewSection[]): number {
  return Math.ceil(sections.reduce((sum, section) => sum + section.body.length, 0) / 4);
}
