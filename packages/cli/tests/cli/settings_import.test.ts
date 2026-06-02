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
