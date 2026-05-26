export type Tone = 'neutral' | 'accent' | 'good' | 'warn' | 'danger';

export interface ToneSpec {
  fg: string;
  bg: string;
  line: string;
  dot: string;
}

export const TONES: Record<Tone, ToneSpec> = {
  neutral: { fg: 'var(--ink-2)',     bg: 'var(--surface-2)',   line: 'var(--line-2)',     dot: 'var(--ink-3)' },
  accent:  { fg: 'var(--accent-ink)', bg: 'var(--accent-soft)', line: 'var(--accent-line)', dot: 'var(--accent)' },
  good:    { fg: 'var(--good-ink)',   bg: 'var(--good-soft)',   line: 'var(--good-line)',   dot: 'var(--good)' },
  warn:    { fg: 'var(--warn-ink)',   bg: 'var(--warn-soft)',   line: 'var(--warn-line)',   dot: 'var(--warn)' },
  danger:  { fg: 'var(--danger-ink)', bg: 'var(--danger-soft)', line: 'var(--danger-line)', dot: 'var(--danger)' },
};
