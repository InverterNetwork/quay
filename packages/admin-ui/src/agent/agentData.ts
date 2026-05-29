import type { Tone } from '../styles/tones';

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

interface ToolEvent {
  t: 'tool';
  label: string;
  detail?: string;
  ms: number;
}

interface TextEvent {
  t: 'text';
  text: string;
}

export interface RefEvent {
  t: 'ref';
  kind: 'ci' | 'log' | 'pr' | 'task' | 'slack' | 'file';
  id: string;
  label: string;
  meta?: string;
  tone?: Tone;
}

interface CommandResult {
  exit: number;
  ms: number;
  lines: string[];
}

export interface CommandEvent {
  t: 'cmd';
  cmd: string;
  desc: string;
  affects: Array<{ label: string; val: string }>;
  note: string;
  runTone?: Tone;
  result: CommandResult;
}

export type AgentEvent = ToolEvent | TextEvent | RefEvent | CommandEvent;

export interface AgentAdapter {
  id: string;
  name: string;
  model: string;
  status: Tone;
  plan: (userText: string, ctx: AgentContext) => AgentEvent[];
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

const R = {
  worktree: { t: 'ref', kind: 'task', id: 'hij456', label: 'quay-ui · worktree corrupted', meta: 'WORKTREE', tone: 'danger' },
  loop: { t: 'ref', kind: 'task', id: 'ghi789', label: 'brix-indexer · non-budget loop, budget 5/5', meta: 'LOOP', tone: 'danger' },
  ci: { t: 'ref', kind: 'task', id: 'bcd890', label: 'quay · CI red on PR #48', meta: 'CI', tone: 'danger' },
  review: { t: 'ref', kind: 'task', id: 'abc123', label: 'quay-ui · 5 review comments on PR #42', meta: 'REVIEW', tone: 'warn' },
  slack: { t: 'ref', kind: 'slack', id: '#quay-ops', label: 'jkl012 - "which redirect after SSO?"', meta: 'awaiting reply', tone: 'warn' },
  prReady: { t: 'ref', kind: 'pr', id: 'PR #50', label: 'klm234 · iTRY-monorepo - CI green', meta: 'ready', tone: 'good' },
  prMno: { t: 'ref', kind: 'pr', id: 'PR #53', label: 'mno345 · erpc - CI 4/6 passing', meta: 'in progress', tone: 'neutral' },
  prEfg: { t: 'ref', kind: 'pr', id: 'PR #45', label: 'efg123 · erpc - reviewer running', meta: 'in review', tone: 'neutral' },
  prWxc: { t: 'ref', kind: 'pr', id: 'PR #44', label: 'wxc345 · changes requested', meta: 'awaiting author', tone: 'warn' },
  ciRun: { t: 'ref', kind: 'ci', id: 'ci-run #2291', label: 'PR #48 · e2e:respawn job', meta: 'exit 1', tone: 'danger' },
} satisfies Record<string, RefEvent>;

const CMD_RETRY_WT: Omit<CommandEvent, 't'> = {
  cmd: 'quay task retry hij456 --fresh-worktree',
  desc: 'Discard the corrupted worktree on `hij456` (quay-ui) and re-run on a clean clone. No PR exists yet, so nothing downstream is affected.',
  affects: [
    { label: 'task', val: 'hij456' },
    { label: 'worktree', val: 'reset -> fresh clone' },
    { label: 'budget', val: '1/5 -> 2/5' },
    { label: 'lane', val: 'attention -> running' },
  ],
  note: 'Safe · no PR, no force-push',
  runTone: 'accent',
  result: {
    exit: 0,
    ms: 2300,
    lines: [
      '-> acquiring supervisor lock... ok',
      '-> discarding worktree quay/itry-1180-field-stories... ok',
      '-> cloning fresh worktree... ok (1.7s)',
      '✓ attempt 2 spawned · pid 90412',
    ],
  },
};

const CMD_HALT_LOOP: Omit<CommandEvent, 't'> = {
  cmd: 'quay task halt ghi789 --reason "reindex OOM loop"',
  desc: 'Stop the non-budget retry loop on `ghi789` (brix-indexer). It has exhausted budget (5/5) and keeps OOM-ing on the historical block range. Halting moves it to PAUSED so you can repartition the range before resuming.',
  affects: [
    { label: 'task', val: 'ghi789' },
    { label: 'loop', val: 'halted' },
    { label: 'state', val: 'non_budget_loop -> paused' },
    { label: 'PR #37', val: 'preserved' },
  ],
  note: 'Reversible · resume with quay task resume',
  runTone: 'accent',
  result: {
    exit: 0,
    ms: 1800,
    lines: [
      '-> sending halt signal to ghi789... ok',
      '-> loop stopped after current attempt',
      '✓ ghi789 marked paused · PR #37 untouched',
    ],
  },
};

const CMD_ASSIGN_REVIEWER: Omit<CommandEvent, 't'> = {
  cmd: 'quay pr assign-reviewer 50 --auto',
  desc: 'PR #50 (`klm234`, iTRY-monorepo) is CI-green with no requested changes - it just needs a human reviewer. Auto-assign picks an available reviewer from the repo’s CODEOWNERS.',
  affects: [
    { label: 'PR #50', val: 'klm234' },
    { label: 'reviewer', val: 'auto from CODEOWNERS' },
    { label: 'task klm234', val: 'done -> in review' },
  ],
  note: 'Assigns only · does not merge',
  runTone: 'accent',
  result: {
    exit: 0,
    ms: 1500,
    lines: [
      '-> resolving CODEOWNERS for iTRY-monorepo... ok',
      '-> assigning @alex-park (least-loaded)... ok',
      '✓ klm234 -> IN REVIEW · reviewer notified',
    ],
  },
};

const CMD_RETRY_CI: Omit<CommandEvent, 't'> = {
  cmd: 'quay task retry bcd890 --fresh-worktree',
  desc: 'Re-run `bcd890` (quay) on a clean worktree. The e2e:respawn check failed against a corrupt worktree; a fresh clone clears it. Keeps PR #48 and its history.',
  affects: [
    { label: 'task', val: 'bcd890' },
    { label: 'worktree', val: 'reset -> fresh clone' },
    { label: 'PR #48', val: 'preserved' },
    { label: 'budget', val: '3/5 -> 4/5' },
  ],
  note: 'Safe · no force-push',
  runTone: 'accent',
  result: {
    exit: 0,
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

const PLANS: Record<string, () => AgentEvent[]> = {
  attention: () => [
    { t: 'tool', label: 'Reading attention queue', detail: '5 items', ms: 700 },
    { t: 'tool', label: 'Correlating recent events', detail: 'last tick', ms: 900 },
    { t: 'text', text: 'Five tasks need you. Two are hard-stuck and will not clear themselves; one is waiting on your reply; two are gated on a check or review.' },
    { t: 'text', text: '**Act now - stuck:**' },
    R.worktree,
    R.loop,
    { t: 'text', text: '**Waiting on you:**' },
    R.slack,
    { t: 'text', text: '**Gated:**' },
    R.ci,
    R.review,
    { t: 'text', text: 'Suggested order: clear the two stuck tasks first, answer `jkl012` in Slack, then retry `bcd890` CI. Here are the two stuck ones:' },
    { t: 'cmd', ...CMD_RETRY_WT },
    { t: 'cmd', ...CMD_HALT_LOOP },
  ],
  stuck: () => [
    { t: 'tool', label: 'Scanning for stuck tasks', detail: '17 tasks', ms: 800 },
    { t: 'tool', label: 'Reading worker + worktree state', detail: '', ms: 950 },
    { t: 'text', text: 'Two tasks are hard-stuck - both are holding a worker slot and neither recovers on its own:' },
    R.worktree,
    { t: 'text', text: '`hij456` (quay-ui) hit a **corrupt worktree**. No PR exists yet, so a clean retry is risk-free.' },
    { t: 'cmd', ...CMD_RETRY_WT },
    R.loop,
    { t: 'text', text: '`ghi789` (brix-indexer) is in a **non-budget loop**. Budget is exhausted (5/5), so retrying will not help; halt it first so it stops eating a slot:' },
    { t: 'cmd', ...CMD_HALT_LOOP },
  ],
  ready: () => [
    { t: 'tool', label: 'Scanning PR lifecycle', detail: '4 open PRs', ms: 750 },
    { t: 'tool', label: 'Checking merge gates', detail: 'CI + reviews', ms: 800 },
    { t: 'text', text: 'One PR is merge-ready. The other three are still gated:' },
    R.prReady,
    { t: 'text', text: '`PR #50` (`klm234`, iTRY-monorepo) is **CI-green with no requested changes** - it only needs a human reviewer.' },
    { t: 'cmd', ...CMD_ASSIGN_REVIEWER },
    { t: 'text', text: 'The rest aren’t ready yet:' },
    R.prMno,
    R.prEfg,
    R.prWxc,
    { t: 'text', text: '`#53` is mid-CI, `#45` has a reviewer running now, and `#44` is waiting on the author to push the requested changes - nothing for you to do on those.' },
  ],
  review: () => [
    { t: 'tool', label: 'Fetching review threads', detail: 'open PRs', ms: 800 },
    { t: 'tool', label: 'Summarizing comments', detail: '', ms: 750 },
    { t: 'text', text: 'The only PR with actionable review feedback is `abc123`:' },
    R.review,
    { t: 'text', text: 'On `PR #42` (quay-ui), the reviewer left **5 inline comments** requesting changes, mostly around timezone handling in the activity-log formatter.' },
    R.prEfg,
  ],
  fail: () => [
    { t: 'tool', label: 'Scanning for failures', detail: '17 tasks', ms: 700 },
    { t: 'text', text: 'The most urgent failure is `bcd890`. PR #48 opened cleanly, but `e2e:respawn` exited non-zero after a worktree lock timeout.' },
    R.ciRun,
    { t: 'text', text: 'Budget is **3 of 5**, so a clean retry is the cheap fix:' },
    { t: 'cmd', ...CMD_RETRY_CI },
  ],
  default: () => [
    { t: 'tool', label: 'Reading fleet state', detail: '17 tasks · 8 repos', ms: 850 },
    { t: 'text', text: 'Across `prod`: **17 tasks**, **5 need attention**, 4 running, 4 in PR lifecycle, 2 queued. Workers are at 3 of 8.' },
    { t: 'text', text: 'The thing most worth your time: two tasks are hard-stuck (`hij456` worktree, `ghi789` loop) and holding worker slots. Ask *what needs attention?* for full triage.' },
    R.worktree,
    R.loop,
  ],
};

export const hermesAdapter: AgentAdapter = {
  id: 'hermes',
  name: 'Hermes',
  model: 'hermes-1.4',
  status: 'good',
  plan(userText) {
    return PLANS[matchIntent(userText)]?.() ?? PLANS.default();
  },
};
