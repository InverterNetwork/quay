import { afterEach, expect, test } from "bun:test";
import {
  createAdminApiHandler,
  type AdminAuditEvent,
} from "../../src/admin/api.ts";
import { createArtifactStore } from "../../src/artifacts/store.ts";
import {
  DEFAULT_CLAUDE_REVIEWER_INVOCATION,
  DEFAULT_CLAUDE_WORKER_INVOCATION,
} from "../../src/core/agents.ts";
import { createRepoService } from "../../src/core/repos/service.ts";
import { createTagService } from "../../src/core/tags/service.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import {
  insertPreamble,
  insertRepo,
  insertTask,
  seedTaskObjective,
} from "../support/fixtures.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

function createHandler(opts: {
  config?: Parameters<typeof createAdminApiHandler>[0]["config"];
  env?: NodeJS.ProcessEnv;
  agentFetch?: Parameters<typeof createAdminApiHandler>[0]["agentFetch"];
  agentStreamHeartbeatMs?: number;
  adminAudit?: Parameters<typeof createAdminApiHandler>[0]["adminAudit"];
  repoService?: ReturnType<typeof createRepoService>;
} = {}) {
  if (h === null) throw new Error("harness not initialized");
  const repoService = opts.repoService ??
    createRepoService({ db: h.db, clock: h.clock });
  return createAdminApiHandler({
    version: "test-version",
    config: opts.config ?? {},
    configPath: null,
    dataDir: h.dataDir,
    db: h.db,
    env: opts.env ?? {},
    ...(opts.agentFetch !== undefined ? { agentFetch: opts.agentFetch } : {}),
    ...(opts.agentStreamHeartbeatMs !== undefined ? { agentStreamHeartbeatMs: opts.agentStreamHeartbeatMs } : {}),
    ...(opts.adminAudit !== undefined ? { adminAudit: opts.adminAudit } : {}),
    paths: {
      reposRoot: `${h.dataDir}/repos`,
      worktreesRoot: `${h.dataDir}/worktrees`,
      artifactsRoot: h.artifactRoot,
    },
    repoService,
    tagService: createTagService({ db: h.db, clock: h.clock, repoService }),
  });
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function responseNdjson(response: Response): Promise<Record<string, unknown>[]> {
  const text = await response.text();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function postJson(path: string, body: unknown): Request {
  return new Request(`http://quay.local${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function authPostJson(path: string, body: unknown): Request {
  return new Request(`http://quay.local${path}`, {
    method: "POST",
    headers: {
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

function sseResponse(events: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

async function currentRevision(
  handler: ReturnType<typeof createAdminApiHandler>,
): Promise<string> {
  const response = await handler(new Request("http://quay.local/v1/global"));
  const body = await responseJson(response);
  return body.revision as string;
}

const agentContextFixture = {
  view: "mission-control",
  scope: "all repos",
  urlPath: "/mission-control",
  capturedAt: "2026-05-30T09:00:00.000Z",
  summary: "Mission Control: 1 task visible.",
  payload: {
    taskCounts: {
      total: 1,
      attention: 0,
      running: 1,
      prLifecycle: 0,
      waiting: 0,
      terminal: 0,
    },
    filters: {
      repo: null,
      lane: null,
      sort: "updated",
    },
    visibleTasks: [],
    limits: {
      maxTasks: 50,
      truncatedFields: [],
    },
  },
} as const;

function auditRetentionDays(event: AdminAuditEvent): number {
  if (event.expires_at === undefined) throw new Error(`audit event ${event.action} missing expires_at`);
  const timestamp = Date.parse(event.timestamp);
  const expiresAt = Date.parse(event.expires_at);
  expect(timestamp).not.toBeNaN();
  expect(expiresAt).not.toBeNaN();
  return Math.round((expiresAt - timestamp) / (24 * 60 * 60 * 1000));
}

interface MissionControlResponse {
  refreshedAt: string;
  activeTaskCount: number;
  hasAttention: boolean;
  tasks: Array<{
    id: string;
    ext: string;
    extUrl: string | null;
    repo: string;
    repoUrl: string | null;
    title: string;
    branch: string;
    state: string;
    pr: number | null;
    prUrl: string | null;
    isReviewOnly: boolean;
    role: "worker" | "review" | "umbrella";
    reviewStatus: string | null;
    umbrellaRef: string | null;
    umbrellaUrl: string | null;
    umbrellaChildren: { done: number; total: number } | null;
    blockedBy: string | null;
    budget: number;
    total: number;
    latest: string;
    agent: string;
    age: string;
    updatedAt: string;
    authors: string[];
    attn?: string;
    attnTone?: string;
  }>;
}

function insertTaskEvent(
  taskId: string,
  eventType: string,
  occurredAt = "2026-01-01T00:00:10.000Z",
): void {
  if (h === null) throw new Error("harness not initialized");
  h.db
    .query(
      `INSERT INTO events (task_id, event_type, from_state, to_state, occurred_at)
       VALUES (?, ?, NULL, NULL, ?)`,
    )
    .run(taskId, eventType, occurredAt);
}

function seedTicketSnapshot(
  taskId: string,
  identifier: string,
  url: string,
): void {
  if (h === null) throw new Error("harness not initialized");
  const store = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });
  store.writeArtifact({
    taskId,
    attemptId: null,
    kind: "ticket_snapshot",
    content: JSON.stringify({
      linear_issue: {
        identifier,
        url,
        title: `${identifier} title`,
        body: "",
        comments: [],
      },
    }),
    extension: "json",
  });
}

test("GET /v1/meta returns API and Quay version metadata", async () => {
  h = createHarness();
  const handler = createHandler();

  const response = await handler(new Request("http://quay.local/v1/meta"));

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await responseJson(response)).toEqual({
    service: "quay",
    api_version: "v1",
    quay_version: "test-version",
    viewer: {
      label: "You",
      display_name: null,
      slack_user_id: null,
    },
  });
});

test("GET /v1/meta resolves forwarded operator display name", async () => {
  h = createHarness();
  const handler = createHandler({
    config: { admin: { require_auth: true } },
    env: { QUAY_ADMIN_TOKEN: "secret-token" },
  });

  const response = await handler(
    new Request("http://quay.local/v1/meta", {
      headers: {
        Authorization: "Bearer secret-token",
        "X-Hermes-User-Id": "U06TDC56VJB",
        "X-Hermes-User-Display-Name": "  Fabian Scherer  ",
      },
    }),
  );

  expect(response.status).toBe(200);
  expect(await responseJson(response)).toMatchObject({
    viewer: {
      label: "Fabian Scherer",
      display_name: "Fabian Scherer",
      slack_user_id: "U06TDC56VJB",
    },
  });
});

test("GET /v1/tasks returns Mission Control task cards with latest event and attention", async () => {
  h = createHarness();
  insertRepo(h.db, "repo-a");
  const taskId = insertTask(h.db, { taskId: "task-ci", repoId: "repo-a", state: "pr-open" });
  seedTaskObjective(h, taskId, "Fix checkout flow after retry regression.\n\nFull brief follows.");
  h.db
    .query(
      `UPDATE tasks
          SET external_ref = 'ITRY-1001',
              branch_name = 'quay/itry-1001-checkout',
              pr_number = 42,
              pr_url = 'https://github.example/repo-a/pull/42',
              attempts_consumed = 3,
              retry_budget = 5,
              worker_model = 'gpt-5.3',
              authors_json = '[{"name":"Mira Tonio","slack_id":"U123"}]',
              updated_at = '2026-01-01T00:00:12.000Z'
        WHERE task_id = ?`,
    )
    .run(taskId);
  insertTaskEvent(taskId, "spawned", "2026-01-01T00:00:01.000Z");
  insertTaskEvent(taskId, "ci_failed", "2026-01-01T00:00:11.000Z");
  seedTicketSnapshot(taskId, "ITRY-1001", "https://linear.app/inverter/issue/ITRY-1001");
  const handler = createHandler();

  const response = await handler(new Request("http://quay.local/v1/tasks"));
  const body = (await responseJson(response)) as unknown as MissionControlResponse;

  expect(response.status).toBe(200);
  expect(body.refreshedAt).toEqual(expect.any(String));
  expect(body.activeTaskCount).toBe(1);
  expect(body.hasAttention).toBe(true);
  expect(body.tasks).toHaveLength(1);
  const task = body.tasks[0];
  if (task === undefined) throw new Error("expected task");
  expect(task).toMatchObject({
    id: "task-ci",
    ext: "ITRY-1001",
    extUrl: "https://linear.app/inverter/issue/ITRY-1001",
    repo: "repo-a",
    repoUrl: "https://example/r",
    title: "Fix checkout flow after retry regression.",
    branch: "quay/itry-1001-checkout",
    state: "pr-open",
    pr: 42,
    prUrl: "https://github.example/repo-a/pull/42",
    isReviewOnly: false,
    role: "worker",
    reviewStatus: null,
    umbrellaRef: null,
    umbrellaUrl: null,
    umbrellaChildren: null,
    budget: 3,
    total: 5,
    latest: "CI failed",
    agent: "gpt-5.3",
    updatedAt: "2026-01-01T00:00:12.000Z",
    authors: ["Mira Tonio"],
    attn: "ci",
    attnTone: "danger",
  });
  expect(task.age).toEqual(expect.any(String));
});

test("GET /v1/tasks exposes sanitized browser repo URLs", async () => {
  h = createHarness();
  insertRepo(h.db, "repo-ssh");
  const sshTaskId = insertTask(h.db, {
    taskId: "task-ssh",
    repoId: "repo-ssh",
    state: "pr-open",
  });
  h.db
    .query(`UPDATE repos SET repo_url = 'git@github.com:owner/repo-ssh.git' WHERE repo_id = 'repo-ssh'`)
    .run();

  insertRepo(h.db, "repo-token");
  const tokenTaskId = insertTask(h.db, {
    taskId: "task-token",
    repoId: "repo-token",
    state: "pr-open",
  });
  h.db
    .query(`UPDATE repos SET repo_url = 'https://secret-token@github.com/owner/repo-token.git' WHERE repo_id = 'repo-token'`)
    .run();

  const handler = createHandler();
  const response = await handler(new Request("http://quay.local/v1/tasks"));
  const body = (await responseJson(response)) as unknown as MissionControlResponse;
  const byId = new Map(body.tasks.map((task) => [task.id, task]));

  expect(response.status).toBe(200);
  expect(byId.get(sshTaskId)?.repoUrl).toBe("https://github.com/owner/repo-ssh");
  expect(byId.get(tokenTaskId)?.repoUrl).toBe("https://github.com/owner/repo-token");
  expect(JSON.stringify(body.tasks)).not.toContain("secret-token");
});

test("GET /v1/tasks exposes review-only PR title and link targets", async () => {
  h = createHarness();
  insertRepo(h.db, "test-factory-code");
  const taskId = insertTask(h.db, {
    taskId: "pr-review-test-factory-code-8",
    repoId: "test-factory-code",
    state: "pr-review",
  });
  h.db
    .query(
      `UPDATE repos
          SET repo_url = 'https://github.com/acme/test-factory-code'
        WHERE repo_id = 'test-factory-code'`,
    )
    .run();
  h.db
    .query(
      `UPDATE tasks
          SET authoring_mode = 'synthetic_review',
              branch_name = 'quay-review/8',
              pr_number = 8,
              pr_url = 'https://github.com/acme/test-factory-code/pull/8',
              pr_title = 'Add NavHolidayGapChecker service + Lambda handler',
              retry_budget = 1
        WHERE task_id = ?`,
    )
    .run(taskId);
  insertTaskEvent(taskId, "review_spawned");
  const handler = createHandler();

  const response = await handler(new Request("http://quay.local/v1/tasks"));
  const body = (await responseJson(response)) as unknown as MissionControlResponse;

  expect(response.status).toBe(200);
  expect(body.tasks).toHaveLength(1);
  expect(body.tasks[0]).toMatchObject({
    id: "pr-review-test-factory-code-8",
    ext: "—",
    repo: "test-factory-code",
    repoUrl: "https://github.com/acme/test-factory-code",
    title: "Add NavHolidayGapChecker service + Lambda handler",
    branch: "quay-review/8",
    state: "pr-review",
    pr: 8,
    prUrl: "https://github.com/acme/test-factory-code/pull/8",
    isReviewOnly: true,
    role: "review",
    reviewStatus: "reviewing",
    umbrellaRef: null,
    umbrellaUrl: null,
    umbrellaChildren: null,
    extUrl: null,
    total: 1,
    latest: "reviewer spawned",
  });
});

test("GET /v1/tasks exposes umbrella parent card metadata", async () => {
  h = createHarness();
  insertRepo(h.db, "test-factory-code");
  const taskId = insertTask(h.db, {
    taskId: "umbrella-final-pr-4",
    repoId: "test-factory-code",
    state: "pr-open",
  });
  h.db
    .query(
      `UPDATE tasks
          SET external_ref = 'BRIX-1579',
              branch_name = 'quay/umbrella/BRIX-1579',
              worker_agent = 'codex',
              retry_budget = 5
        WHERE task_id = ?`,
    )
    .run(taskId);
  const workflow = h.db
    .query<{ id: number }, [string, string, string, string, string, string, string, number, string, string, string]>(
      `INSERT INTO umbrella_workflows (
         external_ref, repo_id, base_branch, feature_branch, linear_issue_title,
         linear_issue_url, final_pr_task_id, final_pr_number, final_pr_url, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING umbrella_workflow_id AS id`,
    )
    .get(
      "BRIX-1579",
      "test-factory-code",
      "main",
      "quay/umbrella/BRIX-1579",
      "Holiday-gap epic — split across child PRs",
      "https://linear.app/inverter/issue/BRIX-1579",
      taskId,
      17,
      "https://github.com/acme/test-factory-code/pull/17",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:12.000Z",
    );
  if (workflow === null || workflow === undefined) throw new Error("expected umbrella workflow");
  h.db
    .query(
      `INSERT INTO umbrella_expected_tasks (
         umbrella_workflow_id, external_ref, title, state, completion_source,
         completion_reason, completed_at, created_at, updated_at
       ) VALUES
         (?, 'BRIX-1571', 'Child 1', 'complete_without_quay', 'manual', 'merged to feature branch', ?, ?, ?),
         (?, 'BRIX-1575', 'Child 2', 'expected', NULL, NULL, NULL, ?, ?)`,
    )
    .run(
      workflow.id,
      "2026-01-01T00:00:10.000Z",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:10.000Z",
      workflow.id,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
  const handler = createHandler();

  const response = await handler(new Request("http://quay.local/v1/tasks"));
  const body = (await responseJson(response)) as unknown as MissionControlResponse;
  const task = body.tasks.find((item) => item.id === taskId);

  expect(response.status).toBe(200);
  expect(task).toMatchObject({
    id: "umbrella-final-pr-4",
    ext: "BRIX-1579",
    repo: "test-factory-code",
    title: "Holiday-gap epic — split across child PRs",
    branch: "quay/umbrella/BRIX-1579",
    state: "pr-open",
    pr: 17,
    prUrl: "https://github.com/acme/test-factory-code/pull/17",
    isReviewOnly: false,
    role: "umbrella",
    reviewStatus: null,
    umbrellaRef: "BRIX-1579",
    umbrellaUrl: "https://linear.app/inverter/issue/BRIX-1579",
    umbrellaChildren: { done: 1, total: 2 },
    total: 5,
    latest: "final PR open · 1 of 2 children merged to feature branch",
    agent: "codex",
  });
});

test("GET /v1/tasks exposes umbrella child relationship and unsatisfied blocker", async () => {
  h = createHarness();
  insertRepo(h.db, "test-factory-code");
  const blockerTaskId = insertTask(h.db, {
    taskId: "brix-1571-base",
    repoId: "test-factory-code",
    state: "running",
  });
  const childTaskId = insertTask(h.db, {
    taskId: "brix-1575-gap",
    repoId: "test-factory-code",
    state: "waiting_dependencies",
  });
  h.db
    .query(
      `UPDATE tasks
          SET external_ref = 'BRIX-1571',
              branch_name = 'quay/brix-1571-base-scaffold'
        WHERE task_id = ?`,
    )
    .run(blockerTaskId);
  h.db
    .query(
      `UPDATE tasks
          SET external_ref = 'BRIX-1575',
              branch_name = 'quay/brix-1575-gap-calc',
              retry_budget = 5
        WHERE task_id = ?`,
    )
    .run(childTaskId);
  seedTaskObjective(h, childTaskId, "Child 2 — gap calculation (needs scaffolding)");
  seedTicketSnapshot(childTaskId, "BRIX-1575", "https://linear.app/inverter/issue/BRIX-1575");
  const workflow = h.db
    .query<{ id: number }, [string, string, string, string, string, string, string]>(
      `INSERT INTO umbrella_workflows (
         external_ref, repo_id, base_branch, feature_branch, linear_issue_title,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING umbrella_workflow_id AS id`,
    )
    .get(
      "BRIX-1579",
      "test-factory-code",
      "main",
      "quay/umbrella/BRIX-1579",
      "Holiday-gap epic — split across child PRs",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:12.000Z",
    );
  if (workflow === null || workflow === undefined) throw new Error("expected umbrella workflow");
  h.db
    .query(
      `INSERT INTO umbrella_tasks (
         umbrella_workflow_id, task_id, external_ref, created_at
       ) VALUES (?, ?, ?, ?)`,
    )
    .run(workflow.id, childTaskId, "BRIX-1575", "2026-01-01T00:00:00.000Z");
  h.db
    .query(
      `INSERT INTO task_dependencies (
         dependent_task_id, dependency_task_id, dependency_source,
         dependency_external_ref, dependency_repo_id, umbrella_workflow_id,
         kind, scope, required_state, created_at, updated_at
       ) VALUES (?, ?, 'linear', ?, ?, ?, 'blocked_by', 'umbrella', 'merged_to_feature_branch', ?, ?)`,
    )
    .run(
      childTaskId,
      blockerTaskId,
      "BRIX-1571",
      "test-factory-code",
      workflow.id,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    );
  const handler = createHandler();

  const response = await handler(new Request("http://quay.local/v1/tasks"));
  const body = (await responseJson(response)) as unknown as MissionControlResponse;
  const task = body.tasks.find((item) => item.id === childTaskId);

  expect(response.status).toBe(200);
  expect(body.hasAttention).toBe(false);
  expect(task).toMatchObject({
    id: "brix-1575-gap",
    ext: "BRIX-1575",
    extUrl: "https://linear.app/inverter/issue/BRIX-1575",
    repo: "test-factory-code",
    title: "Child 2 — gap calculation (needs scaffolding)",
    branch: "quay/brix-1575-gap-calc",
    state: "waiting_dependencies",
    isReviewOnly: false,
    role: "worker",
    reviewStatus: null,
    umbrellaRef: "BRIX-1579",
    umbrellaUrl: null,
    umbrellaChildren: null,
    blockedBy: "BRIX-1571",
    latest: "blocked on BRIX-1571 → feature branch",
  });
  expect(task?.attn).toBeUndefined();
});

test("GET /v1/tasks derives attention from stuck and human states", async () => {
  h = createHarness();
  insertRepo(h.db, "repo-a");
  insertTask(h.db, { taskId: "task-worktree", repoId: "repo-a", state: "worktree_error" });
  insertTask(h.db, { taskId: "task-human", repoId: "repo-a", state: "waiting_human" });
  insertTask(h.db, { taskId: "task-brief", repoId: "repo-a", state: "awaiting-next-brief" });
  insertTask(h.db, { taskId: "task-review", repoId: "repo-a", state: "pr-review" });
  insertTaskEvent("task-review", "changes_requested");
  const handler = createHandler();

  const response = await handler(new Request("http://quay.local/v1/tasks"));
  const body = (await responseJson(response)) as unknown as MissionControlResponse;
  const byId = new Map(body.tasks.map((task) => [task.id, task]));

  expect(response.status).toBe(200);
  expect(byId.get("task-worktree")).toMatchObject({ attn: "worktree", attnTone: "danger" });
  expect(byId.get("task-human")).toMatchObject({ attn: "slack", attnTone: "warn" });
  expect(byId.get("task-brief")).toMatchObject({ attn: "brief", attnTone: "warn" });
  expect(byId.get("task-review")).toMatchObject({ attn: "changes", attnTone: "warn" });
});

test("GET /v1/tasks excludes terminal tasks from sidebar count and handles empty lists", async () => {
  h = createHarness();
  let handler = createHandler();
  let response = await handler(new Request("http://quay.local/v1/tasks"));
  let body = (await responseJson(response)) as unknown as MissionControlResponse;
  expect(response.status).toBe(200);
  expect(body.tasks).toEqual([]);
  expect(body.activeTaskCount).toBe(0);
  expect(body.hasAttention).toBe(false);

  insertRepo(h.db, "repo-a");
  insertTask(h.db, { taskId: "task-running", repoId: "repo-a", state: "running" });
  insertTask(h.db, { taskId: "task-merged", repoId: "repo-a", state: "merged" });
  insertTask(h.db, { taskId: "task-cancelled", repoId: "repo-a", state: "cancelled" });
  handler = createHandler();
  response = await handler(new Request("http://quay.local/v1/tasks"));
  body = (await responseJson(response)) as unknown as MissionControlResponse;

  expect(response.status).toBe(200);
  expect(body.tasks).toHaveLength(3);
  expect(body.activeTaskCount).toBe(1);
  expect(body.hasAttention).toBe(false);
});

test("GET /v1/tasks caps terminal cards and keeps active count accurate", async () => {
  h = createHarness();
  insertRepo(h.db, "repo-a");
  insertTask(h.db, { taskId: "task-running", repoId: "repo-a", state: "running" });

  for (let i = 0; i < 55; i += 1) {
    const suffix = String(i).padStart(2, "0");
    const taskId = `task-terminal-${suffix}`;
    insertTask(h.db, { taskId, repoId: "repo-a", state: "merged" });
    h.db
      .query(`UPDATE tasks SET updated_at = ? WHERE task_id = ?`)
      .run(`2026-01-01T00:00:${suffix}.000Z`, taskId);
  }

  const handler = createHandler();
  const response = await handler(new Request("http://quay.local/v1/tasks"));
  const body = (await responseJson(response)) as unknown as MissionControlResponse;
  const ids = body.tasks.map((task) => task.id);

  expect(response.status).toBe(200);
  expect(body.activeTaskCount).toBe(1);
  expect(body.tasks).toHaveLength(51);
  expect(body.tasks.filter((task) => task.state === "merged")).toHaveLength(50);
  expect(ids).not.toContain("task-terminal-00");
  expect(ids).toContain("task-terminal-54");
});

test("GET /v1/tasks skips rows with unknown task states", async () => {
  h = createHarness();
  insertRepo(h.db, "repo-a");
  insertTask(h.db, { taskId: "task-running", repoId: "repo-a", state: "running" });
  insertTask(h.db, { taskId: "task-invalid", repoId: "repo-a", state: "unexpected_state" });
  const handler = createHandler();

  const response = await handler(new Request("http://quay.local/v1/tasks"));
  const body = (await responseJson(response)) as unknown as MissionControlResponse;

  expect(response.status).toBe(200);
  expect(body.activeTaskCount).toBe(1);
  expect(body.tasks.map((task) => task.id)).toEqual(["task-running"]);
});

test("POST /v1/agent/sessions creates a temporary agent session", async () => {
  h = createHarness();
  const handler = createHandler();

  const response = await handler(postJson("/v1/agent/sessions", {
    agent: "hermes",
    context: agentContextFixture,
  }));
  const body = await responseJson(response);

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(body).toMatchObject({
    agent: "hermes",
    created_at: expect.any(String),
  });
  expect(body.session_id).toEqual(expect.stringMatching(/^agent_[0-9a-f-]+$/));
});

test("POST /v1/agent/sessions/:id/messages streams no-op NDJSON AgentEvents with UI context", async () => {
  h = createHarness();
  const handler = createHandler();
  const session = await responseJson(await handler(postJson("/v1/agent/sessions", {
    context: agentContextFixture,
  })));
  const sessionId = session.session_id as string;

  const response = await handler(
    new Request(`http://quay.local/v1/agent/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: {
        Accept: "application/x-ndjson",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: "What needs attention?",
        context: agentContextFixture,
      }),
    }),
  );
  const events = await responseNdjson(response);

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/x-ndjson");
  expect(events.map((event) => event.type)).toEqual([
    "message_start",
    "text_delta",
    "reference",
    "message_done",
  ]);
  expect(events[0]).toMatchObject({ role: "agent", model: "hermes" });
  expect(events[1]?.text).toContain("What needs attention?");
  expect(events[1]?.text).toContain("Mission Control: 1 task visible.");
  expect(events[2]).toMatchObject({
    kind: "config",
    id: "mission-control",
    label: "Mission Control: 1 task visible.",
  });
});

test("POST /v1/agent/sessions/:id/messages can stream Server-Sent Events", async () => {
  h = createHarness();
  const handler = createHandler();
  const session = await responseJson(await handler(postJson("/v1/agent/sessions", {
    context: agentContextFixture,
  })));
  const sessionId = session.session_id as string;

  const response = await handler(
    new Request(`http://quay.local/v1/agent/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: "Summarize this page",
        context: agentContextFixture,
      }),
    }),
  );
  const text = await response.text();

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(text).toContain("event: agent_event");
  expect(text).toContain("data: [DONE]");
  expect(text).toContain("\"type\":\"message_start\"");
});

test("POST /v1/agent/sessions/:id/messages emits NDJSON heartbeats during idle Hermes gaps", async () => {
  h = createHarness();
  const encoder = new TextEncoder();
  const handler = createHandler({
    env: {
      QUAY_AGENT_PROVIDER: "hermes",
      QUAY_HERMES_API_BASE_URL: "http://hermes.local",
      QUAY_HERMES_API_KEY: "secret-key",
    },
    agentStreamHeartbeatMs: 10,
    agentFetch: async (input, init = {}) => {
      const path = new URL(String(input)).pathname;
      if (path === "/health") return jsonResponse({ status: "ok" });
      if (path === "/v1/capabilities") return jsonResponse({ features: ["run_submission", "run_events_sse", "run_stop"] });
      if (path === "/v1/runs") return jsonResponse({ run_id: "idle-run" });
      if (path === "/v1/runs/idle-run/events") {
        expect(init.headers).toBeDefined();
        return new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              await new Promise((resolve) => setTimeout(resolve, 30));
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "assistant.delta", delta: "done" })}\n\n`));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return jsonResponse({ error: "not_found" }, { status: 404 });
    },
  });
  const session = await responseJson(await handler(postJson("/v1/agent/sessions", {
    context: agentContextFixture,
  })));
  const sessionId = session.session_id as string;

  const response = await handler(
    new Request(`http://quay.local/v1/agent/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: {
        Accept: "application/x-ndjson",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: "Wait through an idle model gap",
        context: agentContextFixture,
      }),
    }),
  );
  const events = await responseNdjson(response);
  const types = events.map((event) => event.type);

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/x-ndjson");
  expect(types).toContain("heartbeat");
  expect(types.indexOf("heartbeat")).toBeGreaterThan(types.indexOf("message_start"));
  expect(types.indexOf("heartbeat")).toBeLessThan(types.indexOf("text_delta"));
  expect(types).toContain("message_done");
});

test("Agent Gateway emits bounded audit records with TTL for sessions, messages, tools, approvals, and stops", async () => {
  h = createHarness();
  const auditEvents: AdminAuditEvent[] = [];
  const context = {
    ...agentContextFixture,
    payload: {
      ...agentContextFixture.payload,
      hidden: { raw: "RAW_CONTEXT_PAYLOAD_SECRET" },
    },
  };
  const longMessage = `Summarize current task health ${"m".repeat(500)} RAW_MESSAGE_TAIL_SECRET`;
  const longCommand = `quay retry ${"x".repeat(420)} RAW_COMMAND_TAIL_SECRET`;
  const longAffect = `${"task-".repeat(80)}RAW_AFFECT_TAIL_SECRET`;
  const longCommandOutput = `quay output ${"o".repeat(600)} RAW_COMMAND_OUTPUT_TAIL_SECRET`;
  const handler = createHandler({
    config: { admin: { require_auth: true } },
    env: {
      QUAY_ADMIN_TOKEN: "secret-token",
      QUAY_AGENT_PROVIDER: "hermes",
      QUAY_HERMES_API_BASE_URL: "http://hermes.local",
      QUAY_HERMES_API_KEY: "hermes-secret",
    },
    adminAudit: (event) => auditEvents.push(event),
    agentFetch: async (input, init = {}) => {
      const path = new URL(String(input)).pathname;
      if (path === "/health") return jsonResponse({ status: "ok" });
      if (path === "/v1/capabilities") return jsonResponse({ features: ["run_submission", "run_events_sse", "run_stop"] });
      if (path === "/v1/runs") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse({ run_id: String(body.input).includes("operator approved") ? "audit-run-2" : "audit-run-1" });
      }
      if (path === "/v1/runs/audit-run-1/events") {
        return sseResponse([
          {
            type: "tool.started",
            tool_call_id: "tool-read",
            tool_name: "list tasks",
            input: { raw: "RAW_TOOL_INPUT_SECRET" },
          },
          {
            type: "tool.completed",
            tool_call_id: "tool-read",
            tool_name: "list tasks",
            result: { raw: "RAW_TOOL_OUTPUT_SECRET" },
          },
          {
            type: "approval.required",
            approval_id: "approval-audit",
            command: longCommand,
            description: "Retry the stale task.",
            affects: [{ label: "task", value: longAffect }],
          },
          { type: "run.snapshot", raw: "RAW_UNSUPPORTED_EVENT_SECRET" },
          { type: "run.completed" },
        ]);
      }
      return sseResponse([
        { type: "command.output", approval_id: "approval-audit", line: longCommandOutput },
        { type: "assistant.delta", delta: "Approval recorded." },
        { type: "run.completed" },
      ]);
    },
  });

  const sessionResponse = await handler(
    new Request("http://quay.local/v1/agent/sessions", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
        "X-Hermes-User-Id": "operator-audit",
      },
      body: JSON.stringify({ context }),
    }),
  );
  const session = await responseJson(sessionResponse);
  const sessionId = session.session_id as string;

  const messageResponse = await handler(
    new Request(`http://quay.local/v1/agent/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        Accept: "application/x-ndjson",
        "Content-Type": "application/json",
        "X-Hermes-User-Id": "operator-audit",
      },
      body: JSON.stringify({
        message: longMessage,
        context,
      }),
    }),
  );
  await responseNdjson(messageResponse);

  const approvalResponse = await handler(
    new Request(`http://quay.local/v1/agent/sessions/${sessionId}/approvals/approval-audit`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        Accept: "application/x-ndjson",
        "Content-Type": "application/json",
        "X-Hermes-User-Id": "operator-audit",
      },
      body: JSON.stringify({ decision: "approved" }),
    }),
  );
  await responseNdjson(approvalResponse);

  await handler(
    new Request(`http://quay.local/v1/agent/sessions/${sessionId}/stop`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
        "X-Hermes-User-Id": "operator-audit",
      },
      body: JSON.stringify({}),
    }),
  );

  const actions = auditEvents.map((event) => event.action);
  expect(actions).toEqual(expect.arrayContaining([
    "agent.session.create",
    "agent.message.send",
    "agent.tool.call",
    "agent.approval.required",
    "agent.approval.decide",
    "agent.command.output",
    "agent.approval.result",
    "agent.session.stop",
  ]));

  const sessionAudit = auditEvents.find((event) => event.action === "agent.session.create")!;
  expect(sessionAudit).toMatchObject({
    retention_bucket: "agent_chat_7d",
    adapter_id: "hermes",
    agent_id: "hermes",
    session_id: sessionId,
    slack_user_id: "operator-audit",
    context_view: "mission-control",
    context_summary: "Mission Control: 1 task visible.",
  });
  expect(auditRetentionDays(sessionAudit)).toBe(7);

  const messageAudit = auditEvents.find((event) => event.action === "agent.message.send")!;
  expect(messageAudit).toMatchObject({
    retention_bucket: "agent_chat_7d",
    message_summary: expect.any(String),
    effect: "unknown",
  });
  expect(auditRetentionDays(messageAudit)).toBe(7);

  const toolAudit = auditEvents.find((event) => event.action === "agent.tool.call" && event.result_status === "succeeded")!;
  expect(toolAudit).toMatchObject({
    retention_bucket: "agent_tool_7d",
    tool_call_id: "tool-read",
    tool_name: "list tasks",
    arguments_summary: "Tool output available",
    effect: "read_only",
  });
  expect(auditRetentionDays(toolAudit)).toBe(7);

  const requiredAudit = auditEvents.find((event) => event.action === "agent.approval.required")!;
  expect(requiredAudit).toMatchObject({
    retention_bucket: "agent_chat_7d",
    approval_id: "approval-audit",
    result_status: "proposed",
    effect: "mutating",
  });
  expect(auditRetentionDays(requiredAudit)).toBe(7);

  const decisionAudit = auditEvents.find((event) => event.action === "agent.approval.decide")!;
  expect(decisionAudit).toMatchObject({
    retention_bucket: "agent_approved_action_30d",
    approval_id: "approval-audit",
    decision: "approved",
    result_status: "running",
    effect: "mutating",
  });
  expect(auditRetentionDays(decisionAudit)).toBe(30);

  const outputAudit = auditEvents.find((event) => event.action === "agent.command.output")!;
  expect(outputAudit).toMatchObject({
    retention_bucket: "agent_approved_action_30d",
    approval_id: "approval-audit",
    result_status: "running",
    arguments_summary: expect.any(String),
    effect: "mutating",
  });
  expect(auditRetentionDays(outputAudit)).toBe(30);

  const resultAudit = auditEvents.find((event) => event.action === "agent.approval.result")!;
  expect(resultAudit).toMatchObject({
    retention_bucket: "agent_approved_action_30d",
    approval_id: "approval-audit",
    decision: "approved",
    result_status: "succeeded",
    effect: "mutating",
  });
  expect(auditRetentionDays(resultAudit)).toBe(30);

  const stopAudit = auditEvents.find((event) => event.action === "agent.session.stop")!;
  expect(stopAudit).toMatchObject({
    retention_bucket: "agent_chat_7d",
    session_id: sessionId,
  });
  expect(auditRetentionDays(stopAudit)).toBe(7);

  const serializedAudit = JSON.stringify(auditEvents);
  expect(serializedAudit).not.toContain("RAW_CONTEXT_PAYLOAD_SECRET");
  expect(serializedAudit).not.toContain("RAW_TOOL_INPUT_SECRET");
  expect(serializedAudit).not.toContain("RAW_TOOL_OUTPUT_SECRET");
  expect(serializedAudit).not.toContain("RAW_UNSUPPORTED_EVENT_SECRET");
  expect(serializedAudit).not.toContain("RAW_MESSAGE_TAIL_SECRET");
  expect(serializedAudit).not.toContain("RAW_COMMAND_TAIL_SECRET");
  expect(serializedAudit).not.toContain("RAW_AFFECT_TAIL_SECRET");
  expect(serializedAudit).not.toContain("RAW_COMMAND_OUTPUT_TAIL_SECRET");
});

test("POST /v1/agent/sessions/:id/approvals/:approvalId approves trusted Hermes actions and audits decision", async () => {
  h = createHarness();
  const auditEvents: AdminAuditEvent[] = [];
  const runBodies: Array<Record<string, unknown>> = [];
  const handler = createHandler({
    config: { admin: { require_auth: true } },
    env: {
      QUAY_ADMIN_TOKEN: "secret-token",
      QUAY_AGENT_PROVIDER: "hermes",
      QUAY_HERMES_API_BASE_URL: "http://hermes.local",
      QUAY_HERMES_API_KEY: "hermes-secret",
    },
    adminAudit: (event) => auditEvents.push(event),
    agentFetch: async (input, init = {}) => {
      const path = new URL(String(input)).pathname;
      if (path === "/health") return jsonResponse({ status: "ok" });
      if (path === "/v1/capabilities") return jsonResponse({ features: ["run_submission", "run_events_sse", "run_stop"] });
      if (path === "/v1/runs") {
        runBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse({ run_id: `run-${runBodies.length}` });
      }
      if (path === "/v1/runs/run-1/events") {
        return sseResponse([
          {
            type: "approval.required",
            approval_id: "approval-1",
            command: "quay cancel bcd890 --keep-worktree",
            description: "Cancel the task but preserve its worktree.",
            affects: [{ label: "task", value: "bcd890" }],
            note: "Operator consent requested",
          },
          { type: "run.completed" },
        ]);
      }
      return sseResponse([
        { type: "assistant.delta", delta: "Approval recorded; continuing trusted Hermes workflow." },
        { type: "run.completed" },
      ]);
    },
  });
  const session = await responseJson(await handler(authPostJson("/v1/agent/sessions", {
    context: agentContextFixture,
  })));
  const sessionId = session.session_id as string;

  const messageResponse = await handler(
    new Request(`http://quay.local/v1/agent/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        Accept: "application/x-ndjson",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: "Prepare cancellation",
        context: agentContextFixture,
      }),
    }),
  );
  const messageEvents = await responseNdjson(messageResponse);
  const approval = messageEvents.find((event) => event.type === "approval_required");
  expect(approval).toMatchObject({
    approvalId: "approval-1",
    command: "quay cancel bcd890 --keep-worktree",
  });

  const response = await handler(
    new Request(`http://quay.local/v1/agent/sessions/${sessionId}/approvals/approval-1`, {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        Accept: "application/x-ndjson",
        "Content-Type": "application/json",
        "X-Hermes-User-Id": "operator-123",
      },
      body: JSON.stringify({ decision: "approved" }),
    }),
  );
  const events = await responseNdjson(response);

  expect(response.status).toBe(200);
  expect(events.map((event) => event.type)).toEqual([
    "message_start",
    "approval_result",
    "text_delta",
    "message_done",
    "approval_result",
  ]);
  expect(events[1]).toMatchObject({
    approvalId: "approval-1",
    status: "running",
  });
  expect(events[4]).toMatchObject({
    approvalId: "approval-1",
    status: "succeeded",
  });
  expect(String(runBodies[1]?.input)).toContain("operator approved proposed Quay action approval-1");
  expect(String(runBodies[1]?.input)).toContain("trusted-Hermes v1");
  const decisionAudit = auditEvents.find((event) => event.action === "agent.approval.decide");
  expect(decisionAudit).toMatchObject({
    action: "agent.approval.decide",
    path: `/v1/agent/sessions/${sessionId}/approvals/approval-1`,
    success: true,
    status: 200,
    slack_user_id: "operator-123",
    identity_status: "forwarded",
    session_id: sessionId,
    approval_id: "approval-1",
    decision: "approved",
    result_status: "running",
    command: "quay cancel bcd890 --keep-worktree",
    operation_summary: ["agent approval approved: quay cancel bcd890 --keep-worktree"],
    target_resources: [
      `agent-session:${sessionId}`,
      "agent-approval:approval-1",
      "task:bcd890",
    ],
  });
  expect(Date.parse(decisionAudit!.timestamp)).not.toBeNaN();
  const resultAudit = auditEvents.find((event) => event.action === "agent.approval.result");
  expect(resultAudit).toMatchObject({
    action: "agent.approval.result",
    approval_id: "approval-1",
    decision: "approved",
    result_status: "succeeded",
    command: "quay cancel bcd890 --keep-worktree",
  });
});

test("POST /v1/agent/sessions/:id/approvals/:approvalId rejects trusted Hermes actions inline", async () => {
  h = createHarness();
  const auditEvents: AdminAuditEvent[] = [];
  const runBodies: Array<Record<string, unknown>> = [];
  const handler = createHandler({
    env: {
      QUAY_AGENT_PROVIDER: "hermes",
      QUAY_HERMES_API_BASE_URL: "http://hermes.local",
      QUAY_HERMES_API_KEY: "hermes-secret",
    },
    adminAudit: (event) => auditEvents.push(event),
    agentFetch: async (input, init = {}) => {
      const path = new URL(String(input)).pathname;
      if (path === "/health") return jsonResponse({ status: "ok" });
      if (path === "/v1/capabilities") return jsonResponse({ features: ["run_submission", "run_events_sse", "run_stop"] });
      if (path === "/v1/runs") {
        runBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse({ run_id: `reject-run-${runBodies.length}` });
      }
      if (path === "/v1/runs/reject-run-1/events") {
        return sseResponse([
          {
            type: "approval.required",
            approval_id: "approval-reject",
            command: "quay retry abc123",
            description: "Retry failed task.",
            affects: [{ label: "task", value: "abc123" }],
          },
          { type: "run.completed" },
        ]);
      }
      return sseResponse([
        { type: "assistant.delta", delta: "Rejected action acknowledged." },
        { type: "run.completed" },
      ]);
    },
  });
  const session = await responseJson(await handler(postJson("/v1/agent/sessions", {
    context: agentContextFixture,
  })));
  const sessionId = session.session_id as string;
  await responseNdjson(await handler(new Request(`http://quay.local/v1/agent/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: {
      Accept: "application/x-ndjson",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: "Prepare retry",
      context: agentContextFixture,
    }),
  })));

  const response = await handler(
    new Request(`http://quay.local/v1/agent/sessions/${sessionId}/approvals/approval-reject`, {
      method: "POST",
      headers: {
        Accept: "application/x-ndjson",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ decision: "rejected" }),
    }),
  );
  const events = await responseNdjson(response);

  expect(response.status).toBe(200);
  expect(events.map((event) => event.type)).toEqual([
    "message_start",
    "approval_result",
    "text_delta",
    "message_done",
  ]);
  expect(events[1]).toMatchObject({
    approvalId: "approval-reject",
    status: "rejected",
  });
  expect(events[2]?.text).toContain("Rejected action acknowledged.");
  expect(String(runBodies[1]?.input)).toContain("operator rejected proposed Quay action approval-reject");
  expect(String(runBodies[1]?.input)).toContain("Do not run the rejected action");
  const decisionAudit = auditEvents.find((event) => event.action === "agent.approval.decide");
  expect(decisionAudit).toMatchObject({
    retention_bucket: "agent_rejected_approval_7d",
    approval_id: "approval-reject",
    decision: "rejected",
    result_status: "rejected",
  });
  expect(auditRetentionDays(decisionAudit!)).toBe(7);
});

test("POST /v1/agent/sessions/:id/approvals/:approvalId rejects repeated approval decisions", async () => {
  h = createHarness();
  const runBodies: Array<Record<string, unknown>> = [];
  const handler = createHandler({
    env: {
      QUAY_AGENT_PROVIDER: "hermes",
      QUAY_HERMES_API_BASE_URL: "http://hermes.local",
      QUAY_HERMES_API_KEY: "hermes-secret",
    },
    agentFetch: async (input, init = {}) => {
      const path = new URL(String(input)).pathname;
      if (path === "/health") return jsonResponse({ status: "ok" });
      if (path === "/v1/capabilities") return jsonResponse({ features: ["run_submission", "run_events_sse", "run_stop"] });
      if (path === "/v1/runs") {
        runBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse({ run_id: `repeat-run-${runBodies.length}` });
      }
      if (path === "/v1/runs/repeat-run-1/events") {
        return sseResponse([
          {
            type: "approval.required",
            approval_id: "approval-repeat",
            command: "quay retry repeated",
            description: "Retry once.",
            affects: [{ label: "task", value: "repeated" }],
          },
          { type: "run.completed" },
        ]);
      }
      return sseResponse([
        {
          type: "approval.required",
          approval_id: "approval-repeat",
          command: "quay retry repeated",
          description: "Retry once.",
          affects: [{ label: "task", value: "repeated" }],
        },
        { type: "assistant.delta", delta: "Continued once." },
        { type: "run.completed" },
      ]);
    },
  });
  const session = await responseJson(await handler(postJson("/v1/agent/sessions", {
    context: agentContextFixture,
  })));
  const sessionId = session.session_id as string;
  await responseNdjson(await handler(new Request(`http://quay.local/v1/agent/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: {
      Accept: "application/x-ndjson",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: "Prepare repeat",
      context: agentContextFixture,
    }),
  })));

  const first = await handler(postJson(`/v1/agent/sessions/${sessionId}/approvals/approval-repeat`, {
    decision: "approved",
  }));
  expect(first.status).toBe(200);
  const firstEvents = await responseNdjson(first);

  const repeated = await handler(postJson(`/v1/agent/sessions/${sessionId}/approvals/approval-repeat`, {
    decision: "approved",
  }));
  const body = await responseJson(repeated);

  expect(repeated.status).toBe(409);
  expect(body).toMatchObject({
    error: "agent_approval_already_decided",
    details: {
      approval_id: "approval-repeat",
      status: "succeeded",
      decision: "approved",
    },
  });
  expect(firstEvents.map((event) => event.type)).toEqual([
    "message_start",
    "approval_result",
    "text_delta",
    "message_done",
    "approval_result",
  ]);
  expect(runBodies).toHaveLength(2);
});

test("POST /v1/agent/sessions/:id/approvals/:approvalId marks failed Hermes continuations as failed", async () => {
  h = createHarness();
  const auditEvents: AdminAuditEvent[] = [];
  const handler = createHandler({
    env: {
      QUAY_AGENT_PROVIDER: "hermes",
      QUAY_HERMES_API_BASE_URL: "http://hermes.local",
      QUAY_HERMES_API_KEY: "hermes-secret",
    },
    adminAudit: (event) => auditEvents.push(event),
    agentFetch: async (input, init = {}) => {
      const path = new URL(String(input)).pathname;
      if (path === "/health") return jsonResponse({ status: "ok" });
      if (path === "/v1/capabilities") return jsonResponse({ features: ["run_submission", "run_events_sse", "run_stop"] });
      if (path === "/v1/runs") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const runId = String(body.input).includes("operator approved") ? "approval-failed-run" : "proposal-run";
        return jsonResponse({ run_id: runId });
      }
      if (path === "/v1/runs/proposal-run/events") {
        return sseResponse([
          {
            type: "approval.required",
            approval_id: "approval-fails",
            command: "quay cancel failed-task",
            description: "Cancel task.",
            affects: [{ label: "task", value: "failed-task" }],
          },
          { type: "run.completed" },
        ]);
      }
      return sseResponse([
        { type: "run.failed", code: "tool_failed" },
      ]);
    },
  });
  const session = await responseJson(await handler(postJson("/v1/agent/sessions", {
    context: agentContextFixture,
  })));
  const sessionId = session.session_id as string;
  await responseNdjson(await handler(new Request(`http://quay.local/v1/agent/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: {
      Accept: "application/x-ndjson",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: "Prepare failing approval",
      context: agentContextFixture,
    }),
  })));

  const response = await handler(postJson(`/v1/agent/sessions/${sessionId}/approvals/approval-fails`, {
    decision: "approved",
  }));
  const events = await responseNdjson(response);

  expect(response.status).toBe(200);
  expect(events.map((event) => event.type)).toEqual([
    "message_start",
    "approval_result",
    "error",
    "message_done",
    "approval_result",
  ]);
  expect(events[1]).toMatchObject({ approvalId: "approval-fails", status: "running" });
  expect(events[4]).toMatchObject({ approvalId: "approval-fails", status: "failed" });
  const decisionAudit = auditEvents.find((event) => event.action === "agent.approval.decide");
  expect(decisionAudit).toMatchObject({
    action: "agent.approval.decide",
    result_status: "running",
    approval_id: "approval-fails",
  });
  const resultAudit = auditEvents.find((event) => event.action === "agent.approval.result");
  expect(resultAudit).toMatchObject({
    action: "agent.approval.result",
    result_status: "failed",
    approval_id: "approval-fails",
    success: false,
  });
});

test("POST /v1/agent/sessions/:id/stop interrupts the temporary session", async () => {
  h = createHarness();
  const handler = createHandler();
  const session = await responseJson(await handler(postJson("/v1/agent/sessions", {
    context: agentContextFixture,
  })));
  const sessionId = session.session_id as string;

  const response = await handler(postJson(`/v1/agent/sessions/${sessionId}/stop`, {}));
  const body = await responseJson(response);

  expect(response.status).toBe(200);
  expect(body).toEqual({
    session_id: sessionId,
    stopped: true,
  });
});

test("Agent Gateway routes use Admin API auth, CORS, validation, and method handling", async () => {
  h = createHarness();
  const handler = createHandler({
    config: { admin: { require_auth: true } },
    env: { QUAY_ADMIN_TOKEN: "secret-token" },
  });

  const missingAuth = await handler(postJson("/v1/agent/sessions", {
    context: agentContextFixture,
  }));
  expect(missingAuth.status).toBe(401);

  const preflight = await handler(
    new Request("http://quay.local/v1/agent/sessions/session-1/messages", {
      method: "OPTIONS",
      headers: { Origin: "http://127.0.0.1:5173" },
    }),
  );
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-methods")).toBe(
    "POST, OPTIONS",
  );

  const invalid = await handler(
    new Request("http://quay.local/v1/agent/sessions", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ context: { view: "unknown" } }),
    }),
  );
  expect(invalid.status).toBe(400);
  expect(await responseJson(invalid)).toMatchObject({
    error: "validation_error",
  });

  const unknownSession = await handler(
    new Request("http://quay.local/v1/agent/sessions/missing/messages", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: "hello",
        context: agentContextFixture,
      }),
    }),
  );
  expect(unknownSession.status).toBe(404);
  expect(await responseJson(unknownSession)).toMatchObject({
    error: "agent_session_not_found",
  });

  const getSession = await handler(
    new Request("http://quay.local/v1/agent/sessions", {
      headers: { Authorization: "Bearer secret-token" },
    }),
  );
  expect(getSession.status).toBe(405);
  expect(getSession.headers.get("allow")).toBe("POST, OPTIONS");
});

test("Hermes provider stays server-side and maps health failures to AgentEvent errors", async () => {
  h = createHarness();
  const calls: string[] = [];
  const handler = createHandler({
    env: {
      QUAY_AGENT_PROVIDER: "hermes",
      QUAY_HERMES_API_BASE_URL: "http://hermes.local",
      QUAY_HERMES_API_KEY: "secret-key",
    },
    agentFetch: async (input) => {
      calls.push(new URL(String(input)).pathname);
      return new Response(JSON.stringify({ error: "offline" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const session = await responseJson(await handler(postJson("/v1/agent/sessions", {
    context: agentContextFixture,
  })));
  const sessionId = session.session_id as string;

  const response = await handler(
    new Request(`http://quay.local/v1/agent/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: {
        Accept: "application/x-ndjson",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: "hello",
        context: agentContextFixture,
      }),
    }),
  );
  const events = await responseNdjson(response);

  expect(session.provider).toBe("hermes");
  expect(response.status).toBe(200);
  expect(calls).toEqual(["/health"]);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "error",
    code: "hermes_health_failed",
    recoverable: true,
  });
  expect(JSON.stringify(events)).not.toContain("secret-key");
});

test("admin bearer auth protects reads and writes when configured", async () => {
  h = createHarness();
  const repoService = createRepoService({ db: h.db, clock: h.clock });
  repoService.add({
    repo_id: "repo-a",
    repo_url: "git@example.com:owner/repo-a.git",
    base_branch: "main",
    package_manager: "bun",
    install_cmd: "bun install",
  });
  const auditEvents: AdminAuditEvent[] = [];
  const handler = createHandler({
    config: { admin: { require_auth: true } },
    env: { QUAY_ADMIN_TOKEN: "secret-token" },
    repoService,
    adminAudit: (event) => auditEvents.push(event),
  });

  const missing = await handler(new Request("http://quay.local/v1/meta"));
  expect(missing.status).toBe(401);
  expect(missing.headers.get("www-authenticate")).toBe(
    'Bearer realm="quay-admin"',
  );
  expect(await responseJson(missing)).toEqual({
    error: "admin_auth_required",
    message: "Admin API requires Authorization: Bearer <token>",
  });

  const invalid = await handler(
    new Request("http://quay.local/v1/meta", {
      headers: { Authorization: "Bearer wrong-token" },
    }),
  );
  expect(invalid.status).toBe(401);
  expect(await responseJson(invalid)).toEqual({
    error: "admin_auth_invalid",
    message: "invalid admin bearer token",
  });

  const meta = await handler(
    new Request("http://quay.local/v1/meta", {
      headers: { Authorization: "Bearer secret-token" },
    }),
  );
  expect(meta.status).toBe(200);

  const global = await handler(
    new Request("http://quay.local/v1/global", {
      headers: { Authorization: "Bearer secret-token" },
    }),
  );
  const revision = (await responseJson(global)).revision as string;
  const applied = await handler(
    new Request("http://quay.local/v1/changes/apply", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
        "X-Hermes-User-Id": "hermes-user-123",
      },
      body: JSON.stringify({
        base_revision: revision,
        changes: [
          {
            type: "repo.update",
            repo_id: "repo-a",
            patch: { base_branch: "dev" },
          },
        ],
      }),
    }),
  );

  expect(applied.status).toBe(200);
  expect(repoService.get("repo-a")?.base_branch).toBe("dev");
  expect(auditEvents).toHaveLength(1);
  expect(auditEvents[0]).toEqual({
    action: "changes.apply",
    method: "POST",
    path: "/v1/changes/apply",
    timestamp: expect.any(String),
    success: true,
    status: 200,
    slack_user_id: "hermes-user-123",
    display_name: null,
    identity_status: "forwarded",
    forwarded_identity: "hermes-user-123",
    forwarded_identity_header: "X-Hermes-User-Id",
    forwarded_display_name: null,
    forwarded_display_name_header: "X-Hermes-User-Display-Name",
    operation_summary: ["repo repo-a: update base_branch"],
    target_resources: ["repo:repo-a"],
  });
  expect(Date.parse(auditEvents[0]!.timestamp)).not.toBeNaN();
});

test("admin audit records failed writes with explicit missing identity", async () => {
  h = createHarness();
  const repoService = createRepoService({ db: h.db, clock: h.clock });
  repoService.add({
    repo_id: "repo-a",
    repo_url: "git@example.com:owner/repo-a.git",
    base_branch: "main",
    package_manager: "bun",
    install_cmd: "bun install",
  });
  const auditEvents: AdminAuditEvent[] = [];
  const handler = createHandler({
    config: { admin: { require_auth: true } },
    env: { QUAY_ADMIN_TOKEN: "secret-token" },
    repoService,
    adminAudit: (event) => auditEvents.push(event),
  });
  const global = await handler(
    new Request("http://quay.local/v1/global", {
      headers: { Authorization: "Bearer secret-token" },
    }),
  );
  const revision = (await responseJson(global)).revision as string;

  const response = await handler(
    new Request("http://quay.local/v1/changes/apply", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        base_revision: revision,
        changes: [
          {
            type: "repo.update",
            repo_id: "repo-a",
            patch: { agent_worker: "missing-agent" },
          },
        ],
      }),
    }),
  );

  expect(response.status).toBe(400);
  expect(auditEvents).toHaveLength(1);
  expect(auditEvents[0]).toMatchObject({
    action: "changes.apply",
    success: false,
    status: 400,
    slack_user_id: null,
    identity_status: "missing",
    forwarded_identity: null,
    forwarded_identity_header: "X-Hermes-User-Id",
    operation_summary: ["repo repo-a: update agent_worker"],
    target_resources: ["repo:repo-a"],
    error_code: "validation_error",
  });
  expect(auditEvents[0]!.error_message).toContain("missing-agent");
});

test("standalone admin mode does not trust forwarded identity headers", async () => {
  h = createHarness();
  const repoService = createRepoService({ db: h.db, clock: h.clock });
  repoService.add({
    repo_id: "repo-a",
    repo_url: "git@example.com:owner/repo-a.git",
    base_branch: "main",
    package_manager: "bun",
    install_cmd: "bun install",
  });
  const auditEvents: AdminAuditEvent[] = [];
  const handler = createHandler({
    repoService,
    adminAudit: (event) => auditEvents.push(event),
  });
  const revision = await currentRevision(handler);

  const response = await handler(
    new Request("http://quay.local/v1/changes/apply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hermes-User-Id": "spoofed-user",
      },
      body: JSON.stringify({
        base_revision: revision,
        changes: [
          {
            type: "repo.update",
            repo_id: "repo-a",
            patch: { base_branch: "dev" },
          },
        ],
      }),
    }),
  );

  expect(response.status).toBe(200);
  expect(auditEvents).toHaveLength(1);
  expect(auditEvents[0]).toMatchObject({
    success: true,
    slack_user_id: null,
    identity_status: "standalone",
    forwarded_identity: null,
    operation_summary: ["repo repo-a: update base_branch"],
    target_resources: ["repo:repo-a"],
  });
});

test("admin audit omits sensitive repository values from operation summaries", async () => {
  h = createHarness();
  const repoService = createRepoService({ db: h.db, clock: h.clock });
  repoService.add({
    repo_id: "repo-a",
    repo_url: "https://old-token@example.com/owner/repo-a.git",
    base_branch: "main",
    package_manager: "bun",
    install_cmd: "bun install",
  });
  const auditEvents: AdminAuditEvent[] = [];
  const handler = createHandler({
    config: { admin: { require_auth: true } },
    env: { QUAY_ADMIN_TOKEN: "secret-token" },
    repoService,
    adminAudit: (event) => auditEvents.push(event),
  });
  const global = await handler(
    new Request("http://quay.local/v1/global", {
      headers: { Authorization: "Bearer secret-token" },
    }),
  );
  const revision = (await responseJson(global)).revision as string;

  const response = await handler(
    new Request("http://quay.local/v1/changes/preview", {
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
        "X-Hermes-User-Id": "U06TDC56VJB",
      },
      body: JSON.stringify({
        base_revision: revision,
        changes: [
          {
            type: "repo.update",
            repo_id: "repo-a",
            patch: {
              repo_url: "https://new-token@example.com/owner/repo-a.git",
              install_cmd: "TOKEN=super-secret bun install",
            },
          },
        ],
      }),
    }),
  );

  expect(response.status).toBe(200);
  expect(auditEvents).toHaveLength(1);
  const serialized = JSON.stringify(auditEvents[0]);
  expect(serialized).not.toContain("old-token");
  expect(serialized).not.toContain("new-token");
  expect(serialized).not.toContain("super-secret");
  expect(auditEvents[0]).toMatchObject({
    action: "changes.preview",
    slack_user_id: "U06TDC56VJB",
    operation_summary: [
      "repo repo-a: update repo_url",
      "repo repo-a: update install_cmd",
    ],
    target_resources: ["repo:repo-a"],
  });
});

test("GET /v1/repos returns active repo rows ordered by repo_id", async () => {
  h = createHarness();
  const repoService = createRepoService({ db: h.db, clock: h.clock });
  repoService.add({
    repo_id: "repo-b",
    repo_url: "git@example.com:owner/repo-b.git",
    base_branch: "main",
    package_manager: "bun",
    install_cmd: "bun install",
  });
  repoService.add({
    repo_id: "repo-a",
    repo_url: "git@example.com:owner/repo-a.git",
    base_branch: "main",
    package_manager: "bun",
    install_cmd: "bun install",
  });
  repoService.remove("repo-b");
  const handler = createAdminApiHandler({
    version: "test-version",
    config: {},
    configPath: null,
    dataDir: h.dataDir,
    db: h.db,
    env: {},
    paths: {
      reposRoot: `${h.dataDir}/repos`,
      worktreesRoot: `${h.dataDir}/worktrees`,
      artifactsRoot: h.artifactRoot,
    },
    repoService,
    tagService: createTagService({ db: h.db, clock: h.clock, repoService }),
  });

  const response = await handler(new Request("http://quay.local/v1/repos"));
  const body = (await response.json()) as Array<{ repo_id: string }>;

  expect(response.status).toBe(200);
  expect(body.map((row) => row.repo_id)).toEqual(["repo-a"]);
});

test("GET /v1/repos/:id returns a repo or stable not-found error", async () => {
  h = createHarness();
  const repoService = createRepoService({ db: h.db, clock: h.clock });
  repoService.add({
    repo_id: "repo-a",
    repo_url: "git@example.com:owner/repo-a.git",
    base_branch: "main",
    package_manager: "bun",
    install_cmd: "bun install",
  });
  const handler = createAdminApiHandler({
    version: "test-version",
    config: {},
    configPath: null,
    dataDir: h.dataDir,
    db: h.db,
    env: {},
    paths: {
      reposRoot: `${h.dataDir}/repos`,
      worktreesRoot: `${h.dataDir}/worktrees`,
      artifactsRoot: h.artifactRoot,
    },
    repoService,
    tagService: createTagService({ db: h.db, clock: h.clock, repoService }),
  });

  const found = await handler(new Request("http://quay.local/v1/repos/repo-a"));
  expect(found.status).toBe(200);
  expect(await responseJson(found)).toMatchObject({ repo_id: "repo-a" });

  const missing = await handler(
    new Request("http://quay.local/v1/repos/missing"),
  );
  expect(missing.status).toBe(404);
  expect(await responseJson(missing)).toEqual({
    error: "repo_not_found",
    message: 'repo "missing" not found',
  });
});

test("GET /v1/global returns deployment config, agents, prompts, and tags", async () => {
  h = createHarness();
  const repoService = createRepoService({ db: h.db, clock: h.clock });
  const tagService = createTagService({ db: h.db, clock: h.clock, repoService });
  tagService.setValue("deployment", null, "priority", "p1");
  tagService.setRequired("deployment", null, "priority", true);
  const handler = createAdminApiHandler({
    version: "test-version",
    config: {
      retry_budget: 8,
      agents: {
        worker: "codex",
        invocations: {
          codex: { worker: "codex exec < {prompt_file}" },
        },
      },
    },
    configPath: "/tmp/quay-config.toml",
    dataDir: h.dataDir,
    db: h.db,
    env: {},
    paths: {
      reposRoot: `${h.dataDir}/repos`,
      worktreesRoot: `${h.dataDir}/worktrees`,
      artifactsRoot: h.artifactRoot,
    },
    repoService,
    tagService,
  });

  const response = await handler(new Request("http://quay.local/v1/global"));
  const body = await responseJson(response);

  expect(response.status).toBe(200);
  expect(body.config_path).toBe("/tmp/quay-config.toml");
  expect(body).toMatchObject({
    agents: { defaults: { worker: "codex", reviewer: "claude" } },
  });
  expect(JSON.stringify(body)).toContain('"label":"RETRY_BUDGET"');
  expect(JSON.stringify(body)).toContain('"value":"8"');
  expect(JSON.stringify(body)).toContain('"name":"priority"');
  expect(JSON.stringify(body)).toContain('"title":"Worker preamble"');
  expect(JSON.stringify(body)).toContain('"reason":"ci_fail"');

  const agentInvocations = (body.agents as {
    invocations: Array<{
      name: string;
      roles: string[];
      commands: { worker?: string; reviewer?: string };
    }>;
  }).invocations;
  expect(agentInvocations.find((invocation) => invocation.name === "claude"))
    .toMatchObject({
      roles: ["worker", "reviewer"],
      commands: {
        worker: DEFAULT_CLAUDE_WORKER_INVOCATION,
        reviewer: DEFAULT_CLAUDE_REVIEWER_INVOCATION,
      },
    });
  expect(agentInvocations.find((invocation) => invocation.name === "codex"))
    .toMatchObject({
      roles: ["worker"],
      commands: { worker: "codex exec < {prompt_file}" },
    });
});

test("GET /v1/global reports Linear bearer env readiness", async () => {
  h = createHarness();
  const handler = createHandler({
    config: {
      adapters: {
        linear: {
          enabled: true,
          auth_mode: "bearer",
          bearer_token_env: "QUAY_LINEAR_APP_TOKEN",
        },
      },
    },
    env: { QUAY_LINEAR_APP_TOKEN: "oauth-token" },
  });

  const response = await handler(new Request("http://quay.local/v1/global"));
  const body = await responseJson(response);
  const linear = (body.adapters as Array<Record<string, unknown>>).find(
    (adapter) => adapter.name === "linear",
  );

  expect(linear).toMatchObject({
    status: "ready",
    status_text: "env QUAY_LINEAR_APP_TOKEN is set",
    fields: expect.arrayContaining([
      { label: "AUTH_MODE", value: "bearer" },
      {
        label: "TOKEN_ENV",
        value: "QUAY_LINEAR_APP_TOKEN",
        dot_tone: "good",
      },
    ]),
  });
});

test("GET /v1/global reports Linear token command as ready without env", async () => {
  h = createHarness();
  const handler = createHandler({
    config: {
      adapters: {
        linear: {
          enabled: true,
          token_command: "hermes-agent linear-token --actor app",
        },
      },
    },
    env: {},
  });

  const response = await handler(new Request("http://quay.local/v1/global"));
  const body = await responseJson(response);
  const linear = (body.adapters as Array<Record<string, unknown>>).find(
    (adapter) => adapter.name === "linear",
  );

  expect(linear).toMatchObject({
    status: "ready",
    status_text: "token command configured",
    fields: expect.arrayContaining([
      { label: "AUTH_MODE", value: "bearer" },
      {
        label: "TOKEN_COMMAND",
        value: "configured",
        dot_tone: "good",
      },
    ]),
  });
});

test("POST /v1/changes/apply updates DB-backed deployment agent defaults", async () => {
  h = createHarness();
  const handler = createHandler({
    config: {
      agents: {
        worker: "claude",
        invocations: {
          claude: { worker: "claude --w", reviewer: "claude --r" },
          codex: { worker: "codex exec", reviewer: "codex exec --review" },
        },
      },
    },
  });
  const revision = await currentRevision(handler);

  const response = await handler(postJson("/v1/changes/apply", {
    base_revision: revision,
    changes: [
      {
        type: "deployment_settings.update",
        patch: {
          worker_agent: "codex",
          worker_model: "gpt-5.4",
        },
      },
    ],
  }));
  const body = await responseJson(response);

  expect(response.status).toBe(200);
  expect(JSON.stringify(body)).toContain("deployment settings: set worker_agent");
  const globalResponse = await handler(new Request("http://quay.local/v1/global"));
  const global = await responseJson(globalResponse);
  expect(global).toMatchObject({
    agents: {
      defaults: {
        worker: "codex",
        worker_model: "gpt-5.4",
        reviewer: "claude",
      },
    },
  });
});

test("POST /v1/changes/apply preserves effective defaults on first partial deployment settings edit", async () => {
  h = createHarness();
  const handler = createHandler({
    config: {
      agents: {
        worker: "codex",
        worker_model: "toml-worker-model",
        reviewer: "codex",
        reviewer_model: "toml-reviewer-model",
        invocations: {
          claude: { worker: "claude --w", reviewer: "claude --r" },
          codex: { worker: "codex exec", reviewer: "codex exec --review" },
        },
      },
    },
  });
  const revision = await currentRevision(handler);

  const response = await handler(postJson("/v1/changes/apply", {
    base_revision: revision,
    changes: [
      {
        type: "deployment_settings.update",
        patch: {
          worker_model: "gpt-5.4",
        },
      },
    ],
  }));

  expect(response.status).toBe(200);
  expect(
    h.db
      .query<{
        worker_agent: string | null;
        worker_model: string | null;
        reviewer_agent: string | null;
        reviewer_model: string | null;
      }, []>(
        `SELECT worker_agent, worker_model, reviewer_agent, reviewer_model
           FROM deployment_settings
          WHERE singleton_id = 1`,
      )
      .get(),
  ).toEqual({
    worker_agent: "codex",
    worker_model: "gpt-5.4",
    reviewer_agent: "codex",
    reviewer_model: "toml-reviewer-model",
  });
});

test("Admin revision distinguishes missing deployment settings from explicit null row", async () => {
  h = createHarness();
  const handler = createHandler({
    config: {
      agents: {
        worker: "codex",
        reviewer: "codex",
        worker_model: "toml-worker-model",
        reviewer_model: "toml-reviewer-model",
        invocations: {
          claude: { worker: "claude --w", reviewer: "claude --r" },
          codex: { worker: "codex exec", reviewer: "codex exec --review" },
        },
      },
    },
  });
  const before = await currentRevision(handler);

  h.db
    .query(
      `INSERT INTO deployment_settings (
         singleton_id, worker_agent, worker_model, reviewer_agent,
         reviewer_model, created_at, updated_at
       ) VALUES (1, NULL, NULL, NULL, NULL, ?, ?)`,
    )
    .run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

  const after = await currentRevision(handler);
  expect(after).not.toBe(before);

  const globalResponse = await handler(new Request("http://quay.local/v1/global"));
  const global = await responseJson(globalResponse);
  expect(global).toMatchObject({
    agents: {
      defaults: {
        worker: "claude",
        worker_model: null,
        reviewer: "claude",
        reviewer_model: null,
      },
    },
  });
});

test("GET /v1/tags counts repo tag extensions only for active repos", async () => {
  h = createHarness();
  const repoService = createRepoService({ db: h.db, clock: h.clock });
  repoService.add({
    repo_id: "repo-active",
    repo_url: "git@example.com:owner/repo-active.git",
    base_branch: "main",
    package_manager: "bun",
    install_cmd: "bun install",
  });
  repoService.add({
    repo_id: "repo-archived",
    repo_url: "git@example.com:owner/repo-archived.git",
    base_branch: "main",
    package_manager: "bun",
    install_cmd: "bun install",
  });
  const tagService = createTagService({ db: h.db, clock: h.clock, repoService });
  tagService.setValue("deployment", null, "priority", "p1");
  tagService.setValue("repo", "repo-active", "priority", "p1");
  tagService.setValue("repo", "repo-archived", "priority", "p1");
  repoService.remove("repo-archived");
  const handler = createAdminApiHandler({
    version: "test-version",
    config: {},
    configPath: null,
    dataDir: h.dataDir,
    db: h.db,
    env: {},
    paths: {
      reposRoot: `${h.dataDir}/repos`,
      worktreesRoot: `${h.dataDir}/worktrees`,
      artifactsRoot: h.artifactRoot,
    },
    repoService,
    tagService,
  });

  const response = await handler(new Request("http://quay.local/v1/tags"));
  const body = await responseJson(response);

  expect(response.status).toBe(200);
  expect(body.tag_namespaces).toEqual([
    {
      name: "priority",
      required: false,
      values: ["p1"],
      inherited_by: 1,
      extended_by: 1,
    },
  ]);
});

test("GET /v1/repos/:id returns detail tags and active task count", async () => {
  h = createHarness();
  const repoService = createRepoService({ db: h.db, clock: h.clock });
  repoService.add({
    repo_id: "repo-a",
    repo_url: "git@example.com:owner/repo-a.git",
    base_branch: "main",
    package_manager: "bun",
    install_cmd: "bun install",
  });
  insertTask(h.db, { repoId: "repo-a", taskId: "task-a", state: "queued" });
  insertTask(h.db, { repoId: "repo-a", taskId: "task-b", state: "parked" });
  const tagService = createTagService({ db: h.db, clock: h.clock, repoService });
  tagService.setValue("deployment", null, "priority", "p1");
  tagService.setRequired("deployment", null, "priority", true);
  tagService.setValue("repo", "repo-a", "area", "ui");
  const handler = createAdminApiHandler({
    version: "test-version",
    config: {},
    configPath: null,
    dataDir: h.dataDir,
    db: h.db,
    env: {},
    paths: {
      reposRoot: `${h.dataDir}/repos`,
      worktreesRoot: `${h.dataDir}/worktrees`,
      artifactsRoot: h.artifactRoot,
    },
    repoService,
    tagService,
  });

  const response = await handler(new Request("http://quay.local/v1/repos/repo-a"));
  const body = await responseJson(response);

  expect(response.status).toBe(200);
  expect(body).toMatchObject({
    repo_id: "repo-a",
    active_task_count: 1,
  });
  expect(body.tag_namespaces).toEqual([
    { name: "area", required: false, values: ["ui"] },
  ]);
  expect(body.inherited_tag_namespaces).toEqual([
    {
      name: "priority",
      required: true,
      values: ["p1"],
      inherited_by: 1,
      extended_by: 0,
    },
  ]);
});

test("GET /v1/repos/:id exposes effective repo preamble provenance", async () => {
  h = createHarness();
  const repoService = createRepoService({ db: h.db, clock: h.clock });
  const preambleId = insertPreamble(h.db, "repo worker preamble", "code");
  repoService.add({
    repo_id: "repo-a",
    repo_url: "git@example.com:owner/repo-a.git",
    base_branch: "main",
    package_manager: "bun",
    install_cmd: "bun install",
    preamble_worker: preambleId,
  });
  const handler = createHandler({ repoService });

  const response = await handler(new Request("http://quay.local/v1/repos/repo-a"));
  const body = await responseJson(response) as {
    effective_preambles: {
      worker: Record<string, unknown>;
      reviewer: Record<string, unknown>;
    };
  };

  expect(response.status).toBe(200);
  expect(body.effective_preambles.worker).toMatchObject({
    source: "repo",
    configured_preamble_id: preambleId,
    effective_preamble_id: preambleId,
    body: "repo worker preamble",
  });
  expect(body.effective_preambles.reviewer).toMatchObject({
    source: "global",
    configured_preamble_id: null,
  });
});

test("GET /v1/matrix returns repo override rows", async () => {
  h = createHarness();
  const repoService = createRepoService({ db: h.db, clock: h.clock });
  repoService.add({
    repo_id: "repo-a",
    repo_url: "git@example.com:owner/repo-a.git",
    base_branch: "main",
    package_manager: "bun",
    install_cmd: "bun install",
    agent_worker: "codex",
  });
  const handler = createHandler({
    config: {
      agents: {
        worker: "claude",
        invocations: {
          codex: { worker: "codex exec < {prompt_file}" },
        },
      },
    },
    repoService,
  });

  const response = await handler(new Request("http://quay.local/v1/matrix"));
  const body = await responseJson(response);

  expect(response.status).toBe(200);
  expect(body.rows).toContainEqual({
    group: "AGENTS",
    label: "worker agent",
    key: "agent_worker",
    default_value: "claude",
    values: { "repo-a": "codex" },
  });
});

test("POST /v1/changes/apply writes repo preamble override changes", async () => {
  h = createHarness();
  const repoService = createRepoService({ db: h.db, clock: h.clock });
  const preambleId = insertPreamble(h.db, "repo worker preamble", "code");
  repoService.add({
    repo_id: "repo-a",
    repo_url: "git@example.com:owner/repo-a.git",
    base_branch: "main",
    package_manager: "bun",
    install_cmd: "bun install",
  });
  const handler = createHandler({ repoService });
  const revision = await currentRevision(handler);

  const response = await handler(postJson("/v1/changes/apply", {
    base_revision: revision,
    changes: [
      {
        type: "repo.update",
        repo_id: "repo-a",
        patch: { preamble_worker: preambleId },
      },
    ],
  }));
  const body = await responseJson(response) as { preview: { summary: string[] } };

  expect(response.status).toBe(200);
  expect(repoService.get("repo-a")?.preamble_worker).toBe(preambleId);
  expect(body.preview.summary).toEqual([
    `repo repo-a: set preamble_worker from unset to ${preambleId}`,
  ]);
});

test("POST /v1/changes/preview validates changes and returns deterministic operations", async () => {
  h = createHarness();
  const repoService = createRepoService({ db: h.db, clock: h.clock });
  repoService.add({
    repo_id: "repo-a",
    repo_url: "git@example.com:owner/repo-a.git",
    base_branch: "main",
    package_manager: "bun",
    install_cmd: "bun install",
  });
  const tagService = createTagService({ db: h.db, clock: h.clock, repoService });
  tagService.setValue("deployment", null, "priority", "p1");
  const handler = createAdminApiHandler({
    version: "test-version",
    config: {},
    configPath: null,
    dataDir: h.dataDir,
    db: h.db,
    env: {},
    paths: {
      reposRoot: `${h.dataDir}/repos`,
      worktreesRoot: `${h.dataDir}/worktrees`,
      artifactsRoot: h.artifactRoot,
    },
    repoService,
    tagService,
  });
  const revision = await currentRevision(handler);

  const response = await handler(postJson("/v1/changes/preview", {
    base_revision: revision,
    changes: [
      {
        type: "repo.update",
        repo_id: "repo-a",
        patch: { base_branch: "dev" },
      },
      {
        type: "tags.replace",
        scope: "deployment",
        tag_namespaces: [
          { name: "priority", required: true, values: ["p1", "p2"] },
        ],
      },
    ],
  }));
  const body = await responseJson(response);

  expect(response.status).toBe(200);
  expect(body).toMatchObject({
    base_revision: revision,
    current_revision: revision,
    valid: true,
  });
  expect(body.summary).toEqual([
    'repo repo-a: set base_branch from "main" to "dev"',
    'deployment tags: replace priority from {"required":false,"values":["p1"]} to {"required":true,"values":["p1","p2"]}',
  ]);
  expect(body.operations).toEqual([
    {
      op_id: "change-1:base_branch",
      type: "repo.update",
      scope: "repo",
      target: "repo-a",
      field: "base_branch",
      before: "main",
      after: "dev",
      summary: 'repo repo-a: set base_branch from "main" to "dev"',
    },
    {
      op_id: "change-2:tags:priority",
      type: "tag_namespace.replace",
      scope: "deployment",
      target: "deployment",
      field: "priority",
      before: { required: false, values: ["p1"] },
      after: { required: true, values: ["p1", "p2"] },
      summary:
        'deployment tags: replace priority from {"required":false,"values":["p1"]} to {"required":true,"values":["p1","p2"]}',
    },
  ]);
});

test("POST /v1/changes/apply atomically writes supported repo and tag changes", async () => {
  h = createHarness();
  const repoService = createRepoService({ db: h.db, clock: h.clock });
  repoService.add({
    repo_id: "repo-a",
    repo_url: "git@example.com:owner/repo-a.git",
    base_branch: "main",
    package_manager: "bun",
    install_cmd: "bun install",
  });
  const tagService = createTagService({ db: h.db, clock: h.clock, repoService });
  const handler = createAdminApiHandler({
    version: "test-version",
    config: {},
    configPath: null,
    dataDir: h.dataDir,
    db: h.db,
    env: {},
    paths: {
      reposRoot: `${h.dataDir}/repos`,
      worktreesRoot: `${h.dataDir}/worktrees`,
      artifactsRoot: h.artifactRoot,
    },
    repoService,
    tagService,
  });
  const revision = await currentRevision(handler);

  const response = await handler(postJson("/v1/changes/apply", {
    base_revision: revision,
    changes: [
      {
        type: "repo.update",
        repo_id: "repo-a",
        patch: { base_branch: "dev", test_cmd: "bun test" },
      },
      {
        type: "tags.replace",
        scope: "repo",
        repo_id: "repo-a",
        tag_namespaces: [
          { name: "area", required: false, values: ["ui"] },
        ],
      },
    ],
  }));
  const body = await responseJson(response);

  expect(response.status).toBe(200);
  expect(body.previous_revision).toBe(revision);
  expect(body.revision).not.toBe(revision);
  expect(repoService.get("repo-a")).toMatchObject({
    base_branch: "dev",
    test_cmd: "bun test",
  });
  expect(tagService.getVocab("repo", "repo-a")).toEqual({
    area: { required: false, values: ["ui"] },
  });
  expect(body.read_model).toMatchObject({
    revision: body.revision,
    repos: [{ repo_id: "repo-a", base_branch: "dev" }],
  });
});

test("POST /v1/changes/preview returns validation errors for invalid change sets", async () => {
  h = createHarness();
  const handler = createHandler();
  const revision = await currentRevision(handler);

  const response = await handler(postJson("/v1/changes/preview", {
    base_revision: revision,
    changes: [
      {
        type: "tags.replace",
        scope: "deployment",
        tag_namespaces: [
          { name: "priority", required: true, values: [] },
        ],
      },
    ],
  }));
  const body = await responseJson(response);

  expect(response.status).toBe(400);
  expect(body.error).toBe("validation_error");
  expect(body.message).toContain(
    "namespace marked required must have at least one value",
  );
});

test("POST /v1/changes/apply rejects stale base revisions", async () => {
  h = createHarness();
  const repoService = createRepoService({ db: h.db, clock: h.clock });
  repoService.add({
    repo_id: "repo-a",
    repo_url: "git@example.com:owner/repo-a.git",
    base_branch: "main",
    package_manager: "bun",
    install_cmd: "bun install",
  });
  const tagService = createTagService({ db: h.db, clock: h.clock, repoService });
  const auditEvents: AdminAuditEvent[] = [];
  const handler = createAdminApiHandler({
    version: "test-version",
    config: {},
    configPath: null,
    dataDir: h.dataDir,
    db: h.db,
    env: {},
    paths: {
      reposRoot: `${h.dataDir}/repos`,
      worktreesRoot: `${h.dataDir}/worktrees`,
      artifactsRoot: h.artifactRoot,
    },
    repoService,
    tagService,
    adminAudit: (event) => auditEvents.push(event),
  });
  const staleRevision = await currentRevision(handler);
  tagService.setValue("deployment", null, "priority", "p1");

  const response = await handler(postJson("/v1/changes/apply", {
    base_revision: staleRevision,
    changes: [
      {
        type: "repo.update",
        repo_id: "repo-a",
        patch: { base_branch: "dev" },
      },
    ],
  }));
  const body = await responseJson(response);

  expect(response.status).toBe(409);
  expect(body).toMatchObject({
    error: "stale_revision",
  });
  expect((body.details as Record<string, unknown>).base_revision).toBe(
    staleRevision,
  );
  expect(repoService.get("repo-a")?.base_branch).toBe("main");
  expect(auditEvents).toHaveLength(1);
  expect(auditEvents[0]).toMatchObject({
    action: "changes.apply",
    success: false,
    status: 409,
    operation_summary: ["repo repo-a: update base_branch"],
    target_resources: ["repo:repo-a"],
    error_code: "stale_revision",
  });
});

test("POST /v1/changes/apply fences revisions inside the write transaction", async () => {
  h = createHarness();
  const repoService = createRepoService({ db: h.db, clock: h.clock });
  repoService.add({
    repo_id: "repo-a",
    repo_url: "git@example.com:owner/repo-a.git",
    base_branch: "main",
    package_manager: "bun",
    install_cmd: "bun install",
  });
  const tagService = createTagService({ db: h.db, clock: h.clock, repoService });
  let injected = false;
  const db = new Proxy(h.db, {
    get(target, prop, receiver) {
      if (prop !== "transaction") {
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (fn: () => unknown) => {
        const run = target.transaction(fn);
        return () => {
          if (!injected) {
            injected = true;
            tagService.setValue("deployment", null, "priority", "p1");
          }
          return run();
        };
      };
    },
  }) as typeof h.db;
  const handler = createAdminApiHandler({
    version: "test-version",
    config: {},
    configPath: null,
    dataDir: h.dataDir,
    db,
    env: {},
    paths: {
      reposRoot: `${h.dataDir}/repos`,
      worktreesRoot: `${h.dataDir}/worktrees`,
      artifactsRoot: h.artifactRoot,
    },
    repoService,
    tagService,
  });
  const revision = await currentRevision(handler);

  const response = await handler(postJson("/v1/changes/apply", {
    base_revision: revision,
    changes: [
      {
        type: "repo.update",
        repo_id: "repo-a",
        patch: { base_branch: "dev" },
      },
    ],
  }));
  const body = await responseJson(response);

  expect(response.status).toBe(409);
  expect(body.error).toBe("stale_revision");
  expect(repoService.get("repo-a")?.base_branch).toBe("main");
});

test("Admin API rejects unsupported HTTP methods with stable error shape", async () => {
  h = createHarness();
  const handler = createHandler();

  const response = await handler(
    new Request("http://quay.local/v1/meta", { method: "POST" }),
  );

  expect(response.status).toBe(405);
  expect(response.headers.get("allow")).toBe("GET, OPTIONS");
  expect(await responseJson(response)).toEqual({
    error: "method_not_allowed",
    message: "method POST is not allowed",
  });
});

test("Admin API includes CORS headers for allowed local UI origins", async () => {
  h = createHarness();
  const handler = createHandler();

  const response = await handler(
    new Request("http://quay.local/v1/meta", {
      headers: { Origin: "http://localhost:5173" },
    }),
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("access-control-allow-origin")).toBe(
    "http://localhost:5173",
  );
  expect(response.headers.get("vary")).toBe("Origin");
});

test("Admin API handles CORS preflight for read-only versioned routes", async () => {
  h = createHarness();
  const handler = createHandler();

  const response = await handler(
    new Request("http://quay.local/v1/repos", {
      method: "OPTIONS",
      headers: { Origin: "http://127.0.0.1:5173" },
    }),
  );

  expect(response.status).toBe(204);
  expect(response.headers.get("access-control-allow-origin")).toBe(
    "http://127.0.0.1:5173",
  );
  expect(response.headers.get("access-control-allow-methods")).toBe(
    "GET, OPTIONS",
  );
  expect(response.headers.get("access-control-allow-headers")).toBe(
    "Accept, Authorization, Content-Type, X-Hermes-User-Id, X-Hermes-User-Display-Name",
  );
});

test("Admin API handles CORS preflight for write-only versioned routes", async () => {
  h = createHarness();
  const handler = createHandler();

  const response = await handler(
    new Request("http://quay.local/v1/changes/apply", {
      method: "OPTIONS",
      headers: { Origin: "http://127.0.0.1:5173" },
    }),
  );

  expect(response.status).toBe(204);
  expect(response.headers.get("access-control-allow-methods")).toBe(
    "POST, OPTIONS",
  );
});

test("Admin API rejects GET on write-only routes with matching Allow header", async () => {
  h = createHarness();
  const handler = createHandler();

  const response = await handler(
    new Request("http://quay.local/v1/changes/apply"),
  );

  expect(response.status).toBe(405);
  expect(response.headers.get("allow")).toBe("POST, OPTIONS");
  expect(await responseJson(response)).toEqual({
    error: "method_not_allowed",
    message: "method GET is not allowed",
  });
});

test("Admin API rejects disallowed CORS origins", async () => {
  h = createHarness();
  const handler = createHandler();

  const response = await handler(
    new Request("http://quay.local/v1/repos", {
      headers: { Origin: "https://example.com" },
    }),
  );

  expect(response.status).toBe(403);
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
  expect(await responseJson(response)).toEqual({
    error: "cors_origin_not_allowed",
    message: 'origin "https://example.com" is not allowed',
  });
});
