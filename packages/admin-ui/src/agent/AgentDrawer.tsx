import { Fragment, forwardRef, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Avatar } from '../components/Avatar';
import { Button } from '../components/Button';
import { Kbd } from '../components/Kbd';
import { HStack } from '../components/Stack';
import { StatusDot } from '../components/StatusDot';
import { T } from '../components/Typography';
import { Icon } from '../icons/Icon';
import { TONES } from '../styles/tones';
import { type AgentAdapter, type AgentContext, type AgentScriptStep, type DemoCommandResult } from './agentData';
import { EMPTY_AGENT_THREAD, appendUserMessage, applyAgentEvent, stopAgentThread } from './agentState';
import type { AgentConnectionStatus, AgentContextSummary, AgentEvent, AgentMessage, AgentMessagePart } from './agentTypes';

interface DemoAgentDrawerProps {
  open: boolean;
  onClose: () => void;
  adapter: AgentAdapter;
  ctx: AgentContext;
}

export function DemoAgentDrawer({ open, onClose, adapter, ctx }: DemoAgentDrawerProps) {
  const thread = useAgentThread(adapter, ctx);
  const contextSummary: AgentContextSummary = {
    agentId: adapter.id,
    agentName: adapter.name,
    model: adapter.model,
    statusLabel: 'connected',
    scopeLabel: `${ctx.scope} · ${ctx.tasks} tasks · ${ctx.attention} attention`,
  };

  return (
    <AgentDrawer
      open={open}
      status={adapter.status}
      messages={thread.messages}
      busy={thread.busy}
      contextSummary={contextSummary}
      onClose={onClose}
      onNewThread={thread.clear}
      onSendMessage={thread.send}
      onStop={thread.stop}
      onApprove={thread.approve}
      onReject={thread.reject}
    />
  );
}

export function AgentDrawer(props: AgentPanelProps) {
  const drawerRef = useRef<HTMLElement | null>(null);
  const { open, onClose } = props;

  useEffect(() => {
    const drawer = drawerRef.current;
    if (!drawer) return;
    if (open) {
      drawer.removeAttribute('inert');
    } else {
      drawer.setAttribute('inert', '');
    }
  }, [open]);

  return (
    <>
      <div className="qa-backdrop" data-open={open ? '1' : '0'} onClick={onClose} />
      <aside ref={drawerRef} className="qa-drawer" data-open={open ? '1' : '0'} aria-hidden={!open}>
        <AgentPanel {...props} />
      </aside>
    </>
  );
}

interface AgentTriggerProps {
  open: boolean;
  onToggle: () => void;
}

export const AgentTrigger = forwardRef<HTMLButtonElement, AgentTriggerProps>(function AgentTrigger({ open, onToggle }, ref) {
  return (
    <button
      ref={ref}
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
});

export interface AgentPanelProps {
  open: boolean;
  status: AgentConnectionStatus;
  messages: AgentMessage[];
  busy: boolean;
  contextSummary: AgentContextSummary;
  onClose: () => void;
  onNewThread: () => void;
  onSendMessage: (text: string) => void;
  onStop: () => void;
  onApprove: (approvalId: string) => void;
  onReject: (approvalId: string) => void;
}

export function AgentPanel({
  open,
  status,
  messages,
  busy,
  contextSummary,
  onClose,
  onNewThread,
  onSendMessage,
  onStop,
  onApprove,
  onReject,
}: AgentPanelProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const empty = messages.length === 0;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div className="qa-agent" data-open={open ? '1' : '0'} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
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
            <StatusDot tone={status} size={6} />
            <T kind="mono-sm" color="var(--ink-3)" style={{ whiteSpace: 'nowrap', lineHeight: 1 }}>
              {contextSummary.agentId} · {contextSummary.statusLabel}
            </T>
          </HStack>
        </div>
        <IconButton onClick={onNewThread} title="New thread">
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
            {messages.map((message) => (
              <Turn
                key={message.id}
                msg={message}
                agentName={contextSummary.agentName}
                onApprove={onApprove}
                onReject={onReject}
              />
            ))}
          </div>
        )}
      </div>

      <Composer busy={busy} model={contextSummary.model} onSend={onSendMessage} onStop={onStop} />
    </div>
  );
}

function useAgentThread(adapter: AgentAdapter, ctx: AgentContext) {
  const [state, setState] = useState(EMPTY_AGENT_THREAD);
  const runRef = useRef(0);
  const threadTokenRef = useRef(0);
  const idRef = useRef(0);
  const approvalResultsRef = useRef(new Map<string, { messageId: string; result: DemoCommandResult }>());
  const nid = (prefix: string) => {
    idRef.current += 1;
    return `${prefix}-${idRef.current}`;
  };

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || state.busy) return;

    const myRun = ++runRef.current;
    const messageId = nid('agent');
    const userId = nid('user');
    const plan = adapter.plan(trimmed, ctx, messageId);
    for (const step of plan) {
      if (step.event.type === 'approval_required' && step.approvalResult) {
        approvalResultsRef.current.set(step.event.approvalId, { messageId, result: step.approvalResult });
      }
    }

    setState((current) => ({
      ...appendUserMessage(current, userId, trimmed, new Date().toISOString()),
      busy: true,
    }));

    const alive = () => runRef.current === myRun;
    runScript(plan, emitAgentEvent, alive, () => setState((current) => stopAgentThread(current)));
  };

  const stop = () => {
    runRef.current += 1;
    setState((current) => stopAgentThread(current));
  };

  const clear = () => {
    runRef.current += 1;
    threadTokenRef.current += 1;
    approvalResultsRef.current.clear();
    setState(EMPTY_AGENT_THREAD);
  };

  const emitAgentEvent = (event: AgentEvent) => {
    setState((current) => applyAgentEvent(current, event, new Date().toISOString()));
  };

  const approve = (approvalId: string) => {
    const target = findApproval(state.messages, approvalId);
    if (!target) return;
    const result = approvalResultsRef.current.get(approvalId)?.result;
    const threadToken = threadTokenRef.current;
    emitAgentEvent({ type: 'approval_result', messageId: target.messageId, approvalId, status: 'running' });
    if (!result) {
      emitAgentEvent({ type: 'approval_result', messageId: target.messageId, approvalId, status: 'succeeded', exitCode: 0 });
      return;
    }

    const perLine = Math.max(260, Math.round(result.ms / (result.lines.length + 1)));
    let index = 0;
    const tick = () => {
      if (threadTokenRef.current !== threadToken) return;
      if (index < result.lines.length) {
        emitAgentEvent({ type: 'command_output', messageId: target.messageId, approvalId, line: result.lines[index]! });
        index += 1;
        window.setTimeout(tick, perLine);
      } else {
        emitAgentEvent({
          type: 'approval_result',
          messageId: target.messageId,
          approvalId,
          status: result.exitCode === 0 ? 'succeeded' : 'failed',
          exitCode: result.exitCode,
        });
      }
    };
    window.setTimeout(tick, perLine);
  };

  const reject = (approvalId: string) => {
    const target = findApproval(state.messages, approvalId);
    if (!target) return;
    emitAgentEvent({ type: 'approval_result', messageId: target.messageId, approvalId, status: 'rejected' });
  };

  return { messages: state.messages, busy: state.busy, send, stop, clear, approve, reject };
}

function runScript(plan: AgentScriptStep[], emit: (event: AgentEvent) => void, alive: () => boolean, done: () => void) {
  let index = 0;
  const step = () => {
    if (!alive()) return;
    if (index >= plan.length) {
      done();
      return;
    }

    const scriptStep = plan[index++]!;
    const delay = scriptStep.delayMs ?? 0;
    window.setTimeout(() => {
      if (!alive()) return;
      if (scriptStep.streamText && scriptStep.event.type === 'text_delta') {
        streamText(scriptStep.event, emit, alive, () => window.setTimeout(step, 130));
        return;
      }
      emit(scriptStep.event);
      window.setTimeout(step, 130);
    }, delay);
  };
  step();
}

function streamText(event: Extract<AgentEvent, { type: 'text_delta' }>, emit: (event: AgentEvent) => void, alive: () => boolean, done: () => void) {
  let index = 0;
  const tick = () => {
    if (!alive()) return;
    const chunk = event.text.slice(index, index + 3);
    index += chunk.length;
    if (chunk) emit({ ...event, text: chunk });
    if (index < event.text.length) {
      window.setTimeout(tick, 12);
      return;
    }
    done();
  };
  tick();
}

function findApproval(messages: AgentMessage[], approvalId: string) {
  for (const message of messages) {
    if (message.parts.some((part) => part.kind === 'approval' && part.approvalId === approvalId)) {
      return { messageId: message.id };
    }
  }
  return null;
}

function Turn({
  msg,
  agentName,
  onApprove,
  onReject,
}: {
  msg: AgentMessage;
  agentName: string;
  onApprove: (approvalId: string) => void;
  onReject: (approvalId: string) => void;
}) {
  const isUser = msg.role === 'user';
  const groups = groupParts(msg.parts);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      <HStack gap={8}>
        {isUser ? <Avatar name="Mira Tonio" size={20} tone="accent" /> : <AgentMark size={20} />}
        <T kind="body-strong" style={{ fontSize: 13 }}>
          {isUser ? 'Mira' : agentName}
        </T>
        {!isUser && (
          <T kind="mono-sm" color="var(--ink-4)">
            {msg.model}
          </T>
        )}
        <span style={{ flex: 1 }} />
        <T kind="mono-sm" color="var(--ink-4)">
          {formatTime(msg.createdAt)}
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
              onApprove={onApprove}
              onReject={onReject}
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

function Part({
  part,
  onApprove,
  onReject,
}: {
  part: AgentMessagePart;
  onApprove: (approvalId: string) => void;
  onReject: (approvalId: string) => void;
}) {
  if (part.kind === 'text') return <MarkdownLite text={part.text} streaming={!part.done} />;
  if (part.kind === 'reference') return <RefRow part={part} />;
  if (part.kind === 'approval') return <ApprovalCard part={part} onApprove={() => onApprove(part.approvalId)} onReject={() => onReject(part.approvalId)} />;
  if (part.kind === 'error') return <ErrorRow part={part} />;
  return null;
}

function groupParts(parts: AgentMessagePart[]) {
  const groups: Array<{ type: 'tools'; items: Extract<AgentMessagePart, { kind: 'tool' }>[] } | { type: 'single'; part: AgentMessagePart }> = [];
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

function ToolGroup({ items }: { items: Extract<AgentMessagePart, { kind: 'tool' }>[] }) {
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
        const failed = item.status === 'failed';
        return (
          <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 22 }}>
            <span style={{ display: 'inline-flex', width: 13, justifyContent: 'center', flexShrink: 0 }}>
              {running ? (
                <span className="qa-spin" />
              ) : failed ? (
                <Icon.X size={13} style={{ color: 'var(--danger)' }} />
              ) : (
                <Icon.Check size={13} style={{ color: 'var(--ink-3)' }} />
              )}
            </span>
            <T
              kind="body-sm"
              color={running ? 'var(--ink-2)' : failed ? 'var(--danger-ink)' : 'var(--ink-3)'}
              style={{ fontWeight: running ? 500 : 400, whiteSpace: 'nowrap', flexShrink: 0 }}
            >
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
                {failed ? 'failed' : 'done'}
              </T>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RefRow({ part }: { part: Extract<AgentMessagePart, { kind: 'reference' }> }) {
  const RefIcon = REF_ICONS[part.refKind] ?? Icon.Dot;
  const tone = TONES[part.tone ?? 'neutral'];
  return (
    <a
      href={part.url ?? '#'}
      onClick={(event) => {
        if (!part.url) event.preventDefault();
      }}
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
      <Icon.ExternalLink size={12} style={{ color: 'var(--ink-4)', flexShrink: 0 }} />
    </a>
  );
}

const REF_ICONS = {
  ci: Icon.Pulse,
  log: Icon.Alert,
  pr: Icon.GitPR,
  task: Icon.Anchor,
  file: Icon.Repo,
  config: Icon.Filter,
};

function ApprovalCard({
  part,
  onApprove,
  onReject,
}: {
  part: Extract<AgentMessagePart, { kind: 'approval' }>;
  onApprove: () => void;
  onReject: () => void;
}) {
  const dim = part.status === 'rejected';
  const completed = part.status === 'succeeded' || part.status === 'failed';
  const resultOk = part.status === 'succeeded' && (part.exitCode ?? 0) === 0;

  return (
    <div
      style={{
        border: `1px solid ${part.status === 'proposed' ? 'var(--line-2)' : 'var(--line)'}`,
        borderRadius: 'var(--r-md)',
        background: 'var(--surface)',
        overflow: 'hidden',
        opacity: dim ? 0.6 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', background: 'var(--surface-2)', borderBottom: '1px solid var(--line)' }}>
        {part.status === 'proposed' && (
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
        {part.status === 'running' && (
          <>
            <span className="qa-spin" />
            <T kind="caption" color="var(--accent-ink)">
              Running...
            </T>
            <span style={{ flex: 1 }} />
          </>
        )}
        {completed && (
          <>
            {resultOk ? <Icon.Check size={13} style={{ color: 'var(--good)' }} /> : <Icon.X size={13} style={{ color: 'var(--danger)' }} />}
            <T kind="caption" color={resultOk ? 'var(--good-ink)' : 'var(--danger-ink)'}>
              {resultOk ? 'Succeeded' : 'Failed'} · exit {part.exitCode ?? 1}
            </T>
            <span style={{ flex: 1 }} />
            <CopyButton text={part.command} />
          </>
        )}
        {part.status === 'rejected' && (
          <>
            <Icon.X size={12} style={{ color: 'var(--ink-4)' }} />
            <T kind="caption" color="var(--ink-4)">
              Rejected
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
            {part.command}
          </T>
          {part.status === 'proposed' && <CopyButton text={part.command} />}
        </div>

        {part.status === 'proposed' && (
          <>
            <MarkdownLite text={part.description} />
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
                      {affect.value}
                    </T>
                  </Fragment>
                ))}
              </div>
            </div>
            <HStack gap={8} justify="flex-end">
              <Button variant="ghost" size="sm" onClick={onReject}>
                Reject
              </Button>
              <Button variant="accent" size="sm" leading={<Icon.Check size={13} />} onClick={onApprove}>
                Run command
              </Button>
            </HStack>
          </>
        )}

        {(part.status === 'running' || completed) && part.output.length > 0 && <OutputBlock lines={part.output} running={part.status === 'running'} />}
        {part.status === 'running' && part.output.length === 0 && <OutputBlock lines={['-> starting...']} running />}
      </div>
    </div>
  );
}

function ErrorRow({ part }: { part: Extract<AgentMessagePart, { kind: 'error' }> }) {
  return (
    <div style={{ border: '1px solid var(--danger-line)', borderRadius: 'var(--r-sm)', background: 'var(--danger-soft)', padding: '8px 10px' }}>
      <T kind="body-sm" color="var(--danger-ink)" style={{ fontWeight: 600 }}>
        {part.message}
      </T>
      <T kind="mono-sm" color="var(--danger-ink)" style={{ display: 'block', marginTop: 4 }}>
        {part.code} · {part.recoverable ? 'recoverable' : 'not recoverable'}
      </T>
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

function Composer({ busy, model, onSend, onStop }: { busy: boolean; model?: string; onSend: (text: string) => void; onStop: () => void }) {
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
          {model ?? 'agent'}
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

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
