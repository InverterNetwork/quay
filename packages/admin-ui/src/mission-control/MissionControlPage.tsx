import { useEffect, useMemo, useState } from 'react';
import { Avatar } from '../components/Avatar';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Chip } from '../components/Chip';
import { Divider } from '../components/Divider';
import { HStack, VStack } from '../components/Stack';
import { StatusDot } from '../components/StatusDot';
import { T } from '../components/Typography';
import { Icon } from '../icons/Icon';
import type { Tone } from '../styles/tones';
import {
  ATTN_LABEL,
  LANE_DEFINITIONS,
  needsAttention,
  tasksForLane,
  type AttnReason,
  type LaneDefinition,
  type MissionControlTask,
} from './taskState';

interface MissionControlPageProps {
  tasks?: MissionControlTask[];
  loading?: boolean;
  error?: string | null;
  lastRefreshAt?: Date | null;
  onRefresh?: () => void;
}

export function MissionControlPage({
  tasks = [],
  loading = false,
  error = null,
  lastRefreshAt,
  onRefresh,
}: MissionControlPageProps) {
  const [localLastRefreshAt, setLocalLastRefreshAt] = useState(() => new Date(Date.now() - 14_000));
  const [now, setNow] = useState(() => Date.now());
  const effectiveLastRefreshAt = lastRefreshAt ?? localLastRefreshAt;
  const lanes = useMemo(
    () => LANE_DEFINITIONS.map((lane) => ({ ...lane, tasks: tasksForLane(tasks, lane) })),
    [tasks],
  );
  const attentionCount = lanes.find((lane) => lane.key === 'attention')?.tasks.length ?? 0;
  const runningCount = lanes.find((lane) => lane.key === 'running')?.tasks.length ?? 0;
  const prCount = lanes.find((lane) => lane.key === 'pr')?.tasks.length ?? 0;
  const waitingCount = lanes.find((lane) => lane.key === 'waiting')?.tasks.length ?? 0;
  const terminalCount = lanes.find((lane) => lane.key === 'terminal')?.tasks.length ?? 0;
  const refreshLabel = error ? '!' : formatRelativeAge(effectiveLastRefreshAt, now);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const handleRefresh = () => {
    if (onRefresh) {
      onRefresh();
      return;
    }
    setLocalLastRefreshAt(new Date());
    setNow(Date.now());
  };

  return (
    <main
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        background: 'var(--paper-2)',
        overflow: 'hidden',
      }}
    >
      <header style={{ padding: '24px 24px 16px', borderBottom: '1px solid var(--line)' }}>
        <HStack gap={14} align="flex-end" style={{ marginBottom: 16 }}>
          <div style={{ flex: 1 }}>
            <T as="h1" kind="h1" style={{ margin: 0 }}>
              Mission control
            </T>
          </div>
          <Button
            variant="secondary"
            size="md"
            leading={<Icon.Refresh size={13} />}
            onClick={handleRefresh}
            aria-label="Refresh task list"
          >
            <T kind="mono-sm" color={error ? 'var(--danger)' : 'var(--ink-3)'} style={{ marginLeft: -2 }}>
              {refreshLabel}
            </T>
          </Button>
        </HStack>

        {error && (
          <HStack
            gap={10}
            style={{
              minHeight: 34,
              marginBottom: 14,
              padding: '7px 9px',
              background: 'var(--danger-soft)',
              border: '1px solid var(--danger-line)',
              borderRadius: 'var(--r-md)',
            }}
          >
            <StatusDot tone="danger" label="Mission Control task refresh failed" />
            <T kind="body-sm" color="var(--danger-ink)" style={{ flex: 1 }}>
              {error}
            </T>
            <Button variant="ghost" size="sm" onClick={handleRefresh}>
              Retry
            </Button>
          </HStack>
        )}

        <HStack gap={6} wrap>
          <Chip selected tone="accent" title="Filtering is coming soon.">
            All <ChipCount tone="accent">{tasks.length}</ChipCount>
          </Chip>
          <Chip leading={<StatusDot tone="danger" size={6} />} title="Filtering is coming soon.">
            Attention <ChipCount>{attentionCount}</ChipCount>
          </Chip>
          <Chip title="Filtering is coming soon.">
            Running <ChipCount>{runningCount}</ChipCount>
          </Chip>
          <Chip leading={<Icon.GitPR size={11} />} title="Filtering is coming soon.">
            PR lifecycle <ChipCount>{prCount}</ChipCount>
          </Chip>
          <Chip title="Filtering is coming soon.">
            Waiting <ChipCount>{waitingCount}</ChipCount>
          </Chip>
          <Chip title="Filtering is coming soon.">
            Terminal <ChipCount>{terminalCount}</ChipCount>
          </Chip>

          <span style={{ flex: 1 }} />

          <Chip trailing={<Icon.Chevron size={10} dir="down" />} title="Repo filtering is coming soon.">
            Repo: all
          </Chip>
          <Chip trailing={<Icon.Chevron size={10} dir="down" />} title="Sorting is coming soon.">
            Updated ↓
          </Chip>
        </HStack>
      </header>

      {loading ? (
        <LaneSkeletonGrid />
      ) : tasks.length === 0 ? (
        <EmptyMissionControl />
      ) : (
        <LaneGrid lanes={lanes} />
      )}
    </main>
  );
}

interface ChipCountProps {
  tone?: Tone;
  children: number;
}

function ChipCount({ tone, children }: ChipCountProps) {
  return (
    <T kind="mono-sm" color={tone === 'accent' ? 'var(--ink-3)' : 'var(--ink-4)'} style={{ marginLeft: 4 }}>
      {children}
    </T>
  );
}

interface LaneWithTasks extends LaneDefinition {
  tasks: MissionControlTask[];
}

function LaneGrid({ lanes }: { lanes: LaneWithTasks[] }) {
  return (
    <div
      style={{
        flex: 1,
        padding: '20px 24px 24px',
        display: 'grid',
        gridTemplateColumns: 'repeat(5, minmax(220px, 1fr))',
        gap: 16,
        overflow: 'auto',
        alignItems: 'start',
      }}
    >
      {lanes.map((lane) => (
        <Lane key={lane.key} lane={lane} />
      ))}
    </div>
  );
}

function Lane({ lane }: { lane: LaneWithTasks }) {
  return (
    <section aria-labelledby={`mc-lane-${lane.key}`} style={{ display: 'flex', flexDirection: 'column', minWidth: 0, gap: 10 }}>
      <HStack gap={8} style={{ padding: '0 2px' }}>
        {lane.attention ? (
          <StatusDot tone="danger" pulse label="Needs attention" />
        ) : (
          <span
            aria-hidden="true"
            style={{
              width: 5,
              height: 5,
              borderRadius: 1,
              background: lane.tone === 'neutral' ? 'var(--ink-4)' : `var(--${lane.tone})`,
              flexShrink: 0,
            }}
          />
        )}
        <T as="h2" id={`mc-lane-${lane.key}`} kind="caption" color={lane.attention ? 'var(--danger-ink)' : 'var(--ink-2)'} style={{ margin: 0 }}>
          {lane.label}
        </T>
        <T kind="mono-sm" color="var(--ink-4)">
          {lane.tasks.length}
        </T>
        <span style={{ flex: 1 }} />
        <Icon.More size={14} style={{ color: 'var(--ink-4)' }} />
      </HStack>
      <VStack gap={8}>
        {lane.tasks.map((task) => (
          <TaskCard key={task.id} task={task} highlight={lane.attention === true} />
        ))}
      </VStack>
    </section>
  );
}

function TaskCard({ task, highlight }: { task: MissionControlTask; highlight: boolean }) {
  const attnTone = task.attnTone ?? (needsAttention(task) ? 'danger' : undefined);
  const agent = formatAgent(task.agent);
  return (
    <article
      aria-label={`${task.id} · ${task.title}`}
      style={{
        background: 'var(--surface)',
        border: `1px solid ${highlight ? 'var(--accent-line)' : 'var(--line)'}`,
        borderRadius: 'var(--r-md)',
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 9,
        cursor: 'default',
        position: 'relative',
        minWidth: 0,
      }}
    >
      {task.attn && attnTone && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: -1,
            left: -1,
            bottom: -1,
            width: 3,
            background: `var(--${attnTone})`,
            borderTopLeftRadius: 'var(--r-md)',
            borderBottomLeftRadius: 'var(--r-md)',
          }}
        />
      )}

      <HStack gap={6}>
        <T kind="mono-sm" color="var(--ink-3)">
          {task.id}
        </T>
        <T kind="mono-sm" color="var(--ink-4)">
          ·
        </T>
        <T kind="mono-sm" color="var(--ink-3)">
          {task.ext}
        </T>
        <span style={{ flex: 1 }} />
        {task.attn && attnTone && (
          <Badge tone={attnTone} size="sm" dot>
            {ATTN_LABEL[task.attn as AttnReason]}
          </Badge>
        )}
      </HStack>

      <T
        kind="body-strong"
        style={{
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          lineHeight: 1.35,
          minHeight: 38,
        }}
      >
        {task.title}
      </T>

      <div style={{ borderLeft: '2px solid var(--line)', paddingLeft: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <T kind="mono-sm" color={task.branch === '—' ? 'var(--ink-4)' : 'var(--ink-2)'} style={ellipsisStyle}>
          {task.branch === '—' ? '— no branch yet —' : task.branch}
        </T>
        <T kind="mono-sm" color="var(--ink-3)" style={ellipsisStyle}>
          ↳ {task.latest}
        </T>
      </div>

      <HStack gap={5} wrap>
        <Chip leading={<Icon.Repo size={11} />}>{task.repo}</Chip>
        {task.pr !== null && <Chip leading={<Icon.GitPR size={11} />}>#{task.pr}</Chip>}
        {agent !== null && <Chip leading={<Icon.Bot size={11} />}>{agent}</Chip>}
      </HStack>

      <Divider dashed />

      <HStack gap={8}>
        <BudgetMeter used={task.budget} total={task.total} />
        <span style={{ flex: 1 }} />
        <HStack gap={0}>
          {task.authors.slice(0, 2).map((author, index) => (
            <Avatar
              key={author}
              name={author}
              size={18}
              style={{
                marginLeft: index > 0 ? -4 : 0,
                borderColor: 'var(--surface)',
              }}
            />
          ))}
        </HStack>
        <T kind="mono-sm" color="var(--ink-4)">
          {task.age}
        </T>
      </HStack>
    </article>
  );
}

const ellipsisStyle = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  display: 'block',
} as const;

function BudgetMeter({ used, total }: { used: number; total: number }) {
  const tone = used >= total ? 'danger' : used >= total - 1 ? 'warn' : 'accent';
  const segments = Array.from({ length: Math.max(total, 1) }, (_, index) => index < used);
  return (
    <HStack gap={6} aria-label={`${used} of ${total} attempts used.`} style={{ flexShrink: 0 }}>
      <HStack gap={2}>
        {segments.map((filled, index) => (
          <span
            key={index}
            aria-hidden="true"
            style={{
              width: 8,
              height: 7,
              borderRadius: 1,
              background: filled ? `var(--${tone})` : 'var(--line-2)',
            }}
          />
        ))}
      </HStack>
      <T kind="mono-sm" color="var(--ink-3)">
        {used}/{total}
      </T>
    </HStack>
  );
}

function LaneSkeletonGrid() {
  return (
    <div
      style={{
        flex: 1,
        padding: '20px 24px 24px',
        display: 'grid',
        gridTemplateColumns: 'repeat(5, minmax(220px, 1fr))',
        gap: 16,
        overflow: 'auto',
      }}
    >
      {LANE_DEFINITIONS.map((lane) => (
        <section key={lane.key} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <HStack gap={8} style={{ padding: '0 2px' }}>
            <span style={{ width: 5, height: 5, borderRadius: 1, background: 'var(--ink-4)' }} />
            <T kind="caption" color="var(--ink-2)">
              {lane.label}
            </T>
          </HStack>
          {[0, 1].map((slot) => (
            <div
              key={slot}
              aria-hidden="true"
              style={{
                height: 154,
                background: 'var(--surface-2)',
                borderRadius: 'var(--r-md)',
                opacity: 0.72,
              }}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

function EmptyMissionControl() {
  return (
    <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 24 }}>
      <VStack
        gap={8}
        align="center"
        style={{
          maxWidth: 420,
          padding: 24,
          background: 'var(--surface)',
          border: '1px solid var(--line)',
          borderRadius: 'var(--r-md)',
          textAlign: 'center',
        }}
      >
        <T kind="h3">No tasks yet</T>
        <T kind="body-sm" color="var(--ink-3)">
          Tasks are enqueued from the CLI: <T kind="mono-sm">quay enqueue &lt;repo&gt; &lt;ticket&gt;</T> - or via adapters once configured.
        </T>
      </VStack>
    </div>
  );
}

function formatAgent(agent: string): string | null {
  if (agent === '—') return null;
  return agent.replace(/^claude-/, '').replace(/-sonnet$/, '');
}

function formatRelativeAge(date: Date | null, now: number): string {
  if (date === null) return '—';
  const seconds = Math.max(0, Math.floor((now - date.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
