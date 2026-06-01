import type { Tone } from '../styles/tones';

export const TASK_STATES = [
  'queued',
  'waiting_dependencies',
  'running',
  'goal-completion-pending',
  'pr-open',
  'pr-review',
  'done',
  'awaiting-next-brief',
  'claimed-by-orchestrator',
  'waiting_human',
  'waiting_external_changes',
  'non_budget_loop',
  'worktree_error',
  'orchestrator_loop',
  'cancelled',
  'merged',
  'closed_unmerged',
] as const;

export type TaskState = (typeof TASK_STATES)[number];
export type AttnReason = 'changes' | 'ci' | 'slack' | 'brief' | 'dependency' | 'budget' | 'loop' | 'worktree';
export type MissionControlTaskRole = 'worker' | 'review';

export interface MissionControlTask {
  id: string;
  ext: string;
  repo: string;
  repoUrl: string | null;
  title: string;
  branch: string;
  state: TaskState;
  pr: number | null;
  prUrl: string | null;
  isReviewOnly: boolean;
  role: MissionControlTaskRole;
  reviewStatus: string | null;
  budget: number;
  total: number;
  latest: string;
  agent: string;
  age: string;
  updatedAt?: string;
  attn?: AttnReason;
  attnTone?: 'warn' | 'danger';
  authors: string[];
}

export interface LaneDefinition {
  key: 'attention' | 'running' | 'pr' | 'waiting' | 'terminal';
  label: string;
  tone: Tone;
  states: readonly TaskState[];
  attention?: boolean;
}

export const TERMINAL_STATES = ['merged', 'cancelled', 'closed_unmerged'] as const satisfies readonly TaskState[];

export const ATTENTION_STATES = [
  'non_budget_loop',
  'worktree_error',
  'orchestrator_loop',
  'waiting_dependencies',
  'waiting_human',
] as const satisfies readonly TaskState[];

export const LANE_DEFINITIONS: readonly LaneDefinition[] = [
  { key: 'attention', label: 'NEEDS ATTENTION', tone: 'danger', states: [], attention: true },
  {
    key: 'running',
    label: 'RUNNING',
    tone: 'accent',
    states: ['running', 'goal-completion-pending', 'claimed-by-orchestrator'],
  },
  {
    key: 'pr',
    label: 'PR LIFECYCLE',
    tone: 'warn',
    states: ['pr-open', 'pr-review', 'done', 'waiting_external_changes'],
  },
  { key: 'waiting', label: 'WAITING', tone: 'neutral', states: ['queued', 'waiting_dependencies', 'awaiting-next-brief'] },
  { key: 'terminal', label: 'TERMINAL', tone: 'good', states: TERMINAL_STATES },
];

export const ATTN_LABEL: Record<AttnReason, string> = {
  changes: 'Review changes',
  ci: 'CI failed',
  slack: 'Slack reply',
  brief: 'Next brief',
  dependency: 'Dependency',
  budget: 'Budget exhausted',
  loop: 'Non-budget loop',
  worktree: 'Worktree error',
};

const attentionStateSet = new Set<TaskState>(ATTENTION_STATES);
const terminalStateSet = new Set<TaskState>(TERMINAL_STATES);

export function needsAttention(task: MissionControlTask): boolean {
  return task.attn !== undefined || attentionStateSet.has(task.state);
}

export function isTerminalTask(task: MissionControlTask): boolean {
  return terminalStateSet.has(task.state);
}

export function activeTaskCount(tasks: readonly MissionControlTask[]): number {
  return tasks.filter((task) => !isTerminalTask(task)).length;
}

export function tasksForLane(
  tasks: readonly MissionControlTask[],
  lane: LaneDefinition,
): MissionControlTask[] {
  if (lane.attention) return tasks.filter(needsAttention);
  const laneStates = new Set<TaskState>(lane.states);
  return tasks.filter((task) => !needsAttention(task) && laneStates.has(task.state));
}
