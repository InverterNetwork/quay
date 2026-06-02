import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { dispatch } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";
import { buildCliDeps } from "../support/cli_deps.ts";
import { createHarness, type Harness } from "../support/harness.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("settings import explicitly seeds deployment settings from TOML", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  const configPath = join(h.dataDir, "config.toml");
  writeFileSync(
    configPath,
    `[agents]
worker = "codex"
reviewer = "claude"
worker_model = "gpt-5.4"
reviewer_model = "gpt-5.5"

[agents.invocations.codex]
worker = "codex exec < {prompt_file}"
reviewer = "codex exec --review < {prompt_file}"
`,
  );

  const io = bufferIO();
  const result = await dispatch(
    ["settings", "import", "--from", configPath],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(io.out())).toMatchObject({
    imported: {
      worker_agent: "codex",
      worker_model: "gpt-5.4",
      reviewer_agent: "claude",
      reviewer_model: "gpt-5.5",
    },
    config_path: configPath,
  });
  expect(
    h.db.query<{ worker_agent: string; worker_model: string }, []>(
      `SELECT worker_agent, worker_model FROM deployment_settings WHERE singleton_id = 1`,
    ).get(),
  ).toEqual({ worker_agent: "codex", worker_model: "gpt-5.4" });
});

test("settings import validates imported agents against active runtime registry", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  built.deps.config = {
    agents: {
      invocations: {
        claude: { worker: "claude --w", reviewer: "claude --r" },
      },
    },
  };
  const configPath = join(h.dataDir, "config.toml");
  writeFileSync(
    configPath,
    `[agents]
worker = "codex"
reviewer = "claude"

[agents.invocations.codex]
worker = "codex exec < {prompt_file}"
reviewer = "codex exec --review < {prompt_file}"
`,
  );

  const io = bufferIO();
  const result = await dispatch(
    ["settings", "import", "--from", configPath],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(io.err())).toMatchObject({
    error: "validation_error",
    message:
      '[agents].worker = "codex" but no [agents.invocations.codex] is registered',
  });
  expect(
    h.db.query(`SELECT COUNT(*) AS count FROM deployment_settings`).get(),
  ).toEqual({ count: 0 });
});

test("settings import --only-empty preserves explicit null deployment settings row", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  built.deps.config = {
    agents: {
      invocations: {
        claude: { worker: "claude --w", reviewer: "claude --r" },
        codex: { worker: "codex --w", reviewer: "codex --r" },
      },
    },
  };
  h.db
    .query(
      `INSERT INTO deployment_settings (
         singleton_id, worker_agent, worker_model, reviewer_agent,
         reviewer_model, created_at, updated_at
       ) VALUES (1, NULL, NULL, NULL, NULL, ?, ?)`,
    )
    .run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  const configPath = join(h.dataDir, "config.toml");
  writeFileSync(
    configPath,
    `[agents]
worker = "codex"
reviewer = "codex"
worker_model = "gpt-5.4"
reviewer_model = "gpt-5.5"

[agents.invocations.codex]
worker = "codex exec < {prompt_file}"
reviewer = "codex exec --review < {prompt_file}"
`,
  );

  const io = bufferIO();
  const result = await dispatch(
    ["settings", "import", "--from", configPath, "--only-empty"],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(io.out())).toMatchObject({
    imported: {
      worker_agent: null,
      worker_model: null,
      reviewer_agent: null,
      reviewer_model: null,
    },
  });
  expect(
    h.db
      .query<{
        worker_agent: string | null;
        worker_model: string | null;
        reviewer_agent: string | null;
        reviewer_model: string | null;
        updated_at: string;
      }, []>(
        `SELECT worker_agent, worker_model, reviewer_agent, reviewer_model, updated_at
           FROM deployment_settings
          WHERE singleton_id = 1`,
      )
      .get(),
  ).toEqual({
    worker_agent: null,
    worker_model: null,
    reviewer_agent: null,
    reviewer_model: null,
    updated_at: "2026-01-01T00:00:00.000Z",
  });
});
