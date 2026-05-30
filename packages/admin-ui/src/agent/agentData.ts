import type { AgentConnectionStatus, AgentEvent, AgentReferenceKind } from './agentTypes';

export interface AgentContext {
  scope: string;
  repos: number;
  tasks: number;
  attention: number;
  running: number;
  prs: number;
  workers: string;
  queued: number;
  tickAgo: string;
}

export interface AgentSuggestion {
  icon: 'Alert' | 'Pulse' | 'GitPR' | 'Inbox';
  q: string;
}

export interface DemoCommandResult {
  exitCode: number;
  ms: number;
  lines: string[];
}

export interface AgentScriptStep {
  event: AgentEvent;
  delayMs?: number;
  streamText?: boolean;
  approvalResult?: DemoCommandResult;
}

export interface AgentAdapter {
  id: string;
  name: string;
  model: string;
  status: AgentConnectionStatus;
  plan: (userText: string, ctx: AgentContext, messageId: string) => AgentScriptStep[];
}

export const AGENT_CTX: AgentContext = {
  scope: 'prod',
  repos: 8,
  tasks: 17,
  attention: 5,
  running: 4,
  prs: 4,
  workers: '3/8',
  queued: 2,
  tickAgo: '14s',
};

export const AGENT_SUGGESTIONS: AgentSuggestion[] = [
  { icon: 'Alert', q: 'What needs attention right now?' },
  { icon: 'Pulse', q: 'Which tasks are stuck, and why?' },
  { icon: 'GitPR', q: 'Any PRs ready to merge?' },
  { icon: 'Inbox', q: 'Summarize the 5 attention items.' },
];

interface DemoReference {
  kind: AgentReferenceKind;
  id: string;
  label: string;
  tone?: AgentConnectionStatus;
}

interface DemoApproval {
  key: string;
  command: string;
  description: string;
  affects: Array<{ label: string; value: string }>;
  note: string;
  result: DemoCommandResult;
}

const R = {
  worktree: { kind: 'task', id: 'hij456', label: 'quay-ui · worktree corrupted', tone: 'danger' },
  loop: { kind: 'task', id: 'ghi789', label: 'brix-indexer · non-budget loop, budget 5/5', tone: 'danger' },
  ci: { kind: 'task', id: 'bcd890', label: 'quay · CI red on PR #48', tone: 'danger' },
  review: { kind: 'task', id: 'abc123', label: 'quay-ui · 5 review comments on PR #42', tone: 'warn' },
  operatorReply: { kind: 'task', id: 'jkl012', label: 'quay-ops · waiting on operator reply', tone: 'warn' },
  prReady: { kind: 'pr', id: 'PR #50', label: 'klm234 · iTRY-monorepo - CI green', tone: 'good' },
  prMno: { kind: 'pr', id: 'PR #53', label: 'mno345 · erpc - CI 4/6 passing', tone: 'neutral' },
  prEfg: { kind: 'pr', id: 'PR #45', label: 'efg123 · erpc - reviewer running', tone: 'neutral' },
  prWxc: { kind: 'pr', id: 'PR #44', label: 'wxc345 · changes requested', tone: 'warn' },
  ciRun: { kind: 'ci', id: 'ci-run #2291', label: 'PR #48 · e2e:respawn job', tone: 'danger' },
} satisfies Record<string, DemoReference>;

const CMD_RETRY_WT: DemoApproval = {
  key: 'retry-worktree',
  command: 'quay task retry hij456 --fresh-worktree',
  description:
    'Discard the corrupted worktree on `hij456` (quay-ui) and re-run on a clean clone. No PR exists yet, so nothing downstream is affected.',
  affects: [
    { label: 'task', value: 'hij456' },
    { label: 'worktree', value: 'reset -> fresh clone' },
    { label: 'budget', value: '1/5 -> 2/5' },
    { label: 'lane', value: 'attention -> running' },
  ],
  note: 'Safe · no PR, no force-push',
  result: {
    exitCode: 0,
    ms: 2300,
    lines: [
      '-> acquiring supervisor lock... ok',
      '-> discarding worktree quay/itry-1180-field-stories... ok',
      '-> cloning fresh worktree... ok (1.7s)',
      '✓ attempt 2 spawned · pid 90412',
    ],
  },
};

const CMD_HALT_LOOP: DemoApproval = {
  key: 'halt-loop',
  command: 'quay task halt ghi789 --reason "reindex OOM loop"',
  description:
    'Stop the non-budget retry loop on `ghi789` (brix-indexer). It has exhausted budget (5/5) and keeps OOM-ing on the historical block range. Halting moves it to PAUSED so you can repartition the range before resuming.',
  affects: [
    { label: 'task', value: 'ghi789' },
    { label: 'loop', value: 'halted' },
    { label: 'state', value: 'non_budget_loop -> paused' },
    { label: 'PR #37', value: 'preserved' },
  ],
  note: 'Reversible · resume with quay task resume',
  result: {
    exitCode: 0,
    ms: 1800,
    lines: [
      '-> sending halt signal to ghi789... ok',
      '-> loop stopped after current attempt',
      '✓ ghi789 marked paused · PR #37 untouched',
    ],
  },
};

const CMD_ASSIGN_REVIEWER: DemoApproval = {
  key: 'assign-reviewer',
  command: 'quay pr assign-reviewer 50 --auto',
  description:
    'PR #50 (`klm234`, iTRY-monorepo) is CI-green with no requested changes - it just needs a human reviewer. Auto-assign picks an available reviewer from the repo’s CODEOWNERS.',
  affects: [
    { label: 'PR #50', value: 'klm234' },
    { label: 'reviewer', value: 'auto from CODEOWNERS' },
    { label: 'task klm234', value: 'done -> in review' },
  ],
  note: 'Assigns only · does not merge',
  result: {
    exitCode: 0,
    ms: 1500,
    lines: [
      '-> resolving CODEOWNERS for iTRY-monorepo... ok',
      '-> assigning @alex-park (least-loaded)... ok',
      '✓ klm234 -> IN REVIEW · reviewer notified',
    ],
  },
};

const CMD_RETRY_CI: DemoApproval = {
  key: 'retry-ci',
  command: 'quay task retry bcd890 --fresh-worktree',
  description:
    'Re-run `bcd890` (quay) on a clean worktree. The e2e:respawn check failed against a corrupt worktree; a fresh clone clears it. Keeps PR #48 and its history.',
  affects: [
    { label: 'task', value: 'bcd890' },
    { label: 'worktree', value: 'reset -> fresh clone' },
    { label: 'PR #48', value: 'preserved' },
    { label: 'budget', value: '3/5 -> 4/5' },
  ],
  note: 'Safe · no force-push',
  result: {
    exitCode: 0,
    ms: 2400,
    lines: [
      '-> acquiring supervisor lock... ok',
      '-> discarding worktree quay/itry-1245-tick-respawn... ok',
      '-> cloning fresh worktree... ok (1.8s)',
      '✓ attempt 4 spawned · pid 88213',
    ],
  },
};

function matchIntent(text: string) {
  const s = text.toLowerCase();
  if (/(attention|triage|urgent|need)/.test(s)) return 'attention';
  if (/(stuck|stall|hung|loop|worktree|blocked|recover)/.test(s)) return 'stuck';
  if (/(merge|ready|ship|pull request|\bprs?\b)/.test(s)) return 'ready';
  if (/(review|feedback|comment)/.test(s)) return 'review';
  if (/(fail|fault|broke|error|wrong|crash|why)/.test(s)) return 'fail';
  return 'default';
}

function start(messageId: string, model: string): AgentScriptStep {
  return { event: { type: 'message_start', messageId, role: 'agent', model } };
}

function done(messageId: string): AgentScriptStep {
  return { event: { type: 'message_done', messageId } };
}

function tool(messageId: string, toolCallId: string, label: string, detail: string, ms: number): AgentScriptStep[] {
  return [
    { event: { type: 'tool_call', messageId, toolCallId, label, detail, status: 'running' } },
    { event: { type: 'tool_call', messageId, toolCallId, label, detail, status: 'done' }, delayMs: ms },
  ];
}

function text(messageId: string, body: string): AgentScriptStep {
  return { event: { type: 'text_delta', messageId, text: `${body}\n` }, streamText: true };
}

function ref(messageId: string, item: DemoReference): AgentScriptStep {
  return {
    event: {
      type: 'reference',
      messageId,
      kind: item.kind,
      id: item.id,
      label: item.label,
      tone: item.tone,
    },
    delayMs: 200,
  };
}

function approval(messageId: string, item: DemoApproval): AgentScriptStep {
  return {
    event: {
      type: 'approval_required',
      messageId,
      approvalId: `${messageId}:${item.key}`,
      command: item.command,
      description: item.description,
      affects: item.affects,
      note: item.note,
    },
    delayMs: 240,
    approvalResult: item.result,
  };
}

function planFor(intent: string, messageId: string, model: string): AgentScriptStep[] {
  const commonStart = [start(messageId, model)];
  const commonEnd = [done(messageId)];

  const plans: Record<string, AgentScriptStep[]> = {
    attention: [
      ...commonStart,
      ...tool(messageId, 'attention-queue', 'Reading attention queue', '5 items', 700),
      ...tool(messageId, 'recent-events', 'Correlating recent events', 'last tick', 900),
      text(
        messageId,
        'Five tasks need you. Two are hard-stuck and will not clear themselves; one is waiting on your reply; two are gated on a check or review.',
      ),
      text(messageId, '**Act now - stuck:**'),
      ref(messageId, R.worktree),
      ref(messageId, R.loop),
      text(messageId, '**Waiting on you:**'),
      ref(messageId, R.operatorReply),
      text(messageId, '**Gated:**'),
      ref(messageId, R.ci),
      ref(messageId, R.review),
      text(messageId, 'Suggested order: clear the two stuck tasks first, answer `jkl012`, then retry `bcd890` CI. Here are the two stuck ones:'),
      approval(messageId, CMD_RETRY_WT),
      approval(messageId, CMD_HALT_LOOP),
      ...commonEnd,
    ],
    stuck: [
      ...commonStart,
      ...tool(messageId, 'stuck-scan', 'Scanning for stuck tasks', '17 tasks', 800),
      ...tool(messageId, 'worker-state', 'Reading worker + worktree state', '', 950),
      text(messageId, 'Two tasks are hard-stuck - both are holding a worker slot and neither recovers on its own:'),
      ref(messageId, R.worktree),
      text(messageId, '`hij456` (quay-ui) hit a **corrupt worktree**. No PR exists yet, so a clean retry is risk-free.'),
      approval(messageId, CMD_RETRY_WT),
      ref(messageId, R.loop),
      text(
        messageId,
        '`ghi789` (brix-indexer) is in a **non-budget loop**. Budget is exhausted (5/5), so retrying will not help; halt it first so it stops eating a slot:',
      ),
      approval(messageId, CMD_HALT_LOOP),
      ...commonEnd,
    ],
    ready: [
      ...commonStart,
      ...tool(messageId, 'pr-lifecycle', 'Scanning PR lifecycle', '4 open PRs', 750),
      ...tool(messageId, 'merge-gates', 'Checking merge gates', 'CI + reviews', 800),
      text(messageId, 'One PR is merge-ready. The other three are still gated:'),
      ref(messageId, R.prReady),
      text(messageId, '`PR #50` (`klm234`, iTRY-monorepo) is **CI-green with no requested changes** - it only needs a human reviewer.'),
      approval(messageId, CMD_ASSIGN_REVIEWER),
      text(messageId, 'The rest are not ready yet:'),
      ref(messageId, R.prMno),
      ref(messageId, R.prEfg),
      ref(messageId, R.prWxc),
      text(
        messageId,
        '`#53` is mid-CI, `#45` has a reviewer running now, and `#44` is waiting on the author to push the requested changes - nothing for you to do on those.',
      ),
      ...commonEnd,
    ],
    review: [
      ...commonStart,
      ...tool(messageId, 'review-threads', 'Fetching review threads', 'open PRs', 800),
      ...tool(messageId, 'review-summary', 'Summarizing comments', '', 750),
      text(messageId, 'The only PR with actionable review feedback is `abc123`:'),
      ref(messageId, R.review),
      text(
        messageId,
        'On `PR #42` (quay-ui), the reviewer left **5 inline comments** requesting changes, mostly around timezone handling in the activity-log formatter.',
      ),
      ref(messageId, R.prEfg),
      ...commonEnd,
    ],
    fail: [
      ...commonStart,
      ...tool(messageId, 'failure-scan', 'Scanning for failures', '17 tasks', 700),
      text(
        messageId,
        'The most urgent failure is `bcd890`. PR #48 opened cleanly, but `e2e:respawn` exited non-zero after a worktree lock timeout.',
      ),
      ref(messageId, R.ciRun),
      text(messageId, 'Budget is **3 of 5**, so a clean retry is the cheap fix:'),
      approval(messageId, CMD_RETRY_CI),
      ...commonEnd,
    ],
    default: [
      ...commonStart,
      ...tool(messageId, 'fleet-state', 'Reading fleet state', '17 tasks · 8 repos', 850),
      text(messageId, 'Across `prod`: **17 tasks**, **5 need attention**, 4 running, 4 in PR lifecycle, 2 queued. Workers are at 3 of 8.'),
      text(
        messageId,
        'The thing most worth your time: two tasks are hard-stuck (`hij456` worktree, `ghi789` loop) and holding worker slots. Ask *what needs attention?* for full triage.',
      ),
      ref(messageId, R.worktree),
      ref(messageId, R.loop),
      ...commonEnd,
    ],
  };

  return plans[intent] ?? plans.default;
}

export const hermesAdapter: AgentAdapter = {
  id: 'hermes',
  name: 'Hermes',
  model: 'hermes-1.4',
  status: 'good',
  plan(userText, _ctx, messageId) {
    return planFor(matchIntent(userText), messageId, this.model);
  },
};
