// hifi-config-v2.jsx — Quay Configuration, restructured.
// Two scopes only: Global and Per-repo.
// Long sectioned form with sticky anchor TOC; same field vocabulary across scopes.

const CV2_W = 1480;
const CV2_H_LONG = 2400;
const CV2_H = 940;

// ── Sample data ──────────────────────────────────────────────
const CV2_REPOS = [
  { id: 'acme-orders', active: 5, agent: 'hermes_codex_browser', selected: false, overrides: 4 },
  { id: 'acme-api',    active: 3, agent: 'inherits',             selected: false, overrides: 1 },
  { id: 'acme-web',    active: 3, agent: 'claude',               selected: false, overrides: 2 },
  { id: 'acme-mobile', active: 1, agent: 'inherits',             selected: false, overrides: 0 },
];

const CV2_INVOCATIONS = [
  { name: 'claude',
    role: ['worker', 'reviewer'],
    cmd: 'claude --permission-mode bypassPermissions --output-format json < {prompt_file} > .quay-usage.json',
    capabilities: [],
    usedByRepos: 2, usedByTasks: 3 },
  { name: 'hermes_codex_browser',
    role: ['worker'],
    cmd: 'hermes chat --quiet --query-file {prompt_file} --toolsets file,terminal,browser,vision',
    capabilities: ['browser', 'screenshots'],
    usedByRepos: 1, usedByTasks: 2 },
  { name: 'codex',
    role: ['worker'],
    cmd: 'codex exec --json --dangerously-bypass-approvals-and-sandbox < {prompt_file}',
    capabilities: [],
    usedByRepos: 0, usedByTasks: 0 },
];

const WORKER_PREAMBLE_BODY = `Quay protocol preamble (v1)

1. If you cannot make progress, write .quay-blocked.md containing prose explaining what happened, then exit cleanly.
2. Exit when (a) you have opened a PR, (b) you have written a blocker file, or (c) you have decided you cannot complete the task. Do not loop indefinitely.
3. Work inside the worktree. .quay-* files are reserved; you may write .quay-blocked.md, write .quay-goal-report.json when goal mode asks for it, and read .quay-prompt.md, but do not touch other .quay-* files.
4. When done, push the branch. Then check whether a PR already exists for this branch. If none exists, open one via gh pr create against the configured base branch. PR titles must start with a conventional-commit prefix: feat:, fix:, or chore:.
5. Follow the repo's contribution guide if one is configured.
6. Do not call any tool requiring interactive input.
7. Dependencies are already installed by Quay. Do not re-run install commands.
8. If you would normally ask a clarifying question, write that question into .quay-blocked.md and exit. Do not guess.`;

const REVIEWER_PREAMBLE_PREVIEW = `You are a strict, senior code reviewer with deep expertise in software security and systems architecture. You combine the perspective of a seasoned developer with a security engineer's instinct for risk, and you approach every review with both lenses active simultaneously.

You are running as a Quay reviewer worker. Your task is to review one PR and post the review directly to GitHub via \`gh pr review\`. You do not pause for human confirmation. You do not modify code. You do not push.

## Mindset

You have access to the diff under review and a local worktree at the PR's head SHA. Do not modify code or git state. Before flagging any issue, check how the surrounding codebase handles the same pattern…`;

const ORDERS_PREAMBLE_EXTENSION = `## acme-orders local conventions

- This codebase uses Hono routes. Middleware order matters: validation → auth → handler.
- Database access goes through packages/db/client.ts. Do not call the Drizzle ORM directly in route handlers.
- Money is always integer cents. Never reintroduce float arithmetic on monetary values.
- Touching payments/* or refunds/* requires a screenshot if the PR has any user-visible effect.`;

// ═════════════════════════════════════════════════════════════
// SHELL — top bar + left rail
// ═════════════════════════════════════════════════════════════

function CV2TopBar({ scope }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14,
      height: 56, padding: '0 20px',
      background: 'var(--paper)', borderBottom: '1px solid var(--line)',
      flexShrink: 0,
    }}>
      <QuayWordmark size={20} />
      <HStack gap={6} style={{ marginLeft: 4 }}>
        <T kind="mono-sm" color="var(--ink-3)">prod</T>
        <T kind="mono-sm" color="var(--ink-4)">/</T>
        <T kind="mono-sm" color="var(--ink-3)">configuration</T>
        <T kind="mono-sm" color="var(--ink-4)">/</T>
        <T kind="mono-sm" color="var(--ink)">{scope}</T>
      </HStack>
      <span style={{ flex: 1 }} />
      <HStack gap={6}>
        <StatusDot tone="good" />
        <T kind="mono-sm" color="var(--ink-3)">in sync · ~/.quay</T>
      </HStack>
      <Divider vertical style={{ height: 24 }} />
      <Input placeholder="Find setting, repo, prompt…" leading={<Icon.Search size={13} />} trailing={<Kbd>⌘K</Kbd>} style={{ width: 280 }} />
      <Avatar name="Mira Tonio" size={28} tone="accent" />
    </div>
  );
}

function CV2LeftRail({ activeScope }) {
  return (
    <div style={{
      width: 240, borderRight: '1px solid var(--line)',
      background: 'var(--paper)', padding: '16px 12px',
      display: 'flex', flexDirection: 'column', gap: 2,
      flexShrink: 0, overflow: 'hidden',
    }}>
      <T kind="caption" color="var(--ink-3)" style={{ padding: '4px 8px 6px' }}>SCOPE</T>

      <div data-row style={{
        padding: '9px 10px', borderRadius: 'var(--r-sm)',
        background: activeScope === 'global' ? 'var(--surface)' : 'transparent',
        border: `1px solid ${activeScope === 'global' ? 'var(--line)' : 'transparent'}`,
        borderLeft: activeScope === 'global' ? '2px solid var(--accent)' : '2px solid transparent',
        cursor: 'pointer',
      }}>
        <HStack gap={9}>
          <Icon.Settings size={14} style={{ color: activeScope === 'global' ? 'var(--accent)' : 'var(--ink-3)' }} />
          <div style={{ flex: 1 }}>
            <T kind="body-sm" style={{ fontWeight: activeScope === 'global' ? 600 : 500, display: 'block' }}>Global</T>
            <T kind="mono-sm" color="var(--ink-3)" style={{ display: 'block' }}>defaults for all repos</T>
          </div>
        </HStack>
      </div>

      <HStack gap={6} style={{ padding: '18px 8px 4px' }}>
        <T kind="caption" color="var(--ink-3)">REGISTERED REPOS</T>
        <T kind="mono-sm" color="var(--ink-4)">4</T>
        <span style={{ flex: 1 }} />
        <Icon.Plus size={12} style={{ color: 'var(--ink-3)' }} />
      </HStack>

      <Input placeholder="Filter…" leading={<Icon.Search size={11} />} size="sm" style={{ margin: '0 4px 6px', height: 26 }} />

      {CV2_REPOS.map(r => {
        const sel = activeScope === r.id;
        return (
          <div key={r.id} data-row style={{
            padding: '8px 10px', borderRadius: 'var(--r-sm)',
            background: sel ? 'var(--surface)' : 'transparent',
            border: `1px solid ${sel ? 'var(--line)' : 'transparent'}`,
            borderLeft: sel ? '2px solid var(--accent)' : '2px solid transparent',
            cursor: 'pointer',
          }}>
            <HStack gap={9}>
              <Icon.Repo size={12} style={{ color: sel ? 'var(--accent)' : 'var(--ink-3)' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <HStack gap={6}>
                  <T kind="body-sm" style={{ fontWeight: sel ? 600 : 500, fontFamily: 'var(--mono)', fontSize: 12.5, flex: 1 }}>{r.id}</T>
                  {r.active > 0 && <T kind="mono-sm" color="var(--ink-3)">{r.active}</T>}
                </HStack>
                <HStack gap={6} style={{ marginTop: 2 }}>
                  <T kind="mono-sm" color="var(--ink-3)" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.agent === 'inherits' ? 'inherits global' : r.agent.replace('hermes_codex_browser', 'hermes…')}
                  </T>
                  {r.overrides > 0 && <Badge tone="accent" size="sm" variant="outline">{r.overrides}</Badge>}
                </HStack>
              </div>
            </HStack>
          </div>
        );
      })}

      <HStack gap={6} style={{ padding: '14px 8px 4px' }}>
        <T kind="caption" color="var(--ink-3)">ARCHIVED</T>
        <T kind="mono-sm" color="var(--ink-4)">1</T>
      </HStack>
      <div style={{ padding: '6px 10px', opacity: 0.5 }}>
        <T kind="mono-sm" color="var(--ink-3)">acme-legacy</T>
      </div>

      <span style={{ flex: 1 }} />
      <Divider dashed style={{ margin: '8px 4px' }} />
      <div style={{ padding: '4px 8px' }}>
        <T kind="caption" color="var(--ink-3)" style={{ display: 'block' }}>FORMAT</T>
        <Segmented value="form" options={[
          { value: 'form', label: 'Form' },
          { value: 'toml', label: 'TOML' },
        ]} style={{ marginTop: 6 }} />
      </div>
    </div>
  );
}

// ── Section header + container ───────────────────────────────
function CV2Section({ n, id, title, hint, right, children, narrow }) {
  return (
    <div id={id} style={{
      marginBottom: 32, scrollMarginTop: 56,
      maxWidth: narrow ? 720 : 'none',
    }}>
      <HStack gap={12} align="baseline" style={{ marginBottom: 14 }}>
        <T kind="mono" color="var(--ink-4)" style={{ fontSize: 12, letterSpacing: '0.04em' }}>{n}</T>
        <T kind="h2" style={{ letterSpacing: '-0.018em' }}>{title}</T>
        {hint && <T kind="body-sm" color="var(--ink-3)">{hint}</T>}
        <span style={{ flex: 1 }} />
        {right}
      </HStack>
      {children}
    </div>
  );
}

function CV2SubGroup({ title, hint, children, columns = 2 }) {
  return (
    <Card padding={20} style={{ marginBottom: 12 }}>
      <HStack gap={10} align="baseline" style={{ marginBottom: 14 }}>
        <T kind="h4">{title}</T>
        {hint && <T kind="mono-sm" color="var(--ink-3)">· {hint}</T>}
      </HStack>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, 1fr)`, gap: 14 }}>
        {children}
      </div>
    </Card>
  );
}

// ── Field ────────────────────────────────────────────────────
function CV2Field({ label, value, source, inheritedValue, dirty, mono = true, fullRow, hint, suffix }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, gridColumn: fullRow ? '1 / -1' : 'auto' }}>
      <HStack gap={6}>
        <T kind="caption" color="var(--ink-3)">{label}</T>
        {hint && <T kind="mono-sm" color="var(--ink-4)">· {hint}</T>}
      </HStack>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 10px', minHeight: 32,
        background: dirty ? 'var(--warn-soft)' : 'var(--surface)',
        border: `1px solid ${dirty ? 'var(--warn-line)' : 'var(--line)'}`,
        borderRadius: 'var(--r-sm)',
        position: 'relative',
      }}>
        {dirty && <span style={{
          position: 'absolute', left: -1, top: -1, bottom: -1, width: 2,
          background: 'var(--warn)', borderTopLeftRadius: 2, borderBottomLeftRadius: 2,
        }} />}
        <span style={{
          fontFamily: mono ? 'var(--mono)' : 'var(--sans)',
          fontSize: mono ? 12 : 13, color: value ? 'var(--ink)' : 'var(--ink-4)',
          flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          fontStyle: value ? 'normal' : 'italic',
        }}>{value || '— not set —'}</span>
        {suffix}
      </div>
      {source && (
        <HStack gap={5}>
          {source === 'override' && <>
            <Icon.Arrow size={10} dir="up" style={{ color: 'var(--accent)' }} />
            <T kind="mono-sm" color="var(--accent-ink)">overrides global</T>
            {inheritedValue && <T kind="mono-sm" color="var(--ink-4)">· was {inheritedValue}</T>}
          </>}
          {source === 'inherits' && <>
            <Icon.Arrow size={10} dir="up" style={{ color: 'var(--ink-4)' }} />
            <T kind="mono-sm" color="var(--ink-3)">inherits global</T>
            {inheritedValue && <T kind="mono-sm" color="var(--ink-4)">· {inheritedValue}</T>}
          </>}
          {source === 'repo-only' && <>
            <Icon.Dot size={9} style={{ color: 'var(--ink-4)' }} />
            <T kind="mono-sm" color="var(--ink-3)">repo-only</T>
          </>}
          {source === 'global-only' && <>
            <Icon.Dot size={9} style={{ color: 'var(--ink-4)' }} />
            <T kind="mono-sm" color="var(--ink-3)">global-only</T>
          </>}
        </HStack>
      )}
    </div>
  );
}

// ── Anchor TOC ───────────────────────────────────────────────
function CV2Toc({ items, active }) {
  return (
    <div style={{
      width: 184, flexShrink: 0,
      position: 'sticky', top: 24,
      alignSelf: 'flex-start',
      display: 'flex', flexDirection: 'column', gap: 0,
      paddingLeft: 16,
      borderLeft: '1px solid var(--line)',
    }}>
      <T kind="caption" color="var(--ink-3)" style={{ marginBottom: 10 }}>ON THIS PAGE</T>
      {items.map(it => (
        <div key={it.id} style={{
          padding: '5px 0', cursor: 'pointer',
          borderLeft: it.id === active ? '2px solid var(--accent)' : '2px solid transparent',
          paddingLeft: 10, marginLeft: -12,
        }}>
          <T kind="body-sm" style={{
            fontWeight: it.id === active ? 600 : 400,
            color: it.id === active ? 'var(--ink)' : 'var(--ink-3)',
          }}>{it.label}</T>
        </div>
      ))}
    </div>
  );
}

// ── Sticky save footer ───────────────────────────────────────
function CV2SaveFooter({ count, summary, cli }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 28px',
      background: 'var(--warn-soft)',
      borderTop: '1px solid var(--warn-line)',
      flexShrink: 0,
    }}>
      <StatusDot tone="warn" />
      <T kind="body-sm" style={{ fontWeight: 500, color: 'var(--warn-ink)' }}>{count} unsaved change{count > 1 ? 's' : ''}</T>
      <T kind="mono-sm" color="var(--ink-3)">— {summary}</T>
      <span style={{ flex: 1 }} />
      <Button variant="ghost" size="md">Discard</Button>
      <Button variant="secondary" size="md">Preview diff</Button>
      <Button variant="primary" size="md">{cli || 'Save changes'}</Button>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
// PREAMBLE CARD — shared between Global (editable) and Repo (override picker)
// ═════════════════════════════════════════════════════════════

function CV2PreambleCard({ kind, title, version, body, refs, lastEdited, mode = 'global' }) {
  return (
    <Card padding={18} style={{ marginBottom: 14 }}>
      <HStack gap={10} align="baseline" style={{ marginBottom: 10 }}>
        <Icon.Anchor size={14} style={{ color: 'var(--accent)' }} />
        <T kind="h4">{title}</T>
        <Badge tone="accent" size="sm">v{version}</Badge>
        <Badge tone="neutral" size="sm" variant="outline">kind={kind}</Badge>
        <span style={{ flex: 1 }} />
        <T kind="mono-sm" color="var(--ink-3)">{refs} attempts ref · last edited {lastEdited}</T>
        <Button variant="ghost" size="sm">Versions</Button>
        <Button variant="secondary" size="sm">Edit</Button>
      </HStack>

      <div style={{
        background: 'var(--surface-2)', border: '1px solid var(--line)',
        borderRadius: 'var(--r-sm)', padding: '10px 14px',
        fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.6,
        color: 'var(--ink-2)', maxHeight: 220, overflow: 'hidden', position: 'relative',
      }}>
        <pre style={{ margin: 0, fontFamily: 'inherit', whiteSpace: 'pre-wrap' }}>{body}</pre>
        <div style={{
          position: 'absolute', left: 0, right: 0, bottom: 0, height: 56,
          background: 'linear-gradient(to bottom, transparent, var(--surface-2))',
          pointerEvents: 'none',
        }} />
      </div>
      <HStack gap={6} style={{ marginTop: 10 }}>
        <T kind="mono-sm" color="var(--ink-3)">{body.length} bytes · {body.split('\n').length} lines</T>
        <span style={{ flex: 1 }} />
        <T kind="caption" color="var(--ink-3)">USED BY</T>
        <Chip leading={<Icon.Repo size={11} />}>4 repos</Chip>
        <Chip tone="accent" selected leading={<Icon.Repo size={11} />}>1 override</Chip>
      </HStack>
    </Card>
  );
}

// ═════════════════════════════════════════════════════════════
// GLOBAL SCREEN
// ═════════════════════════════════════════════════════════════

const GLOBAL_TOC = [
  { id: 'ops',      label: 'Operations' },
  { id: 'adapters', label: 'Adapters' },
  { id: 'registry', label: 'Agent registry' },
  { id: 'agents',   label: 'Default agents' },
  { id: 'prompts',  label: 'Default prompts' },
  { id: 'tags',     label: 'Default tags' },
];

function CV2GlobalHeader() {
  return (
    <div style={{ padding: '24px 28px 18px', borderBottom: '1px solid var(--line)', background: 'var(--paper)', flexShrink: 0 }}>
      <HStack gap={12} align="baseline" style={{ marginBottom: 6 }}>
        <Icon.Settings size={18} style={{ color: 'var(--accent)' }} />
        <T kind="h1" style={{ fontSize: 26, letterSpacing: '-0.02em' }}>Global</T>
        <Badge tone="neutral" size="md" variant="outline">defaults for 4 repos</Badge>
        <span style={{ flex: 1 }} />
        <Segmented value="settings" options={[
          { value: 'settings', label: 'Settings' },
          { value: 'resolved', label: 'Resolved across repos' },
        ]} />
        <Button variant="ghost" size="md">Export TOML</Button>
      </HStack>
      <HStack gap={14}>
        <T kind="mono-sm" color="var(--ink-3)">~/.quay/config.toml</T>
        <T kind="mono-sm" color="var(--ink-4)">·</T>
        <T kind="mono-sm" color="var(--ink-3)">resolved via $QUAY_CONFIG_FILE</T>
        <T kind="mono-sm" color="var(--ink-4)">·</T>
        <T kind="mono-sm" color="var(--ink-3)">quay v0.1.0+abcdef1</T>
      </HStack>
    </div>
  );
}

function CV2GlobalForm() {
  return (
    <div style={{
      flex: 1, overflow: 'hidden', display: 'flex',
      padding: '32px 28px 0', gap: 28, alignItems: 'flex-start',
    }}>
      {/* Main column */}
      <div style={{ flex: 1, minWidth: 0 }}>

        {/* 01 · Operations */}
        <CV2Section n="01" id="ops" title="Operations" hint="tick · supervisor · claims · paths">
          <CV2SubGroup title="Concurrency" hint="how many workers tick may have in flight">
            <CV2Field label="MAX_CONCURRENT"           value="4" source="global-only" suffix={<Chip>workers</Chip>} />
            <CV2Field label="MAX_CONCURRENT_REVIEWERS" value="2" source="global-only" suffix={<Chip>reviewers</Chip>} />
          </CV2SubGroup>
          <CV2SubGroup title="Budgets" hint="copied onto new tasks at enqueue time">
            <CV2Field label="RETRY_BUDGET" value="5" source="global-only" suffix={<Chip>per task</Chip>} dirty />
            <CV2Field label="MAX_NON_BUDGET_RESPAWNS" value="20" source="global-only" />
          </CV2SubGroup>
          <CV2SubGroup title="Live-worker thresholds" hint="when does tick kill a stuck worker">
            <CV2Field label="MAX_ATTEMPT_DURATION" value="3600s" source="global-only" />
            <CV2Field label="STALENESS_THRESHOLD"  value="600s"  source="global-only" />
            <CV2Field label="MAX_SPAWN_FAILURES"   value="3"     source="global-only" suffix={<Chip>→ worktree_error</Chip>} />
            <CV2Field label="SUPERVISOR_LOCK_STALE" value="30s"  source="global-only" />
          </CV2SubGroup>
          <CV2SubGroup title="Claims" hint="orchestrator claim lifecycle">
            <CV2Field label="CLAIM_TIMEOUT"         value="1800s" source="global-only" />
            <CV2Field label="MAX_CLAIM_EXPIRATIONS" value="3"     source="global-only" suffix={<Chip>→ orchestrator_loop</Chip>} />
          </CV2SubGroup>
          <CV2SubGroup title="Paths" columns={3}>
            <CV2Field label="DATA_DIR"      value="/var/lib/quay"            source="global-only" />
            <CV2Field label="REPOS_ROOT"    value="/var/lib/quay/repos"      source="global-only" />
            <CV2Field label="WORKTREE_ROOT" value="/var/lib/quay/worktrees"  source="global-only" />
          </CV2SubGroup>
        </CV2Section>

        {/* 02 · Adapters */}
        <CV2Section n="02" id="adapters" title="Adapters" hint="how Quay reaches the outside world">
          <Card padding={18} style={{ marginBottom: 12 }}>
            <HStack gap={10} style={{ marginBottom: 14 }}>
              <T kind="h4">Linear</T>
              <Toggle checked />
              <span style={{ flex: 1 }} />
              <HStack gap={5}>
                <StatusDot tone="good" />
                <T kind="mono-sm" color="var(--ink-3)">env set on running tick</T>
              </HStack>
            </HStack>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <CV2Field label="API_KEY_ENV" value="LINEAR_API_KEY" source="global-only" suffix={<StatusDot tone="good" />} />
              <CV2Field label="WORKSPACE_ID" value="acme-co-prod"   source="global-only" />
            </div>
          </Card>
          <Card padding={18} style={{ marginBottom: 12 }}>
            <HStack gap={10} style={{ marginBottom: 14 }}>
              <T kind="h4">Slack</T>
              <Toggle checked />
              <span style={{ flex: 1 }} />
              <HStack gap={5}>
                <StatusDot tone="good" />
                <T kind="mono-sm" color="var(--ink-3)">env set on running tick</T>
              </HStack>
            </HStack>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
              <CV2Field label="BOT_TOKEN_ENV"        value="SLACK_TOKEN"  source="global-only" suffix={<StatusDot tone="good" />} />
              <CV2Field label="MAX_THREAD_MESSAGES" value="200"          source="global-only" />
              <CV2Field label="POST_AS"              value="quay-bot"     source="global-only" mono={false} />
            </div>
          </Card>
          <Card padding={18}>
            <HStack gap={10} style={{ marginBottom: 14 }}>
              <T kind="h4">GitHub reviewer</T>
              <Toggle checked />
              <span style={{ flex: 1 }} />
              <HStack gap={5}>
                <StatusDot tone="warn" />
                <T kind="mono-sm" color="var(--warn-ink)">env QUAY_REVIEWER_GH_TOKEN not set</T>
              </HStack>
            </HStack>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
              <CV2Field label="REVIEWER_TOKEN_ENV"     value="QUAY_REVIEWER_GH_TOKEN" source="global-only" suffix={<StatusDot tone="warn" />} />
              <CV2Field label="LOGIN"                 value="quay-bot"               source="global-only" />
              <CV2Field label="GATE_QUAY_OWNED_DONE"  value="false"                  source="global-only" />
            </div>
          </Card>
        </CV2Section>

        {/* 03 · Agent registry */}
        <CV2Section n="03" id="registry" title="Agent registry"
          hint="invocations available to all repos · each defines how to spawn"
          right={<Button variant="secondary" size="sm" leading={<Icon.Plus size={12} />}>New invocation</Button>}>
          {CV2_INVOCATIONS.map(inv => (
            <Card key={inv.name} padding={18} style={{ marginBottom: 12 }}>
              <HStack gap={10} style={{ marginBottom: 12 }}>
                <Icon.Bot size={14} style={{ color: 'var(--ink-3)' }} />
                <T kind="h4" style={{ fontFamily: 'var(--mono)' }}>{inv.name}</T>
                {inv.role.includes('worker') && <Badge tone="accent" size="sm" variant="outline">worker</Badge>}
                {inv.role.includes('reviewer') && <Badge tone="warn" size="sm" variant="outline">reviewer</Badge>}
                {inv.capabilities.map(c => <Chip key={c} tone="accent" selected>{c}</Chip>)}
                <span style={{ flex: 1 }} />
                <T kind="mono-sm" color="var(--ink-3)">{inv.usedByRepos} repos · {inv.usedByTasks} live tasks</T>
                <Icon.More size={14} style={{ color: 'var(--ink-4)' }} />
              </HStack>
              <div style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', padding: '8px 12px' }}>
                <T kind="mono-sm" color="var(--ink-2)" style={{ display: 'block', whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.55 }}>
                  {inv.cmd}
                </T>
              </div>
            </Card>
          ))}
        </CV2Section>

        {/* 04 · Default agents */}
        <CV2Section n="04" id="agents" title="Default agents"
          hint="what runs unless a repo overrides">
          <CV2SubGroup title="Worker">
            <CV2Field label="AGENT" value="claude"             source="global-only" />
            <CV2Field label="MODEL" value="claude-opus-4-1"    source="global-only" />
          </CV2SubGroup>
          <CV2SubGroup title="Reviewer">
            <CV2Field label="AGENT" value="claude"             source="global-only" />
            <CV2Field label="MODEL" value="claude-opus-4-1"    source="global-only" />
          </CV2SubGroup>
        </CV2Section>

        {/* 05 · Default prompts */}
        <CV2Section n="05" id="prompts" title="Default prompts"
          hint="preambles + attempt guidance · referenced by every spawn"
          right={<Button variant="ghost" size="sm" leading={<Icon.Sparkle size={12} />}>Composed preview</Button>}>
          <CV2PreambleCard
            kind="code" title="Worker preamble" version={3}
            body={WORKER_PREAMBLE_BODY}
            refs={247} lastEdited="today, 14:22"
          />
          <CV2PreambleCard
            kind="review" title="Reviewer preamble" version={5}
            body={REVIEWER_PREAMBLE_PREVIEW}
            refs={89} lastEdited="3d ago"
          />

          <Card padding={18}>
            <HStack gap={10} style={{ marginBottom: 12 }}>
              <Icon.Sparkle size={14} style={{ color: 'var(--accent)' }} />
              <T kind="h4">Attempt-guidance templates</T>
              <T kind="mono-sm" color="var(--ink-3)">· short per-reason inserts; routed by the spawner</T>
              <span style={{ flex: 1 }} />
              <Button variant="ghost" size="sm" leading={<Icon.Plus size={12} />}>New reason</Button>
            </HStack>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {[
                { reason: 'initial',                  body: 'Begin the initial implementation of the task objective above. Follow the protocol preamble; complete the task or exit cleanly with a blocker.', v: 2, refs: 247 },
                { reason: 'retry-after-ci-fail',      body: 'The previous attempt opened a PR but CI failed. Investigate the failure, fix it, and update the PR. Do not open a duplicate PR.',           v: 4, refs: 38 },
                { reason: 'retry-after-review-cr',    body: 'A reviewer requested changes on your previous attempt. The diagnostics contain the full review JSON. Address each blocking finding…',     v: 3, refs: 12 },
                { reason: 'retry-after-conflict',     body: 'Your branch has merge conflicts against the base branch. Resolve them locally and push.',                                                   v: 1, refs: 3 },
                { reason: 'orchestrator-submit',      body: 'You are running because the orchestrator submitted a sub-brief. The brief below is the canonical objective for this attempt only.',         v: 2, refs: 8 },
              ].map(g => (
                <div key={g.reason} style={{
                  border: '1px solid var(--line)', borderRadius: 'var(--r-sm)',
                  background: 'var(--surface)', padding: '10px 12px',
                }}>
                  <HStack gap={6} style={{ marginBottom: 6 }}>
                    <T kind="mono" style={{ fontWeight: 500 }}>{g.reason}</T>
                    <Badge tone="accent" size="sm" variant="outline">v{g.v}</Badge>
                    <span style={{ flex: 1 }} />
                    <T kind="mono-sm" color="var(--ink-4)">{g.refs} ref</T>
                  </HStack>
                  <T kind="body-sm" color="var(--ink-2)" style={{
                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                    overflow: 'hidden', lineHeight: 1.45,
                  }}>{g.body}</T>
                </div>
              ))}
            </div>
          </Card>
        </CV2Section>

        {/* 06 · Default tags */}
        <CV2Section n="06" id="tags" title="Default tags"
          hint="deployment-wide namespaces · every repo inherits these"
          right={<Button variant="secondary" size="sm" leading={<Icon.Plus size={12} />}>New namespace</Button>}>
          <Card padding={18}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {[
                { ns: 'type', required: true,  values: ['feature', 'bug', 'chore', 'spike'] },
                { ns: 'priority', required: false, values: ['p0', 'p1', 'p2', 'p3'] },
              ].map(n => (
                <div key={n.ns}>
                  <HStack gap={8} style={{ marginBottom: 6 }}>
                    <T kind="mono" style={{ fontWeight: 500 }}>{n.ns}</T>
                    {n.required && <Badge tone="danger" size="sm">REQUIRED</Badge>}
                    <span style={{ flex: 1 }} />
                    <T kind="mono-sm" color="var(--ink-3)">inherited by 4 repos · 2 repos extend</T>
                  </HStack>
                  <HStack gap={5} wrap>
                    {n.values.map(v => <Chip key={v} tone="accent" selected>{n.ns}-{v}</Chip>)}
                    <Chip leading={<Icon.Plus size={10} />}>value</Chip>
                  </HStack>
                </div>
              ))}
            </div>
          </Card>
        </CV2Section>

      </div>

      {/* TOC */}
      <CV2Toc items={GLOBAL_TOC} active="prompts" />
    </div>
  );
}

function CV2GlobalScreen() {
  return (
    <div className="hf" style={{ width: CV2_W, minHeight: CV2_H_LONG, display: 'flex', flexDirection: 'column' }}>
      <HFGlobalStyles />
      <CV2TopBar scope="Global" />
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <CV2LeftRail activeScope="global" />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: 'var(--paper-2)' }}>
          <CV2GlobalHeader />
          <CV2GlobalForm />
          <div style={{ height: 60 }} />
          <CV2SaveFooter count={1} summary="retry_budget · 4 → 5 · applies to new enqueues only" />
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
// REPO SCREEN (acme-orders)
// ═════════════════════════════════════════════════════════════

const REPO_TOC = [
  { id: 'overview', label: 'Overview' },
  { id: 'identity', label: 'Identity & checkout' },
  { id: 'agents',   label: 'Agents' },
  { id: 'prompts',  label: 'Prompts' },
  { id: 'tags',     label: 'Tags' },
];

function CV2RepoHeader() {
  return (
    <div style={{ padding: '24px 28px 18px', borderBottom: '1px solid var(--line)', background: 'var(--paper)', flexShrink: 0 }}>
      <HStack gap={12} align="baseline" style={{ marginBottom: 6 }}>
        <Icon.Repo size={18} style={{ color: 'var(--accent)' }} />
        <T kind="h1" style={{ fontSize: 26, letterSpacing: '-0.02em', fontFamily: 'var(--mono)' }}>acme-orders</T>
        <Badge tone="good" dot>ACTIVE</Badge>
        <Badge tone="accent" size="md">5 ACTIVE TASKS</Badge>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" size="md" leading={<Icon.ExternalLink size={13} />}>GitHub</Button>
        <Button variant="danger" size="md">Archive repo</Button>
      </HStack>
      <HStack gap={14}>
        <T kind="mono-sm" color="var(--ink-3)">git@github.com:acme/orders.git</T>
        <T kind="mono-sm" color="var(--ink-4)">·</T>
        <T kind="mono-sm" color="var(--ink-3)">~/.quay/repos/acme-orders.git</T>
        <T kind="mono-sm" color="var(--ink-4)">·</T>
        <T kind="mono-sm" color="var(--ink-3)">4 overrides from Global</T>
      </HStack>
    </div>
  );
}

// ── Composed preview pane ────────────────────────────────────
function CV2ComposedPreview() {
  return (
    <Card padding={0} style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column', flexShrink: 0, width: 360 }}>
      <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--line)', background: 'var(--surface-2)' }}>
        <HStack gap={6}>
          <Icon.Sparkle size={13} style={{ color: 'var(--accent)' }} />
          <T kind="h4">Composed preview</T>
          <span style={{ flex: 1 }} />
          <Button variant="ghost" size="sm">Full</Button>
        </HStack>
        <T kind="mono-sm" color="var(--ink-3)" style={{ display: 'block', marginTop: 4 }}>
          what a worker sees for this repo
        </T>
      </div>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--line)', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <HStack gap={6}>
          <T kind="caption" color="var(--ink-3)" style={{ width: 56 }}>reason</T>
          <Segmented value="initial" options={[
            { value: 'initial', label: 'initial' },
            { value: 'ci',      label: 'retry-CI' },
          ]} />
        </HStack>
      </div>
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10, overflow: 'hidden' }}>
        {[
          { tone: 'accent', label: '1 · PREAMBLE',           src: 'Worker preamble v3 · global',
            body: 'Quay protocol preamble (v1)\n\n1. If you cannot make progress…\n2. Exit when (a) PR opened…\n[…]' },
          { tone: 'accent', label: '1b · PREAMBLE EXTENSION', src: 'acme-orders override',
            body: '## acme-orders local conventions\n\n- Hono routes: validation → auth → handler\n- Money is integer cents\n[…]' },
          { tone: 'neutral', label: '2 · TASK OBJECTIVE',     src: 'from ticket',
            body: '<quay-task-objective …>\n…\n</quay-task-objective>' },
          { tone: 'warn',    label: '3 · ATTEMPT GUIDANCE',   src: 'initial · global v2',
            body: '<quay-current-attempt-guidance reason="initial">\nBegin the initial implementation…\n</quay-current-attempt-guidance>' },
        ].map((s, i) => {
          const t = HF_TONES[s.tone];
          return (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <HStack gap={6}>
                <span style={{ width: 3, height: 12, background: t.dot, borderRadius: 1 }} />
                <T kind="caption" color={t.fg}>{s.label}</T>
                <span style={{ flex: 1 }} />
                <T kind="mono-sm" color="var(--ink-4)" style={{ fontSize: 10 }}>{s.src}</T>
              </HStack>
              <div style={{
                padding: '6px 9px',
                background: 'var(--surface-2)',
                border: `1px solid ${t.line}`, borderRadius: 'var(--r-sm)',
                fontFamily: 'var(--mono)', fontSize: 10.5, lineHeight: 1.5,
                color: 'var(--ink-2)', whiteSpace: 'pre-wrap',
              }}>{s.body}</div>
            </div>
          );
        })}
      </div>
      <div style={{ padding: '10px 14px', borderTop: '1px solid var(--line)', background: 'var(--surface-2)' }}>
        <HStack gap={10}>
          <T kind="caption" color="var(--ink-3)">tokens</T>
          <T kind="mono-sm" style={{ fontWeight: 500 }}>2,841</T>
          <span style={{ flex: 1 }} />
          <T kind="caption" color="var(--ink-3)">bytes</T>
          <T kind="mono-sm" style={{ fontWeight: 500 }}>11,392</T>
        </HStack>
      </div>
    </Card>
  );
}

function CV2RepoForm() {
  return (
    <div style={{
      flex: 1, overflow: 'hidden', display: 'flex',
      padding: '32px 28px 0', gap: 28, alignItems: 'flex-start',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>

        {/* 01 · Overview */}
        <CV2Section n="01" id="overview" title="Overview">
          <Card padding={20}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 24 }}>
              {[
                { l: 'Active tasks', v: '5', s: 'in flight · 2 in review' },
                { l: 'Base branch',  v: 'main', s: 'protected · 2 approvers' },
                { l: 'Last sync',    v: '3h ago', s: 'auto · every 6h' },
                { l: 'Created',      v: '2026-01-08', s: '142 days ago' },
              ].map(b => (
                <div key={b.l}>
                  <T kind="caption" color="var(--ink-3)" style={{ display: 'block' }}>{b.l}</T>
                  <T kind="h3" style={{ display: 'block', marginTop: 4, fontFamily: 'var(--mono)' }}>{b.v}</T>
                  <T kind="mono-sm" color="var(--ink-3)" style={{ display: 'block', marginTop: 2 }}>{b.s}</T>
                </div>
              ))}
            </div>
          </Card>
        </CV2Section>

        {/* 02 · Identity */}
        <CV2Section n="02" id="identity" title="Identity & checkout" hint="repo-only · no global equivalent">
          <CV2SubGroup title="Source">
            <CV2Field fullRow label="REPO_URL" value="git@github.com:acme/orders.git" source="repo-only" />
            <CV2Field label="REPO_ID"     value="acme-orders" source="repo-only" />
            <CV2Field label="BASE_BRANCH" value="main"        source="repo-only" />
          </CV2SubGroup>
          <CV2SubGroup title="Build" hint="run inside each new worktree">
            <CV2Field label="PACKAGE_MANAGER" value="bun"                            source="repo-only" />
            <CV2Field label="TEST_CMD"        value="bun test"                       source="repo-only" />
            <CV2Field fullRow label="INSTALL_CMD" value="bun install --frozen-lockfile" source="repo-only" dirty />
            <CV2Field label="CI_WORKFLOW"     value="CI"                              source="repo-only" />
            <CV2Field label="CONTRIBUTION_GUIDE" value="CONTRIBUTING.md"               source="repo-only" />
          </CV2SubGroup>
        </CV2Section>

        {/* 03 · Agents */}
        <CV2Section n="03" id="agents" title="Agents"
          hint="overrides global default for this repo · task may further override at enqueue">
          <CV2SubGroup title="Worker">
            <CV2Field label="AGENT" value="hermes_codex_browser" source="override" inheritedValue="claude" />
            <CV2Field label="MODEL" value="gpt-5.3"              source="override" inheritedValue="claude-opus-4-1" />
          </CV2SubGroup>
          <CV2SubGroup title="Reviewer">
            <CV2Field label="AGENT" value="claude"           source="inherits" inheritedValue="from [agents].reviewer" />
            <CV2Field label="MODEL" value="claude-opus-4-1"  source="inherits" inheritedValue="from [agents].reviewer_model" />
          </CV2SubGroup>
        </CV2Section>

        {/* 04 · Prompts */}
        <CV2Section n="04" id="prompts" title="Prompts"
          hint="inherit · extend · replace · per kind">
          <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start' }}>

            {/* Prompts cards */}
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* Worker preamble — EXTEND */}
              <Card padding={18}>
                <HStack gap={10} style={{ marginBottom: 12 }}>
                  <Icon.Anchor size={14} style={{ color: 'var(--accent)' }} />
                  <T kind="h4">Worker preamble</T>
                  <Badge tone="accent" size="sm">extends global v3</Badge>
                  <span style={{ flex: 1 }} />
                  <Segmented value="extend" options={[
                    { value: 'inherit', label: 'Inherit' },
                    { value: 'extend',  label: 'Extend' },
                    { value: 'replace', label: 'Replace' },
                  ]} />
                </HStack>
                <T kind="body-sm" color="var(--ink-3)" style={{ display: 'block', marginBottom: 10 }}>
                  Appended after the global worker preamble. Global edits flow through automatically.
                </T>
                <div style={{
                  background: 'var(--surface-2)', border: '1px solid var(--line)',
                  borderRadius: 'var(--r-sm)', padding: '10px 14px',
                  fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.6,
                  color: 'var(--ink-2)', whiteSpace: 'pre-wrap',
                }}>{ORDERS_PREAMBLE_EXTENSION}</div>
                <HStack gap={6} style={{ marginTop: 10 }}>
                  <T kind="mono-sm" color="var(--ink-3)">{ORDERS_PREAMBLE_EXTENSION.length} bytes · 4 rules</T>
                  <span style={{ flex: 1 }} />
                  <Button variant="ghost" size="sm">Versions (2)</Button>
                  <Button variant="secondary" size="sm">Edit</Button>
                </HStack>
              </Card>

              {/* Reviewer preamble — INHERIT */}
              <Card padding={18}>
                <HStack gap={10} style={{ marginBottom: 10 }}>
                  <Icon.Anchor size={14} style={{ color: 'var(--ink-3)' }} />
                  <T kind="h4">Reviewer preamble</T>
                  <Badge tone="neutral" size="sm" variant="outline">inherits global v5</Badge>
                  <span style={{ flex: 1 }} />
                  <Segmented value="inherit" options={[
                    { value: 'inherit', label: 'Inherit' },
                    { value: 'extend',  label: 'Extend' },
                    { value: 'replace', label: 'Replace' },
                  ]} />
                </HStack>
                <T kind="body-sm" color="var(--ink-3)" style={{ display: 'block', lineHeight: 1.5 }}>
                  No override. This repo uses the global reviewer preamble (v5) verbatim. Edit it in <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>Global › Default prompts</span>.
                </T>
              </Card>
            </div>

            {/* Composed preview */}
            <CV2ComposedPreview />
          </div>
        </CV2Section>

        {/* 05 · Tags */}
        <CV2Section n="05" id="tags" title="Tags"
          hint="extends deployment vocab"
          right={<Button variant="secondary" size="sm" leading={<Icon.Plus size={12} />}>New namespace</Button>}>
          <Card padding={18}>
            <T kind="caption" color="var(--ink-3)" style={{ display: 'block', marginBottom: 10 }}>PER-REPO NAMESPACES · 2 · editable</T>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <HStack gap={8} style={{ marginBottom: 6 }}>
                  <T kind="mono" style={{ fontWeight: 500 }}>area</T>
                  <Badge tone="danger" size="sm">REQUIRED</Badge>
                  <span style={{ flex: 1 }} />
                  <Toggle checked label="required" />
                </HStack>
                <HStack gap={5} wrap>
                  <Chip tone="accent" selected onRemove>area-cart</Chip>
                  <Chip tone="accent" selected onRemove>area-checkout</Chip>
                  <Chip tone="accent" selected onRemove>area-pricing</Chip>
                  <Chip tone="accent" selected onRemove>area-refunds</Chip>
                  <Chip leading={<Icon.Plus size={10} />}>value</Chip>
                </HStack>
              </div>
              <div>
                <HStack gap={8} style={{ marginBottom: 6 }}>
                  <T kind="mono" style={{ fontWeight: 500 }}>risk</T>
                </HStack>
                <HStack gap={5} wrap>
                  <Chip tone="danger" selected onRemove>risk-payments</Chip>
                  <Chip tone="danger" selected onRemove>risk-data-loss</Chip>
                  <Chip leading={<Icon.Plus size={10} />}>value</Chip>
                </HStack>
              </div>
            </div>
            <Divider dashed style={{ margin: '16px 0' }} />
            <HStack gap={8} style={{ marginBottom: 10 }}>
              <Icon.Arrow size={11} dir="up" style={{ color: 'var(--ink-4)' }} />
              <T kind="mono-sm" color="var(--ink-3)">inherited from global · read-only here · edit in Global › Default tags</T>
            </HStack>
            <div style={{ opacity: 0.7, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[
                { ns: 'type',     req: true,  values: ['feature','bug','chore','spike'] },
                { ns: 'priority', req: false, values: ['p0','p1','p2','p3'] },
              ].map(n => (
                <div key={n.ns}>
                  <HStack gap={8} style={{ marginBottom: 4 }}>
                    <T kind="mono" style={{ fontWeight: 500 }}>{n.ns}</T>
                    {n.req && <Badge tone="neutral" size="sm">REQUIRED</Badge>}
                  </HStack>
                  <HStack gap={5} wrap>
                    {n.values.map(v => <Chip key={v}>{n.ns}-{v}</Chip>)}
                  </HStack>
                </div>
              ))}
            </div>
          </Card>
        </CV2Section>
      </div>

      <CV2Toc items={REPO_TOC} active="prompts" />
    </div>
  );
}

function CV2RepoScreen() {
  return (
    <div className="hf" style={{ width: CV2_W, minHeight: CV2_H_LONG, display: 'flex', flexDirection: 'column' }}>
      <HFGlobalStyles />
      <CV2TopBar scope="acme-orders" />
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <CV2LeftRail activeScope="acme-orders" />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: 'var(--paper-2)' }}>
          <CV2RepoHeader />
          <CV2RepoForm />
          <div style={{ height: 60 }} />
          <CV2SaveFooter count={1} summary="install_cmd · &quot;bun install&quot; → &quot;bun install --frozen-lockfile&quot;" />
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════
// RESOLVED ACROSS REPOS — matrix view (secondary tab on Global)
// ═════════════════════════════════════════════════════════════

function CV2MatrixScreen() {
  const repos = ['acme-orders', 'acme-api', 'acme-web', 'acme-mobile'];
  const rows = [
    { group: 'AGENTS', label: 'worker agent',    key: 'agent_worker',
      def: 'claude', vals: { 'acme-orders': 'hermes_codex_browser', 'acme-api': null, 'acme-web': 'claude', 'acme-mobile': null } },
    { group: 'AGENTS', label: 'worker model',    key: 'model_worker',
      def: 'claude-opus-4-1', vals: { 'acme-orders': 'gpt-5.3', 'acme-api': null, 'acme-web': null, 'acme-mobile': null } },
    { group: 'AGENTS', label: 'reviewer agent',  key: 'agent_reviewer',
      def: 'claude', vals: { 'acme-orders': null, 'acme-api': null, 'acme-web': 'claude', 'acme-mobile': null } },
    { group: 'AGENTS', label: 'reviewer model',  key: 'model_reviewer',
      def: 'claude-opus-4-1', vals: { 'acme-orders': null, 'acme-api': 'claude-opus-4-1', 'acme-web': null, 'acme-mobile': null } },
    { group: 'PROMPTS', label: 'worker preamble', key: 'worker_preamble',
      def: 'global v3', vals: { 'acme-orders': 'extends · v3 + 4 rules', 'acme-api': null, 'acme-web': null, 'acme-mobile': null } },
    { group: 'PROMPTS', label: 'reviewer preamble', key: 'reviewer_preamble',
      def: 'global v5', vals: { 'acme-orders': null, 'acme-api': 'replaces · 1.2 KB', 'acme-web': null, 'acme-mobile': null } },
    { group: 'TAGS', label: 'area namespace',   key: 'tag_area',
      def: '—', vals: { 'acme-orders': '4 values · required', 'acme-api': '3 values', 'acme-web': null, 'acme-mobile': null } },
    { group: 'TAGS', label: 'risk namespace',   key: 'tag_risk',
      def: '—', vals: { 'acme-orders': '2 values', 'acme-api': null, 'acme-web': null, 'acme-mobile': null } },
  ];

  function Cell({ value, inherited, wins }) {
    if (value == null && inherited == null) {
      return <div style={{ padding: '8px 12px', color: 'var(--ink-4)', textAlign: 'center', opacity: 0.4 }}>—</div>;
    }
    const isOverride = value != null;
    return (
      <div style={{
        padding: '8px 12px',
        background: wins ? 'var(--accent-soft)' : 'transparent',
        borderRight: '1px solid var(--line)',
        borderTop: wins ? '1px solid var(--accent)' : 'none',
        borderBottom: wins ? '1px solid var(--accent)' : 'none',
        display: 'flex', alignItems: 'center', gap: 5,
        minHeight: 38,
      }}>
        <T kind="mono-sm" color={isOverride ? 'var(--ink)' : 'var(--ink-3)'} style={{
          flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          fontStyle: isOverride ? 'normal' : 'italic',
        }}>
          {isOverride ? value : `↑ ${inherited}`}
        </T>
        {wins && <Badge tone="accent" size="sm" variant="solid">override</Badge>}
      </div>
    );
  }

  return (
    <div className="hf" style={{ width: CV2_W, height: CV2_H, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <HFGlobalStyles />
      <CV2TopBar scope="Global" />
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <CV2LeftRail activeScope="global" />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: 'var(--paper)' }}>
          {/* Header */}
          <div style={{ padding: '24px 28px 18px', borderBottom: '1px solid var(--line)' }}>
            <HStack gap={12} align="baseline" style={{ marginBottom: 6 }}>
              <Icon.Settings size={18} style={{ color: 'var(--accent)' }} />
              <T kind="h1" style={{ fontSize: 26, letterSpacing: '-0.02em' }}>Global</T>
              <Badge tone="neutral" size="md" variant="outline">defaults for 4 repos</Badge>
              <span style={{ flex: 1 }} />
              <Segmented value="resolved" options={[
                { value: 'settings', label: 'Settings' },
                { value: 'resolved', label: 'Resolved across repos' },
              ]} />
            </HStack>
            <T kind="body-sm" color="var(--ink-3)">
              Every overridable setting, side by side. Highlighted cells show repo-level overrides; arrows mean "falls back to global default".
            </T>
          </div>

          {/* Toolbar */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '10px 28px',
            borderBottom: '1px solid var(--line)', background: 'var(--paper)',
          }}>
            <Chip tone="accent" selected>All keys <T kind="mono-sm" color="var(--ink-3)" style={{ marginLeft: 4 }}>8</T></Chip>
            <Chip>Overrides only <T kind="mono-sm" color="var(--ink-4)" style={{ marginLeft: 4 }}>7</T></Chip>
            <Chip leading={<Icon.Filter size={11} />}>Group: domain ▾</Chip>
            <span style={{ flex: 1 }} />
            <HStack gap={6}>
              <T kind="caption" color="var(--ink-3)">LEGEND</T>
              <HStack gap={3}><span style={{ width: 14, height: 14, background: 'var(--accent-soft)', border: '1px solid var(--accent)' }} /><T kind="mono-sm" color="var(--ink-3)">override</T></HStack>
              <HStack gap={3}><T kind="mono-sm" color="var(--ink-3)">↑ inherits</T></HStack>
            </HStack>
          </div>

          {/* Matrix */}
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {/* Column headers */}
            <div style={{
              display: 'grid', gridTemplateColumns: '220px 160px repeat(4, 1fr) 60px',
              borderBottom: '1px solid var(--ink)', background: 'var(--surface-2)',
            }}>
              <div style={{ padding: '10px 14px' }}><T kind="caption" color="var(--ink-2)">KEY</T></div>
              <div style={{ padding: '10px 12px', borderLeft: '1px solid var(--line)' }}>
                <T kind="caption" color="var(--ink-2)">GLOBAL DEFAULT</T>
              </div>
              {repos.map(r => (
                <div key={r} style={{ padding: '10px 12px', borderLeft: '1px solid var(--line)' }}>
                  <T kind="mono" style={{ fontWeight: 600, display: 'block' }}>{r}</T>
                  <T kind="mono-sm" color="var(--ink-3)">{CV2_REPOS.find(x => x.id === r).active} active</T>
                </div>
              ))}
              <div style={{ padding: '10px 8px', borderLeft: '1px solid var(--line)', textAlign: 'center' }}>
                <T kind="caption" color="var(--ink-3)">···</T>
              </div>
            </div>

            {/* Rows grouped */}
            <div style={{ flex: 1, overflow: 'hidden' }}>
              {(() => {
                const out = [];
                let lastGroup = null;
                rows.forEach((r, ix) => {
                  if (r.group !== lastGroup) {
                    out.push(
                      <div key={'g' + ix} style={{ padding: '10px 14px', background: 'var(--paper-2)', borderBottom: '1px solid var(--line)', borderTop: lastGroup ? '1px solid var(--line-2)' : 'none' }}>
                        <T kind="caption" color="var(--ink-2)" style={{ fontWeight: 600, letterSpacing: '0.08em' }}>{r.group}</T>
                      </div>
                    );
                    lastGroup = r.group;
                  }
                  out.push(
                    <div key={ix} style={{
                      display: 'grid', gridTemplateColumns: '220px 160px repeat(4, 1fr) 60px',
                      borderBottom: '1px solid var(--line)', alignItems: 'stretch',
                    }}>
                      <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                        <T kind="body-sm" style={{ fontWeight: 500, display: 'block' }}>{r.label}</T>
                        <T kind="mono-sm" color="var(--ink-3)" style={{ display: 'block' }}>{r.key}</T>
                      </div>
                      <Cell value={r.def} inherited={null} />
                      {repos.map(rc => {
                        const v = r.vals[rc];
                        return <Cell key={rc} value={v} inherited={v == null ? r.def : null} wins={v != null} />;
                      })}
                      <div style={{ padding: '10px 8px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <Icon.More size={13} style={{ color: 'var(--ink-4)' }} />
                      </div>
                    </div>
                  );
                });
                return out;
              })()}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, {
  CV2GlobalScreen, CV2RepoScreen, CV2MatrixScreen,
  CV2_W, CV2_H, CV2_H_LONG,
});
