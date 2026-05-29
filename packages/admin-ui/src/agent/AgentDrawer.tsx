import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Avatar } from '../components/Avatar';
import { Button } from '../components/Button';
import { Kbd } from '../components/Kbd';
import { HStack } from '../components/Stack';
import { StatusDot } from '../components/StatusDot';
import { T } from '../components/Typography';
import { Icon } from '../icons/Icon';
import { TONES, type Tone } from '../styles/tones';
import {
  type AgentAdapter,
  type AgentContext,
  type AgentEvent,
  type CommandEvent,
  type RefEvent,
} from './agentData';

type AgentPart =
  | { id: number; kind: 'tool'; label: string; detail?: string; status: 'running' | 'done'; ms: number }
  | { id: number; kind: 'text'; text: string; done: boolean }
  | { id: number; kind: 'ref'; refKind: RefEvent['kind']; refId: string; label: string; meta?: string; tone?: Tone }
  | {
      id: number;
      kind: 'cmd';
      cmd: string;
      desc: string;
      affects: CommandEvent['affects'];
      note: string;
      runTone?: Tone;
      result: CommandEvent['result'];
      state: 'proposed' | 'running' | 'ran' | 'cancelled';
      output: string[];
    };

interface AgentMessage {
  id: number;
  role: 'user' | 'agent';
  model?: string;
  ts: Date;
  streaming?: boolean;
  parts: AgentPart[];
}

interface AgentDrawerProps {
  open: boolean;
  onClose: () => void;
  adapter: AgentAdapter;
  ctx: AgentContext;
}

export function AgentDrawer({ open, onClose, adapter, ctx }: AgentDrawerProps) {
  return (
    <>
      <div className="qa-backdrop" data-open={open ? '1' : '0'} onClick={onClose} />
      <aside className="qa-drawer" data-open={open ? '1' : '0'} aria-hidden={!open}>
        <AgentPanel adapter={adapter} ctx={ctx} onClose={onClose} />
      </aside>
    </>
  );
}

interface AgentTriggerProps {
  open: boolean;
  onToggle: () => void;
}

export function AgentTrigger({ open, onToggle }: AgentTriggerProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title="Quay Agent (Cmd+J)"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        height: 30,
        padding: '0 10px',
        background: open ? 'var(--accent-soft)' : 'var(--surface)',
        border: `1px solid ${open ? 'var(--accent-line)' : 'var(--line-2)'}`,
        borderRadius: 'var(--r-sm)',
        color: open ? 'var(--accent-ink)' : 'var(--ink-2)',
      }}
    >
      <span style={{ color: open ? 'var(--accent)' : 'var(--ink-3)', display: 'inline-flex' }}>
        <Icon.Bot size={15} />
      </span>
      <T kind="body-sm" style={{ fontWeight: 500 }}>
        Agent
      </T>
      <Kbd size={10}>⌘J</Kbd>
    </button>
  );
}

function AgentPanel({ adapter, ctx, onClose }: { adapter: AgentAdapter; ctx: AgentContext; onClose: () => void }) {
  const thread = useAgentThread(adapter, ctx);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const empty = thread.messages.length === 0;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread.messages]);

  return (
    <div className="qa-agent" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          height: 56,
          padding: '0 10px 0 14px',
          borderBottom: '1px solid var(--line)',
          flexShrink: 0,
        }}
      >
        <AgentMark size={26} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0 }}>
          <T kind="body-strong" style={{ fontSize: 13.5, lineHeight: 1 }}>
            Quay Agent
          </T>
          <HStack gap={5}>
            <StatusDot tone={adapter.status} size={6} />
            <T kind="mono-sm" color="var(--ink-3)" style={{ whiteSpace: 'nowrap', lineHeight: 1 }}>
              {adapter.id} · connected
            </T>
          </HStack>
        </div>
        <IconButton onClick={thread.clear} title="New thread">
          <Icon.Plus size={15} />
        </IconButton>
        <IconButton onClick={onClose} title="Close (Esc)">
          <Icon.X size={15} />
        </IconButton>
      </div>

      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: '18px 14px' }}>
        {empty ? (
          <EmptyState />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            {thread.messages.map((message) => (
              <Turn
                key={message.id}
                msg={message}
                onRun={thread.runCommand}
                onCancel={thread.cancelCommand}
              />
            ))}
          </div>
        )}
      </div>

      <Composer busy={thread.busy} onSend={thread.send} onStop={thread.stop} />
    </div>
  );
}

function useAgentThread(adapter: AgentAdapter, ctx: AgentContext) {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const runRef = useRef(0);
  const idRef = useRef(0);
  const nid = () => {
    idRef.current += 1;
    return idRef.current;
  };

  const setLastParts = (fn: (parts: AgentPart[]) => AgentPart[]) => {
    setMessages((current) => {
      if (current.length === 0) return current;
      const copy = current.slice();
      const last = { ...copy[copy.length - 1]! };
      last.parts = fn(last.parts);
      copy[copy.length - 1] = last;
      return copy;
    });
  };

  const updateLast = (fn: (part: AgentPart) => AgentPart) => {
    setLastParts((parts) => {
      if (parts.length === 0) return parts;
      const copy = parts.slice();
      copy[copy.length - 1] = fn(copy[copy.length - 1]!);
      return copy;
    });
  };

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;

    const myRun = ++runRef.current;
    const agentId = nid();
    setMessages((current) => [
      ...current,
      { id: nid(), role: 'user', ts: new Date(), parts: [{ id: nid(), kind: 'text', text: trimmed, done: true }] },
      { id: agentId, role: 'agent', model: adapter.model, ts: new Date(), streaming: true, parts: [] },
    ]);
    setBusy(true);

    const alive = () => runRef.current === myRun;
    runPlan(adapter.plan(trimmed, ctx), {
      addTool: (event) =>
        setLastParts((parts) => [
          ...parts,
          { id: nid(), kind: 'tool', label: event.label, detail: event.detail, status: 'running', ms: event.ms },
        ]),
      completeTool: () => updateLast((part) => (part.kind === 'tool' ? { ...part, status: 'done' } : part)),
      addText: () => setLastParts((parts) => [...parts, { id: nid(), kind: 'text', text: '', done: false }]),
      growText: (textChunk) => updateLast((part) => (part.kind === 'text' ? { ...part, text: textChunk } : part)),
      doneText: () => updateLast((part) => (part.kind === 'text' ? { ...part, done: true } : part)),
      addRef: (event) =>
        setLastParts((parts) => [
          ...parts,
          {
            id: nid(),
            kind: 'ref',
            refKind: event.kind,
            refId: event.id,
            label: event.label,
            meta: event.meta,
            tone: event.tone,
          },
        ]),
      addCmd: (event) =>
        setLastParts((parts) => [
          ...parts,
          {
            id: nid(),
            kind: 'cmd',
            cmd: event.cmd,
            desc: event.desc,
            affects: event.affects,
            note: event.note,
            runTone: event.runTone,
            result: event.result,
            state: 'proposed',
            output: [],
          },
        ]),
      done: () => {
        setMessages((current) => current.map((message) => (message.id === agentId ? { ...message, streaming: false } : message)));
        setBusy(false);
      },
    }, alive);
  };

  const stop = () => {
    runRef.current += 1;
    setBusy(false);
    setMessages((current) => current.map((message) => (message.streaming ? { ...message, streaming: false } : message)));
  };

  const clear = () => {
    runRef.current += 1;
    setBusy(false);
    setMessages([]);
  };

  const updatePart = (msgId: number, partId: number, fn: (part: AgentPart) => AgentPart) => {
    setMessages((current) =>
      current.map((message) =>
        message.id !== msgId ? message : { ...message, parts: message.parts.map((part) => (part.id === partId ? fn(part) : part)) },
      ),
    );
  };

  const runCommand = (msgId: number, partId: number) => {
    let result: CommandEvent['result'] | null = null;
    updatePart(msgId, partId, (part) => {
      if (part.kind !== 'cmd') return part;
      result = part.result;
      return { ...part, state: 'running', output: [] };
    });
    const commandResult = result as CommandEvent['result'] | null;
    if (!commandResult) return;

    const perLine = Math.max(260, Math.round(commandResult.ms / (commandResult.lines.length + 1)));
    let index = 0;
    const tick = () => {
      if (index < commandResult.lines.length) {
        const line = commandResult.lines[index]!;
        updatePart(msgId, partId, (part) => (part.kind === 'cmd' ? { ...part, output: [...part.output, line] } : part));
        index += 1;
        window.setTimeout(tick, perLine);
      } else {
        updatePart(msgId, partId, (part) => (part.kind === 'cmd' ? { ...part, state: 'ran' } : part));
      }
    };
    window.setTimeout(tick, perLine);
  };

  const cancelCommand = (msgId: number, partId: number) => {
    updatePart(msgId, partId, (part) => (part.kind === 'cmd' ? { ...part, state: 'cancelled' } : part));
  };

  return { messages, busy, send, stop, clear, runCommand, cancelCommand };
}

interface PlanHandlers {
  addTool: (event: Extract<AgentEvent, { t: 'tool' }>) => void;
  completeTool: () => void;
  addText: () => void;
  growText: (text: string) => void;
  doneText: () => void;
  addRef: (event: RefEvent) => void;
  addCmd: (event: CommandEvent) => void;
  done: () => void;
}

function runPlan(plan: AgentEvent[], handlers: PlanHandlers, alive: () => boolean) {
  let index = 0;
  const step = () => {
    if (!alive()) return;
    if (index >= plan.length) {
      handlers.done();
      return;
    }

    const event = plan[index++]!;
    if (event.t === 'tool') {
      handlers.addTool(event);
      window.setTimeout(() => {
        if (!alive()) return;
        handlers.completeTool();
        window.setTimeout(step, 150);
      }, event.ms);
      return;
    }
    if (event.t === 'text') {
      handlers.addText();
      streamText(event.text, handlers.growText, alive, () => {
        handlers.doneText();
        window.setTimeout(step, 130);
      });
      return;
    }
    if (event.t === 'ref') {
      window.setTimeout(() => {
        if (!alive()) return;
        handlers.addRef(event);
        window.setTimeout(step, 130);
      }, 200);
      return;
    }
    if (event.t === 'cmd') {
      window.setTimeout(() => {
        if (!alive()) return;
        handlers.addCmd(event);
        window.setTimeout(step, 120);
      }, 240);
    }
  };
  step();
}

function streamText(full: string, grow: (text: string) => void, alive: () => boolean, done: () => void) {
  let index = 0;
  const tick = () => {
    if (!alive()) return;
    index += 3;
    grow(full.slice(0, Math.min(index, full.length)));
    if (index < full.length) {
      window.setTimeout(tick, 12);
    } else {
      done();
    }
  };
  tick();
}

function Turn({
  msg,
  onRun,
  onCancel,
}: {
  msg: AgentMessage;
  onRun: (msgId: number, partId: number) => void;
  onCancel: (msgId: number, partId: number) => void;
}) {
  const isUser = msg.role === 'user';
  const groups = groupParts(msg.parts);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      <HStack gap={8}>
        {isUser ? <Avatar name="Mira Tonio" size={20} tone="accent" /> : <AgentMark size={20} />}
        <T kind="body-strong" style={{ fontSize: 13 }}>
          {isUser ? 'Mira' : 'Hermes'}
        </T>
        {!isUser && (
          <T kind="mono-sm" color="var(--ink-4)">
            {msg.model}
          </T>
        )}
        <span style={{ flex: 1 }} />
        <T kind="mono-sm" color="var(--ink-4)">
          {formatTime(msg.ts)}
        </T>
      </HStack>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingLeft: 28 }}>
        {groups.map((group, index) =>
          group.type === 'tools' ? (
            <ToolGroup key={index} items={group.items} />
          ) : (
            <Part
              key={group.part.id}
              part={group.part}
              msgId={msg.id}
              onRun={() => onRun(msg.id, group.part.id)}
              onCancel={() => onCancel(msg.id, group.part.id)}
            />
          ),
        )}
        {msg.role === 'agent' && msg.streaming && msg.parts.length === 0 && (
          <HStack gap={8}>
            <span className="qa-spin" />
            <T kind="body-sm" color="var(--ink-3)">
              Thinking...
            </T>
          </HStack>
        )}
      </div>
    </div>
  );
}

function Part({ part, msgId, onRun, onCancel }: { part: AgentPart; msgId: number; onRun: () => void; onCancel: () => void }) {
  if (part.kind === 'text') return <MarkdownLite text={part.text} streaming={!part.done} />;
  if (part.kind === 'ref') return <RefRow part={part} />;
  if (part.kind === 'cmd') return <CommandCard part={part} msgId={msgId} onRun={onRun} onCancel={onCancel} />;
  return null;
}

function groupParts(parts: AgentPart[]) {
  const groups: Array<{ type: 'tools'; items: Extract<AgentPart, { kind: 'tool' }>[] } | { type: 'single'; part: AgentPart }> = [];
  for (const part of parts) {
    if (part.kind === 'tool') {
      const last = groups[groups.length - 1];
      if (last?.type === 'tools') last.items.push(part);
      else groups.push({ type: 'tools', items: [part] });
    } else {
      groups.push({ type: 'single', part });
    }
  }
  return groups;
}

function MarkdownLite({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const lines = text.split('\n');
  return (
    <div style={{ fontFamily: 'var(--sans)', fontSize: 13.5, lineHeight: 1.62, color: 'var(--ink-2)' }}>
      {lines.map((line, index) => {
        const bullet = line.trimStart().startsWith('•');
        const content = bullet ? line.trimStart().slice(1).trim() : line;
        return (
          <div
            key={`${line}-${index}`}
            style={{
              display: bullet ? 'flex' : 'block',
              gap: 8,
              paddingLeft: bullet ? 2 : 0,
              marginTop: index === 0 ? 0 : line === '' ? 6 : 1,
            }}
          >
            {bullet && <span style={{ color: 'var(--ink-4)', flexShrink: 0 }}>•</span>}
            <span style={{ flex: 1 }}>
              {renderInline(content)}
              {streaming && index === lines.length - 1 && <span className="qa-cursor" />}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function renderInline(text: string) {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('`')) {
      out.push(
        <code
          key={key++}
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 12,
            padding: '1px 5px',
            borderRadius: 'var(--r-xs)',
            background: 'var(--surface-2)',
            border: '1px solid var(--line)',
            color: 'var(--accent-ink)',
            whiteSpace: 'nowrap',
          }}
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**')) {
      out.push(
        <strong key={key++} style={{ fontWeight: 600, color: 'var(--ink)' }}>
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      out.push(<em key={key++}>{token.slice(1, -1)}</em>);
    }
    last = match.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function ToolGroup({ items }: { items: Extract<AgentPart, { kind: 'tool' }>[] }) {
  return (
    <div
      style={{
        background: 'var(--surface-2)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--r-sm)',
        padding: '6px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
      }}
    >
      {items.map((item) => {
        const running = item.status === 'running';
        return (
          <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 22 }}>
            <span style={{ display: 'inline-flex', width: 13, justifyContent: 'center', flexShrink: 0 }}>
              {running ? <span className="qa-spin" /> : <Icon.Check size={13} style={{ color: 'var(--ink-3)' }} />}
            </span>
            <T kind="body-sm" color={running ? 'var(--ink-2)' : 'var(--ink-3)'} style={{ fontWeight: running ? 500 : 400, whiteSpace: 'nowrap', flexShrink: 0 }}>
              {item.label}
              {running ? '...' : ''}
            </T>
            {item.detail ? (
              <T kind="mono-sm" color="var(--ink-4)" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.detail}
              </T>
            ) : (
              <span style={{ flex: 1 }} />
            )}
            {!running && (
              <T kind="mono-sm" color="var(--ink-4)" style={{ flexShrink: 0 }}>
                {(item.ms / 1000).toFixed(1)}s
              </T>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RefRow({ part }: { part: Extract<AgentPart, { kind: 'ref' }> }) {
  const RefIcon = REF_ICONS[part.refKind] ?? Icon.Dot;
  const tone = TONES[part.tone ?? 'neutral'];
  return (
    <a
      href="#"
      onClick={(event) => event.preventDefault()}
      title={`${part.refId} - ${part.label}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '7px 9px',
        borderRadius: 'var(--r-sm)',
        background: 'var(--surface)',
        border: '1px solid var(--line)',
      }}
    >
      <span style={{ color: tone.fg, display: 'inline-flex', flexShrink: 0 }}>
        <RefIcon size={14} />
      </span>
      <T kind="mono-sm" color="var(--ink)" style={{ flexShrink: 0, fontWeight: 500 }}>
        {part.refId}
      </T>
      <T kind="body-sm" color="var(--ink-3)" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {part.label}
      </T>
      {part.meta && (
        <T kind="mono-sm" color={tone.fg} style={{ flexShrink: 0 }}>
          {part.meta}
        </T>
      )}
      <Icon.ExternalLink size={12} style={{ color: 'var(--ink-4)', flexShrink: 0 }} />
    </a>
  );
}

const REF_ICONS = {
  ci: Icon.Pulse,
  log: Icon.Alert,
  pr: Icon.GitPR,
  task: Icon.Anchor,
  slack: Icon.Slack,
  file: Icon.Repo,
};

function CommandCard({
  part,
  onRun,
  onCancel,
}: {
  part: Extract<AgentPart, { kind: 'cmd' }>;
  msgId: number;
  onRun: () => void;
  onCancel: () => void;
}) {
  const dim = part.state === 'cancelled';
  const resultOk = part.result.exit === 0;

  return (
    <div
      style={{
        border: `1px solid ${part.state === 'proposed' ? 'var(--line-2)' : 'var(--line)'}`,
        borderRadius: 'var(--r-md)',
        background: 'var(--surface)',
        overflow: 'hidden',
        opacity: dim ? 0.6 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', background: 'var(--surface-2)', borderBottom: '1px solid var(--line)' }}>
        {part.state === 'proposed' && (
          <>
            <Icon.Filter size={12} style={{ color: 'var(--ink-3)' }} />
            <T kind="caption" color="var(--ink-3)">
              Proposed command
            </T>
            <span style={{ flex: 1 }} />
            <T kind="mono-sm" color="var(--ink-4)">
              {part.note}
            </T>
          </>
        )}
        {part.state === 'running' && (
          <>
            <span className="qa-spin" />
            <T kind="caption" color="var(--accent-ink)">
              Running...
            </T>
            <span style={{ flex: 1 }} />
          </>
        )}
        {part.state === 'ran' && (
          <>
            <Icon.Check size={13} style={{ color: resultOk ? 'var(--good)' : 'var(--danger)' }} />
            <T kind="caption" color={resultOk ? 'var(--good-ink)' : 'var(--danger-ink)'}>
              Ran · exit {part.result.exit} · {(part.result.ms / 1000).toFixed(1)}s
            </T>
            <span style={{ flex: 1 }} />
            <CopyButton text={part.cmd} />
          </>
        )}
        {part.state === 'cancelled' && (
          <>
            <Icon.X size={12} style={{ color: 'var(--ink-4)' }} />
            <T kind="caption" color="var(--ink-4)">
              Cancelled
            </T>
            <span style={{ flex: 1 }} />
          </>
        )}
      </div>

      <div style={{ padding: 11, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            background: 'var(--surface-3)',
            border: '1px solid var(--line-2)',
            borderRadius: 'var(--r-sm)',
            padding: '8px 10px',
          }}
        >
          <T kind="mono-md" color="var(--good)" style={{ flexShrink: 0, userSelect: 'none' }}>
            $
          </T>
          <T kind="mono-md" color="var(--ink)" style={{ flex: 1, wordBreak: 'break-word', textDecoration: dim ? 'line-through' : 'none' }}>
            {part.cmd}
          </T>
          {part.state === 'proposed' && <CopyButton text={part.cmd} />}
        </div>

        {part.state === 'proposed' && (
          <>
            <MarkdownLite text={part.desc} />
            <div style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', padding: '8px 10px' }}>
              <T kind="caption" color="var(--ink-4)" style={{ display: 'block', marginBottom: 6 }}>
                Will affect
              </T>
              <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '3px 14px' }}>
                {part.affects.map((affect) => (
                  <Fragment key={affect.label}>
                    <T kind="body-sm" color="var(--ink-3)">
                      {affect.label}
                    </T>
                    <T kind="mono-sm" color="var(--ink-2)" style={{ textAlign: 'right' }}>
                      {affect.val}
                    </T>
                  </Fragment>
                ))}
              </div>
            </div>
            <HStack gap={8} justify="flex-end">
              <Button variant="ghost" size="sm" onClick={onCancel}>
                Cancel
              </Button>
              <Button variant="accent" size="sm" leading={<Icon.Check size={13} />} onClick={onRun}>
                Run command
              </Button>
            </HStack>
          </>
        )}

        {(part.state === 'running' || part.state === 'ran') && part.output.length > 0 && <OutputBlock lines={part.output} running={part.state === 'running'} />}
        {part.state === 'running' && part.output.length === 0 && <OutputBlock lines={['-> starting...']} running />}
      </div>
    </div>
  );
}

function OutputBlock({ lines, running }: { lines: string[]; running?: boolean }) {
  return (
    <div
      style={{
        fontFamily: 'var(--mono)',
        background: 'var(--surface-3)',
        border: '1px solid var(--line-2)',
        borderRadius: 'var(--r-sm)',
        padding: '8px 10px',
        fontSize: 11.5,
        lineHeight: 1.6,
        whiteSpace: 'pre-wrap',
        overflowX: 'auto',
      }}
    >
      {lines.map((line, index) => (
        <div key={`${line}-${index}`} style={{ color: outputColor(line) }}>
          {line}
        </div>
      ))}
      {running && <span className="qa-cursor" style={{ background: 'var(--ink-3)' }} />}
    </div>
  );
}

function outputColor(line: string) {
  if (line.startsWith('✓')) return 'var(--good-ink)';
  if (line.startsWith('✗') || line.startsWith('  ✗')) return 'var(--danger-ink)';
  if (line.trimStart().startsWith('->')) return 'var(--ink-3)';
  return 'var(--ink-2)';
}

function EmptyState() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        minHeight: '100%',
        gap: 12,
        padding: '0 12px',
      }}
    >
      <AgentMark size={34} />
      <T kind="body-sm" as="div" color="var(--ink-3)" style={{ display: 'block', maxWidth: 270, lineHeight: 1.55 }}>
        Ask about a task, PR, log, or failure. I'll cite what I find and propose commands you approve before they run.
      </T>
    </div>
  );
}

function Composer({ busy, onSend, onStop }: { busy: boolean; onSend: (text: string) => void; onStop: () => void }) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const canSend = value.trim().length > 0 && !busy;

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(140, textarea.scrollHeight)}px`;
  }, [value]);

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    onSend(trimmed);
    setValue('');
  };

  return (
    <div style={{ borderTop: '1px solid var(--line)', padding: '12px 14px', background: 'var(--paper)', flexShrink: 0 }}>
      <div style={{ border: '1px solid var(--line-2)', borderRadius: 'var(--r-md)', background: 'var(--surface)', padding: '9px 10px 7px', display: 'flex', flexDirection: 'column', gap: 7 }}>
        <textarea
          ref={textareaRef}
          className="qa-ta"
          rows={1}
          value={value}
          placeholder="Ask about a task, PR, log, or failure..."
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <HStack gap={8}>
          <span style={{ flex: 1 }} />
          {busy ? (
            <Button variant="secondary" size="sm" onClick={onStop} leading={<Icon.X size={12} />}>
              Stop
            </Button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              title="Send (Enter)"
              style={{
                width: 28,
                height: 28,
                borderRadius: 'var(--r-sm)',
                background: canSend ? 'var(--accent)' : 'var(--surface-2)',
                border: `1px solid ${canSend ? 'var(--accent)' : 'var(--line-2)'}`,
                color: canSend ? '#fff' : 'var(--ink-4)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon.Arrow size={14} dir="up" />
            </button>
          )}
        </HStack>
      </div>
      <HStack gap={6} style={{ marginTop: 7, padding: '0 2px' }}>
        <T kind="mono-sm" color="var(--ink-4)" style={{ whiteSpace: 'nowrap' }}>
          Enter to send
        </T>
        <T kind="mono-sm" color="var(--ink-5)">
          ·
        </T>
        <T kind="mono-sm" color="var(--ink-4)" style={{ whiteSpace: 'nowrap' }}>
          Shift+Enter for newline
        </T>
        <span style={{ flex: 1 }} />
        <T kind="mono-sm" color="var(--ink-4)">
          hermes-1.4
        </T>
      </HStack>
    </div>
  );
}

function AgentMark({ size = 22 }: { size?: number }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: 'var(--r-sm)',
        background: 'var(--accent-soft)',
        border: '1px solid var(--accent-line)',
        color: 'var(--accent)',
        flexShrink: 0,
      }}
    >
      <Icon.Bot size={Math.round(size * 0.62)} />
    </span>
  );
}

function CopyButton({ text, size = 13 }: { text: string; size?: number }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setDone(true);
        window.setTimeout(() => setDone(false), 1200);
      }}
      title="Copy"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        height: 22,
        padding: '0 6px',
        background: 'transparent',
        border: '1px solid transparent',
        borderRadius: 'var(--r-xs)',
        color: done ? 'var(--good-ink)' : 'var(--ink-4)',
        fontFamily: 'var(--mono)',
        fontSize: 10.5,
      }}
    >
      {done ? <Icon.Check size={size} /> : <CopyGlyph size={size} />}
      {done ? 'copied' : ''}
    </button>
  );
}

function CopyGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

function IconButton({ onClick, title, children }: { onClick: () => void; title: string; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} title={title} style={iconButtonStyle}>
      {children}
    </button>
  );
}

const iconButtonStyle: CSSProperties = {
  width: 30,
  height: 30,
  padding: 0,
  background: 'transparent',
  border: '1px solid transparent',
  borderRadius: 'var(--r-sm)',
  color: 'var(--ink-3)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};

function formatTime(date: Date) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
