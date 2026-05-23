import { afterEach, expect, test } from "bun:test";
import { createAdminApiHandler } from "../../src/admin/api.ts";
import { createRepoService } from "../../src/core/repos/service.ts";
import { createTagService } from "../../src/core/tags/service.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertTask } from "../support/fixtures.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

function createHandler(opts: {
  config?: Parameters<typeof createAdminApiHandler>[0]["config"];
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
    env: {},
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

test("Admin API handles CORS preflight for versioned routes", async () => {
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
    "Content-Type",
  );
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
