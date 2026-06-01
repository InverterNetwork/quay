import { capturedAt, type AgentContextBuildBase, type AgentUiContext, type MissionControlContext } from '../agent/agentContext';
import { ATTN_LABEL, LANE_DEFINITIONS, needsAttention, tasksForLane, type MissionControlTask } from './taskState';

const MAX_CONTEXT_TASKS = 50;

interface BuildMissionControlAgentContextInput extends AgentContextBuildBase {
  tasks: MissionControlTask[];
  selectedTaskId?: string | null;
}

export function buildMissionControlAgentContext({
  scope,
  urlPath,
  capturedAt: capturedAtInput,
  tasks,
  selectedTaskId = null,
}: BuildMissionControlAgentContextInput): AgentUiContext {
  const lanes = Object.fromEntries(
    LANE_DEFINITIONS.map((lane) => [lane.key, tasksForLane(tasks, lane).length]),
  ) as Record<(typeof LANE_DEFINITIONS)[number]['key'], number>;
  const visibleTasks = tasks.slice(0, MAX_CONTEXT_TASKS).map(taskToContextSummary);
  const truncatedFields = tasks.length > MAX_CONTEXT_TASKS ? ['visibleTasks'] : [];
  const payload: MissionControlContext = {
    taskCounts: {
      total: tasks.length,
      attention: lanes.attention,
      running: lanes.running,
      prLifecycle: lanes.pr,
      waiting: lanes.waiting,
      terminal: lanes.terminal,
    },
    filters: {
      repo: null,
      lane: null,
      sort: 'updated-desc',
    },
    visibleTasks,
    selectedTaskId,
    limits: {
      maxTasks: MAX_CONTEXT_TASKS,
      truncatedFields,
    },
  };

  return {
    view: 'mission-control',
    scope,
    urlPath,
    capturedAt: capturedAt(capturedAtInput),
    summary: `Mission Control: ${tasks.length} tasks, ${payload.taskCounts.attention} need attention, ${payload.taskCounts.running} running, ${payload.taskCounts.prLifecycle} in PR lifecycle.`,
    payload,
  };
}

function taskToContextSummary(task: MissionControlTask): MissionControlContext['visibleTasks'][number] {
  return {
    id: task.id,
    role: task.role,
    reviewStatus: task.reviewStatus,
    externalRef: task.ext === '—' ? null : task.ext,
    repo: task.repo,
    title: task.title,
    branch: task.branch === '—' ? null : task.branch,
    state: task.state,
    attentionReason: attentionReason(task),
    pr: task.pr,
    latest: task.latest,
    budget: `${task.budget}/${task.total}`,
    agent: task.agent === '—' ? null : task.agent,
    updatedAt: task.updatedAt ?? null,
    authors: task.authors.length > 0 ? task.authors : undefined,
  };
}

function attentionReason(task: MissionControlTask): string | null {
  if (task.attn) return ATTN_LABEL[task.attn];
  return needsAttention(task) ? task.state : null;
}
