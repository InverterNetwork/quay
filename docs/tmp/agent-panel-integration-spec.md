# Quay Agent Panel Integration Spec

Temporary working spec for wiring the new Quay agent panel to a real agent backend. This assumes the visual panel is being implemented separately and focuses on the contracts needed to make it functional.

## Goal

Bring an agent into the Quay Admin UI so an operator can ask questions about the current factory state, understand tasks and PRs, and review/approve Quay CLI actions suggested by the agent.

The important product behavior is that the agent knows what the user is looking at. Each user message should include a semantic snapshot of the current UI context.

## Decision Log

- V1 has one active agent session per browser tab. The session survives route changes, resets on browser reload, and can be explicitly cleared with "New thread".
- The frontend sends a fresh `AgentUiContext` snapshot with every user message. The backend treats that snapshot as the authoritative current UI state for the turn.
- UI context is an orientation snapshot, not an access boundary. It grounds Hermes in what the operator is looking at, while Hermes can use its available tools and Quay CLI access to inspect deeper data that is not currently visible in the UI.
- UI context should include stable identifiers and concise visible state. Detailed expansion happens through Hermes tools against Quay data, not by stuffing full logs, PR threads, or database rows into the frontend context payload.
- Context payloads are capped orientation snapshots. V1 should include counts, filters, and up to 50 task summaries for Mission Control; Configuration should include current scope, dirty changes, visible settings, and effective agent IDs. Full logs, review threads, prompt bodies, and large artifacts are fetched through tools by ID.
- Agent context is page-owned. Mission Control and Configuration must both ship semantic context builders in v1; future pages should treat an agent context builder as part of the page implementation contract.
- Quay uses a transport-neutral internal `AgentAdapter` interface. The Hermes adapter should use Hermes API Server over HTTP/SSE because that is Hermes' documented web integration path, but the Quay UI receives Quay-normalized events and should not depend on Hermes-native event names or transport.
- Agent Gateway endpoints should extend the existing Quay Admin API under `/v1/agent/*`, using the same server, auth, CORS handling, and audit conventions as the current `/v1/meta`, `/v1/tasks`, `/v1/global`, `/v1/repos`, `/v1/matrix`, and `/v1/changes/*` endpoints.
- Hermes is the first adapter, not the abstraction. Quay owns the browser-facing protocol, session records, UI context contract, approval policy, and audit model; Hermes-specific API URLs, auth, session/run IDs, event names, and capability probing stay inside `HermesAgentAdapter`.
- If Quay Gateway executes approved actions in v1, it should use the existing Quay command surface via a strict backend allowlist and structured argument parsing. The current CLI dispatcher is a thin wrapper over core services, but the Admin API runtime does not yet carry all dependencies required to call every task operation directly. Typed Admin API actions can replace allowlisted command execution later where we deliberately wire the needed deps.
- V1 assumes a trusted Hermes profile where Quay CLI may already be available to the agent. Approval cards are therefore an operator-consent and visibility mechanism, not a hard security boundary. Gateway-enforced tool sandboxing is a future hardening direction for broader, less trusted deployments.
- Approval requests render as inline conversation cards, not modal dialogs. The card owns the full lifecycle: proposed, rejected, running, succeeded, or failed, including command/action details, affected resources, safety note, and streamed result output where available.
- The Agent Gateway emits audit events for session lifecycle, read-only tool calls, approval decisions, and approved action results. V1 audit retention should have a tight TTL; large payloads are summarized or stored as artifacts by ID rather than retained permanently in the agent audit log.
- V1 uses the existing Admin API authorization model with a single local-operator permission model. Agent requests and audits should still carry user/operator identity and tool capability metadata so repo/workspace-scoped permissions and RBAC can be added later.
- Agent errors are first-class events. The UI renders them inline as failed tool rows, failed approval cards, or message-level errors instead of relying only on toasts.
- Stop interrupts the active agent turn/stream. It does not implicitly cancel approved Quay mutations; action cancellation must be explicit and action-specific.
- V1 supports one active thread per browser tab. Thread history and persisted conversations are out of scope; "New thread" clears local messages and starts a fresh backend session.
- Agent references are structured events, not only links inside prose. The UI renders citation rows/cards for tasks, PRs, logs, files, CI, and config references, with navigation behavior added where the target exists.
- Configuration context captures the active configuration surface and unsaved operator intent: current scope, visible settings, effective worker/reviewer agent and model, dirty changes, and preamble metadata. Large prompt bodies, hidden settings, full matrix data, and all-repo config dumps are fetched by tool when needed.
- Mission Control context captures current factory state and operator-visible task signals: lane counts, active filters/sort, capped visible/loaded task summaries, attention reasons, PR links, latest status, budget, agent/model identity, authors, and selected/focused task when available. Full event history, logs, PR review bodies, artifacts, and diffs are fetched by tool using stable IDs.
- The first Hermes target is a real, context-aware integration using the current trusted-Hermes model. Hermes may already inspect and operate Quay through its installed CLI. The UI should still surface proposed actions as approval cards where possible, but hard gateway-enforced mutation control is future work.
- Hermes adapter should target Hermes Runs API first (`POST /v1/runs`, `GET /v1/runs/{run_id}/events`, `POST /v1/runs/{run_id}/stop`) because the Hermes docs position it as the streaming-friendly dashboard/thick-client surface.

## Non-Goals For V1

- No analytics workbench or arbitrary agent-rendered canvas.
- No in-app agent/provider settings page.
- No direct browser-side Hermes integration.
- No Quay UI-initiated mutation without explicit user approval. Hard prevention of direct Hermes CLI mutations is out of scope for trusted-Hermes v1.
- No DOM scraping as context.

## Parallel Tracks

### Track A: Visual Panel

The design implementation can stay purely visual at first, but should expose clear props for integration:

```ts
interface AgentPanelProps {
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
```

The panel should render normalized message parts, not Hermes-specific objects.

### Track B: Integration Contract

Build a frontend agent client that talks to Quay Admin API. The UI should only know:

- how to send a message
- how to stream normalized events
- how to send an approval or rejection
- how to provide the current UI context

Each route owns its context builder. The shared agent layer stores and sends the latest active snapshot, but it should not know route-specific semantics.

### Track C: Backend Gateway

Add an Agent Gateway to the Quay Admin API. The first implementation is Hermes-backed, but the API should remain agent-agnostic.

## UX Behavior

- Top-bar `Agent` button opens a right drawer.
- `Cmd/Ctrl+J` toggles the drawer.
- `Esc` closes it.
- Drawer remains available across Mission Control and Configuration.
- Messages stream as the backend emits events.
- Tool calls render as compact status rows.
- References render as task/PR/log/file citation rows.
- Proposed CLI actions render as approval cards.
- Approval cards show command, description, affected resources, and safety note.

## UI Context Injection

Each view produces a semantic context object. The agent receives the current context with every user message, not only when the session starts.

Do not send the rendered DOM. Do not send entire raw logs by default. Send IDs, visible state, concise summaries, and links that Hermes or Gateway tools can expand. Hermes is allowed to draw on data beyond the UI through its available tools and Quay CLI access; the context snapshot tells it where the user's attention currently is.

```ts
interface AgentUiContext {
  view: 'mission-control' | 'configuration';
  scope: string;
  urlPath: string;
  capturedAt: string;
  summary: string;
  payload: MissionControlContext | ConfigurationContext;
}
```

Mission Control context:

```ts
interface MissionControlContext {
  taskCounts: {
    total: number;
    attention: number;
    running: number;
    prLifecycle: number;
    waiting: number;
    terminal: number;
  };
  filters: {
    repo: string | null;
    lane: string | null;
    sort: string | null;
  };
  visibleTasks: Array<{
    id: string;
    externalRef: string | null;
    repo: string;
    title: string;
    branch: string | null;
    state: string;
    attentionReason: string | null;
    pr: number | null;
    latest: string;
    budget: string;
    agent: string | null;
    model?: string | null;
    updatedAt: string | null;
    authors?: string[];
  }>;
  selectedTaskId?: string | null;
  limits: {
    maxTasks: 50;
    truncatedFields: string[];
  };
}
```

Configuration context:

```ts
interface ConfigurationContext {
  scopeType: 'global' | 'repo';
  repoId: string | null;
  dirtyChanges: Array<{
    scope: string;
    field: string;
    before: string | null;
    after: string | null;
  }>;
  visibleSettings: Array<{
    key: string;
    label: string;
    value: string | null;
    source: string;
  }>;
  effectiveAgents?: {
    worker: string | null;
    reviewer: string | null;
    workerModel?: string | null;
    reviewerModel?: string | null;
  };
  preambles?: Array<{
    id: number;
    kind: 'worker' | 'reviewer';
    title: string;
    source: 'global' | 'repo';
    refs?: number;
    summary?: string;
  }>;
}
```

## Event Protocol

Backend streams normalized events:

```ts
type AgentEvent =
  | { type: 'message_start'; messageId: string; role: 'agent'; model?: string }
  | { type: 'text_delta'; messageId: string; text: string }
  | { type: 'tool_call'; messageId: string; toolCallId: string; label: string; detail?: string; status: 'running' | 'done' | 'failed' }
  | { type: 'reference'; messageId: string; kind: 'task' | 'pr' | 'log' | 'file' | 'ci' | 'config'; id: string; label: string; url?: string; tone?: 'neutral' | 'good' | 'warn' | 'danger' }
  | { type: 'approval_required'; messageId: string; approvalId: string; command: string; description: string; affects: Array<{ label: string; value: string }>; note?: string }
  | { type: 'command_output'; messageId: string; approvalId: string; line: string }
  | { type: 'approval_result'; messageId: string; approvalId: string; status: 'running' | 'rejected' | 'succeeded' | 'failed'; exitCode?: number }
  | { type: 'error'; messageId?: string; code: string; message: string; recoverable: boolean; details?: unknown }
  | { type: 'message_done'; messageId: string };
```

The UI owns rendering. The Gateway owns adapter communication, event normalization, audit logging, and any gateway-executed tool/action handling.

## Gateway API

The Agent Gateway is part of the existing Quay Admin API family. It should be implemented in the same server/handler structure as the current `/v1/*` endpoints, not as a separate browser-facing service.

Suggested endpoints:

```http
POST /v1/agent/sessions
```

Creates an agent session.

```json
{
  "agent": "hermes",
  "context": { "...": "AgentUiContext" }
}
```

```http
POST /v1/agent/sessions/:sessionId/messages
Accept: application/x-ndjson or text/event-stream
```

Sends a user message and streams `AgentEvent` objects using the chosen browser-facing stream format.

```json
{
  "message": "What needs attention right now?",
  "context": { "...": "AgentUiContext" }
}
```

```http
POST /v1/agent/sessions/:sessionId/approvals/:approvalId
Accept: application/x-ndjson or text/event-stream
```

Approves or rejects a proposed action. In trusted-Hermes v1 this may record operator consent and continue the Hermes run; in a future gateway-enforced mode it can also be the execution boundary for mutations.

```json
{
  "decision": "approved"
}
```

The Quay UI consumes normalized `AgentEvent` streams from the Quay Agent Gateway. The gateway may expose these as NDJSON or SSE, but the frontend event model should stay transport-neutral. The Hermes adapter specifically should talk to Hermes API Server over HTTP/SSE and translate Hermes-native events into Quay `AgentEvent`s.

## Hermes Adapter

The gateway should hide Hermes-specific details behind an adapter:

```ts
interface AgentAdapter {
  createSession(input: {
    context: AgentUiContext;
    user: AgentUser;
  }): Promise<{ sessionId: string }>;

  sendMessage(input: {
    sessionId: string;
    message: string;
    context: AgentUiContext;
  }): AsyncIterable<AgentEvent>;

  decideApproval(input: {
    sessionId: string;
    approvalId: string;
    decision: 'approved' | 'rejected';
  }): AsyncIterable<AgentEvent>;
}
```

Hermes receives:

- user message
- current UI context snapshot
- available Quay tools / CLI affordances
- current operator-consent policy

Hermes returns normalized events, or adapter code maps Hermes-native events into normalized events.

The browser should not call Hermes directly. The Quay backend owns the Hermes API URL/key, session/run IDs, and translation from Hermes SSE events into Quay's normalized event protocol.

### Hermes Docs Baseline

This adapter should be built against the documented Hermes API surfaces:

- API Server: https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server/
- Programmatic Integration: https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration
- Sessions: https://hermes-agent.nousresearch.com/docs/user-guide/sessions
- Profiles: https://hermes-agent.nousresearch.com/docs/user-guide/profiles/

Relevant Hermes facts from the docs:

- API Server is HTTP + Server-Sent Events and is the documented path for language-agnostic web clients.
- The server exposes OpenAI-compatible `/v1/chat/completions` and `/v1/responses`, plus a Runs API.
- Runs API supports `POST /v1/runs`, `GET /v1/runs/{run_id}`, `GET /v1/runs/{run_id}/events`, and `POST /v1/runs/{run_id}/stop`.
- Runs accept `input`, optional `session_id`, `instructions`, `conversation_history`, and `previous_response_id`.
- `/v1/capabilities` advertises support for runs, run events, run stop, sessions, and related endpoints.
- API Server auth is bearer-token based via `API_SERVER_KEY`.
- Direct browser access to Hermes is intentionally not required; server-to-server calls avoid CORS and keep the Hermes bearer key out of the browser.
- Hermes profiles are useful later if we want a Quay-specific Hermes profile with separate state, memory, tools, and `terminal.cwd`, but profiles do not sandbox filesystem access by themselves.

### Endpoint Choice

Use Hermes Runs API first:

```http
POST /v1/runs
GET  /v1/runs/:runId/events
POST /v1/runs/:runId/stop
```

Reasoning:

- It is designed for dashboards/thick clients that want to subscribe to progress events.
- It exposes run status and stop semantics cleanly.
- It accepts `session_id`, which lets Quay correlate a browser-tab agent session to Hermes runs.
- It avoids forcing Quay to manage raw OpenAI `messages` arrays for every turn.

Fallbacks:

- If Runs API capabilities are missing, evaluate `/api/sessions/{id}/chat/stream`.
- If both are unavailable, fail the adapter health check and show the agent as disconnected.

### Adapter Configuration

Suggested Quay config/env:

```sh
QUAY_AGENT_PROVIDER=hermes
QUAY_HERMES_API_BASE_URL=http://127.0.0.1:8642
QUAY_HERMES_API_KEY=...
QUAY_HERMES_MODEL=hermes-agent
QUAY_HERMES_SESSION_KEY_PREFIX=quay
```

The adapter should call:

```http
GET /v1/capabilities
GET /health
```

on startup or first use to determine availability and feature support.

### Session And Run Mapping

Quay owns browser-facing session IDs. Hermes owns run IDs.

```ts
interface HermesSessionBinding {
  quaySessionId: string;
  hermesSessionId: string;
  hermesSessionKey: string;
  activeRunId: string | null;
  lastRunId: string | null;
}
```

Mapping:

- `quaySessionId`: one active browser-tab thread.
- `hermesSessionId`: stable transcript/session identifier passed as Hermes `session_id`.
- `hermesSessionKey`: stable memory scope header, e.g. `quay:<deployment>:<operator>`.
- `activeRunId`: current in-flight Hermes run, used for event subscription and stop.
- `lastRunId`: last completed run, useful for diagnostics and possible resume behavior.

V1 does not persist Quay sessions across browser reloads, but Hermes may still persist its own transcript according to its session system.

### Sending A Message

For each user message:

1. Build fresh `AgentUiContext`.
2. Create a Hermes run.
3. Subscribe to the run event stream.
4. Translate Hermes events into Quay `AgentEvent`s.

Suggested request:

```http
POST /v1/runs
Authorization: Bearer <QUAY_HERMES_API_KEY>
Content-Type: application/json
X-Hermes-Session-Key: quay:<deployment>:<operator>
```

```json
{
  "input": "<user message>\n\n<quay-ui-context>{...}</quay-ui-context>",
  "session_id": "quay-ui:<quaySessionId>",
  "instructions": "You are assisting inside Quay Admin UI. The user message includes a current UI context snapshot. Use it to understand what the operator is looking at. You may inspect broader Quay data with your available tools/CLI. When proposing a mutating Quay action, first explain the action and emit it in the agreed proposed-action format so Quay can render an approval card.",
  "model": "hermes-agent"
}
```

Context should be serialized as compact JSON inside a clearly delimited block. Do not put full logs, review threads, prompt bodies, or artifacts into this block.

### Proposed Action Format

Hermes may not have a Quay-native approval event for our UI. For trusted-Hermes v1, use an instruction-level schema that the adapter can detect in Hermes text or tool output.

Preferred shape:

```json
{
  "quay_proposed_action": {
    "approval_id": "optional-client-id",
    "command": "quay cancel bcd890 --keep-worktree",
    "description": "Cancel the task but preserve its worktree for inspection.",
    "affects": [
      { "label": "task", "value": "bcd890" },
      { "label": "state", "value": "running -> cancelled" },
      { "label": "worktree", "value": "preserved" }
    ],
    "note": "Operator consent requested"
  }
}
```

The adapter maps this to `approval_required`.

If Hermes API Server exposes native approval events for the Runs API in the installed version, prefer native approval events and map them to the same Quay `approval_required` shape.

### Event Mapping

Initial mapping:

| Hermes signal | Quay event |
|---|---|
| run created / started | `message_start` |
| text delta | `text_delta` |
| tool start/progress | `tool_call` with `running` |
| tool completion | `tool_call` with `done` or `failed` |
| proposed action JSON/schema | `approval_required` |
| run completed | `message_done` |
| run failed/cancelled | `error` then `message_done` |

If using `/v1/responses` instead of Runs later:

- `response.output_text.delta` maps to `text_delta`.
- `function_call` / `function_call_output` map to tool rows.
- `response.completed` maps to `message_done`.

If using session chat stream later:

- `assistant.delta` maps to `text_delta`.
- `tool.started` / `tool.completed` map to `tool_call`.
- `run.completed` maps to `message_done`.

### Approval Decisions

In trusted-Hermes v1, an approval decision may do one of two things:

- Record the decision in Quay audit and append a follow-up message to Hermes, e.g. "The operator approved action X."
- If Hermes is blocked on a native Runs API approval, call the Hermes approval endpoint if supported by the installed API Server.

Do not claim gateway enforcement unless the Hermes profile/tool setup actually prevents direct mutating CLI execution.

### Stop

Map Quay stop to:

```http
POST /v1/runs/:runId/stop
```

for the active run. Stop means interrupt the current Hermes turn at the next safe point; it does not imply cancellation of any already-executed Quay CLI side effect.

### Errors

Map Hermes failures to Quay `error` events:

- health/capabilities failure -> connection-level error
- auth failure -> `hermes_auth_failed`
- run creation failure -> `hermes_run_create_failed`
- event stream failure -> `hermes_stream_failed`
- run failed/cancelled -> `hermes_run_failed` / `hermes_run_cancelled`
- unsupported event shape -> `hermes_event_unsupported`

Keep the original Hermes status code and short message in `details`, but avoid streaming secrets or large raw payloads into the UI.

## Tool And Approval Policy

Read-only tools can run automatically:

- inspect task
- list tasks
- read PR state
- read latest events
- read config values
- read logs or artifacts by ID

Mutating tools should be represented as approval cards in the Quay UI:

- existing Quay task mutations exposed by the current command surface, e.g. `quay cancel`, `quay task retarget`, `quay submit-brief`
- enqueue task
- change configuration

For v1 trusted-Hermes usage, this approval model is a product/UX contract rather than a complete enforcement boundary, because Hermes may have direct CLI capability outside the Quay Gateway. A future gateway-enforced mode should remove direct mutating CLI access from the agent and require Quay Gateway approval/execution for mutations.

Approval records should include:

- command or tool name
- parameters
- human-readable description
- affected resources
- session ID
- user identity
- timestamp
- result/exit code
- retention expiry / TTL bucket

## Suggested Implementation Sequence

1. Finish visual panel with normalized message-part props.
2. Add frontend `AgentContextProvider` and context builders for Mission Control and Configuration.
3. Add frontend `AgentClient` that can create sessions, send messages, stream normalized events, and submit approval/rejection decisions.
4. Add backend Agent Gateway endpoints with a temporary no-op adapter that echoes context. This validates transport and UI state handling.
5. Implement Hermes adapter behind the gateway using Hermes API Server / SSE.
6. Map Hermes text/tool/reference/action events into Quay `AgentEvent`s.
7. Render proposed actions as approval cards and send approval decisions back through the gateway.
8. Add audit logging with TTL for sessions, tool calls, approval decisions, and action results.
9. Future hardening: add gateway-enforced tools by removing direct mutating CLI access from the agent profile and executing allowlisted mutations through Quay Gateway.

## Linear Issue Cut

- Agent panel UI integration surface.
- Agent context provider and Mission Control context builder.
- Configuration context builder.
- Frontend Agent Gateway client and stream reducer.
- Backend Agent Gateway routes.
- Hermes adapter using Hermes API Server / SSE.
- Hermes event normalization for text, tool calls, references, and proposed actions.
- Approval card decision flow.
- Audit logging and tests.
- Future: gateway-enforced command execution flow.

## Open Questions

- Exact browser-facing stream format from Quay Gateway: NDJSON or SSE. This is independent from the Hermes adapter, which should use Hermes HTTP/SSE.
- What concrete TTL values should apply to chat/session logs, read-only tool audit summaries, rejected approvals, and approved mutation records?
- How does Hermes surface proposed actions for approval in practice: native approval events, tool calls, or a Quay-specific instruction schema?
