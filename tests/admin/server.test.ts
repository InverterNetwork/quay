import { afterEach, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAdminApiServerHandler,
  createEmbeddedAdminApiHandler,
  createHostedAdminApiHandler,
  type EmbeddedUiAsset,
} from "../../src/admin/server.ts";
import type { AdminApiRuntime } from "../../src/admin/api.ts";
import { createRepoService } from "../../src/core/repos/service.ts";
import { createTagService } from "../../src/core/tags/service.ts";
import { createHarness, type Harness } from "../support/harness.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

function createRuntime(opts: {
  config?: AdminApiRuntime["config"];
  env?: NodeJS.ProcessEnv;
} = {}): AdminApiRuntime {
  if (h === null) throw new Error("harness not initialized");
  const repoService = createRepoService({ db: h.db, clock: h.clock });
  return {
    version: "test-version",
    config: opts.config ?? {},
    configPath: null,
    dataDir: h.dataDir,
    db: h.db,
    env: opts.env ?? {},
    paths: {
      reposRoot: `${h.dataDir}/repos`,
      worktreesRoot: `${h.dataDir}/worktrees`,
      artifactsRoot: h.artifactRoot,
    },
    repoService,
    tagService: createTagService({ db: h.db, clock: h.clock, repoService }),
  };
}

test("hosted handler keeps /v1 API routes ahead of static files", async () => {
  h = createHarness();
  const uiDir = makeUiDir();
  try {
    mkdirSync(join(uiDir, "v1"));
    writeFileSync(join(uiDir, "v1", "meta"), "static meta");
    const handler = createHostedAdminApiHandler(createRuntime(), uiDir);

    const response = await handler(new Request("http://quay.local/v1/meta"));
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(body).toEqual({
      service: "quay",
      api_version: "v1",
      quay_version: "test-version",
    });

    const missingApi = await handler(
      new Request("http://quay.local/v1/not-a-route"),
    );
    expect(missingApi.status).toBe(404);
    expect(missingApi.headers.get("content-type")).toContain("application/json");
    expect(await missingApi.json()).toEqual({
      error: "not_found",
      message: "route not found: /v1/not-a-route",
    });
  } finally {
    rmSync(uiDir, { recursive: true, force: true });
  }
});

test("embedded handler keeps /v1 API routes ahead of static files", async () => {
  h = createHarness();
  const handler = createEmbeddedAdminApiHandler(createRuntime(), makeEmbeddedAssets({
    "index.html": "<!doctype html><div id=\"root\"></div>",
    "v1/meta": "static meta",
  }));

  const response = await handler(new Request("http://quay.local/v1/meta"));
  const body = await response.json() as Record<string, unknown>;

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(body).toEqual({
    service: "quay",
    api_version: "v1",
    quay_version: "test-version",
  });

  const missingApi = await handler(
    new Request("http://quay.local/v1/not-a-route"),
  );
  expect(missingApi.status).toBe(404);
  expect(missingApi.headers.get("content-type")).toContain("application/json");
});

test("hosted handler allows same-origin API mutation requests", async () => {
  h = createHarness();
  const uiDir = makeUiDir();
  try {
    const runtime = createRuntime();
    runtime.repoService.add({
      repo_id: "repo-a",
      repo_url: "git@example.com:owner/repo-a.git",
      base_branch: "main",
      package_manager: "bun",
      install_cmd: "bun install",
    });
    const handler = createHostedAdminApiHandler(runtime, uiDir);
    const origin = "http://127.0.0.1:9731";

    const globalResponse = await handler(
      new Request(`${origin}/v1/global`, { headers: { Origin: origin } }),
    );
    expect(globalResponse.status).toBe(200);
    expect(globalResponse.headers.get("access-control-allow-origin")).toBe(origin);
    const global = await globalResponse.json() as { revision: string };

    const response = await handler(
      new Request(`${origin}/v1/changes/preview`, {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          base_revision: global.revision,
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
    const body = await response.json() as { valid?: boolean };

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(body.valid).toBe(true);
  } finally {
    rmSync(uiDir, { recursive: true, force: true });
  }
});

test("hosted handler serves static assets with content type and cache headers", async () => {
  h = createHarness();
  const uiDir = makeUiDir();
  try {
    const handler = createHostedAdminApiHandler(createRuntime(), uiDir);

    const response = await handler(
      new Request("http://quay.local/assets/app.js"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(await response.text()).toBe("console.log('quay');");
  } finally {
    rmSync(uiDir, { recursive: true, force: true });
  }
});

test("embedded handler serves static assets with content type and cache headers", async () => {
  h = createHarness();
  const handler = createEmbeddedAdminApiHandler(createRuntime(), makeEmbeddedAssets({
    "index.html": "<!doctype html><div id=\"root\"></div>",
    "assets/app.js": "console.log('quay');",
  }));

  const response = await handler(
    new Request("http://quay.local/assets/app.js"),
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/javascript");
  expect(response.headers.get("cache-control")).toBe(
    "public, max-age=31536000, immutable",
  );
  expect(await response.text()).toBe("console.log('quay');");
});

test("embedded handler protects static UI assets when admin auth is configured", async () => {
  h = createHarness();
  const handler = createEmbeddedAdminApiHandler(
    createRuntime({
      config: { admin: { require_auth: true } },
      env: { QUAY_ADMIN_TOKEN: "secret-token" },
    }),
    makeEmbeddedAssets({
      "index.html": "<!doctype html><div id=\"root\"></div>",
      "assets/app.js": "console.log('quay');",
    }),
  );

  const missing = await handler(new Request("http://quay.local/"));
  expect(missing.status).toBe(401);
  expect(missing.headers.get("content-type")).toContain("application/json");
  expect(await missing.json()).toEqual({
    error: "admin_auth_required",
    message: "Admin API requires Authorization: Bearer <token>",
  });

  const valid = await handler(
    new Request("http://quay.local/", {
      headers: { Authorization: "Bearer secret-token" },
    }),
  );
  expect(valid.status).toBe(200);
  expect(valid.headers.get("content-type")).toContain("text/html");
});

test("hosted handler returns index.html for non-api SPA routes", async () => {
  h = createHarness();
  const uiDir = makeUiDir();
  try {
    const handler = createHostedAdminApiHandler(createRuntime(), uiDir);

    const response = await handler(new Request("http://quay.local/repos/repo-a"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(await response.text()).toContain("<div id=\"root\"></div>");
  } finally {
    rmSync(uiDir, { recursive: true, force: true });
  }
});

test("embedded handler returns index.html for root and non-api SPA routes", async () => {
  h = createHarness();
  const handler = createEmbeddedAdminApiHandler(createRuntime(), makeEmbeddedAssets({
    "index.html": [
      "<!doctype html>",
      "<html>",
      "<head><title>Quay</title></head>",
      "<body><div id=\"root\"></div><script type=\"module\" src=\"/assets/app.js\"></script></body>",
      "</html>",
    ].join(""),
    "assets/app.js": "console.log('quay');",
  }));

  const root = await handler(new Request("http://quay.local/"));
  expect(root.status).toBe(200);
  expect(root.headers.get("content-type")).toContain("text/html");
  expect(root.headers.get("cache-control")).toBe("no-cache");
  const rootBody = await root.text();
  expect(rootBody).toContain("window.__QUAY_API_BASE_URL__");
  expect(rootBody).toContain("window.location.origin");
  expect(rootBody).toContain("<div id=\"root\"></div>");

  const route = await handler(new Request("http://quay.local/repos/repo-a"));
  expect(route.status).toBe(200);
  expect(route.headers.get("content-type")).toContain("text/html");
  expect(await route.text()).toContain("window.location.origin");
});

test("hosted handler returns a clear 404 for missing static assets", async () => {
  h = createHarness();
  const uiDir = makeUiDir();
  try {
    const handler = createHostedAdminApiHandler(createRuntime(), uiDir);

    const response = await handler(
      new Request("http://quay.local/assets/missing.js"),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toContain(
      "static asset not found: /assets/missing.js",
    );
  } finally {
    rmSync(uiDir, { recursive: true, force: true });
  }
});

test("embedded handler returns a clear 404 for missing static assets", async () => {
  h = createHarness();
  const handler = createEmbeddedAdminApiHandler(createRuntime(), makeEmbeddedAssets({
    "index.html": "<!doctype html><div id=\"root\"></div>",
  }));

  const response = await handler(
    new Request("http://quay.local/assets/missing.js"),
  );

  expect(response.status).toBe(404);
  expect(response.headers.get("content-type")).toContain("text/plain");
  expect(await response.text()).toContain(
    "static asset not found: /assets/missing.js",
  );
});

test("ui-dir overrides embedded UI assets", async () => {
  h = createHarness();
  const uiDir = makeUiDir();
  try {
    writeFileSync(join(uiDir, "index.html"), "<!doctype html><p>filesystem ui</p>");
    const handler = createAdminApiServerHandler(createRuntime(), {
      uiDir,
      embeddedUiAssets: makeEmbeddedAssets({
        "index.html": "<!doctype html><p>embedded ui</p>",
      }),
    });

    const response = await handler(new Request("http://quay.local/"));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("filesystem ui");
  } finally {
    rmSync(uiDir, { recursive: true, force: true });
  }
});

function makeUiDir(): string {
  const uiDir = mkdtempSync(join(tmpdir(), "quay-hosted-ui-"));
  mkdirSync(join(uiDir, "assets"));
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><div id=\"root\"></div>");
  writeFileSync(join(uiDir, "assets", "app.js"), "console.log('quay');");
  return uiDir;
}

function makeEmbeddedAssets(files: Record<string, string>): EmbeddedUiAsset[] {
  return Object.entries(files).map(([path, body]) => ({
    path,
    contentBase64: Buffer.from(body, "utf8").toString("base64"),
  }));
}
