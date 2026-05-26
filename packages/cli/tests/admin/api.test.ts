import { afterEach, expect, test } from "bun:test";
import {
  createAdminApiHandler,
  type AdminAuditEvent,
} from "../../src/admin/api.ts";
import {
  DEFAULT_CLAUDE_REVIEWER_INVOCATION,
  DEFAULT_CLAUDE_WORKER_INVOCATION,
} from "../../src/core/agents.ts";
import { createRepoService } from "../../src/core/repos/service.ts";
import { createTagService } from "../../src/core/tags/service.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertPreamble, insertTask } from "../support/fixtures.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

function createHandler(opts: {
  config?: Parameters<typeof createAdminApiHandler>[0]["config"];
  env?: NodeJS.ProcessEnv;
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

function postJson(path: string, body: unknown): Request {
  return new Request(`http://quay.local${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function currentRevision(
  handler: ReturnType<typeof createAdminApiHandler>,
): Promise<string> {
  const response = await handler(new Request("http://quay.local/v1/global"));
  const body = await responseJson(response);
  return body.revision as string;
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
  });
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
    identity_status: "forwarded",
    forwarded_identity: "hermes-user-123",
    forwarded_identity_header: "X-Hermes-User-Id",
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
    "Accept, Authorization, Content-Type, X-Hermes-User-Id",
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
