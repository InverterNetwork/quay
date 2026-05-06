// Slice 16 regression: extending `enqueue` with the optional `tags` and
// `authors_json` parameters must not change behavior on the legacy
// `--brief-file` path. With both adapters disabled the command operates
// as it always has — same input shape, same output shape, no `task_tags`
// rows, `authors_json` left NULL.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { buildCliDeps } from "../support/cli_deps.ts";

let h: Harness | null = null;
const scratchDirs: string[] = [];

afterEach(() => {
  h?.cleanup();
  h = null;
  for (const d of scratchDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "quay-bf-"));
  scratchDirs.push(d);
  return d;
}

function writeTemp(contents: string, name: string): string {
  const p = join(tempDir(), name);
  writeFileSync(p, contents);
  return p;
}

test("test_enqueue_brief_file_form_unchanged_when_adapters_disabled", async () => {
  h = createHarness();
  const built = buildCliDeps(h, {
    linearEnabled: false,
    slackEnabled: false,
  });

  await dispatch(
    [
      "repo",
      "add",
      "--id",
      "repo-bf",
      "--url",
      "git@example.com:o/r.git",
      "--base-branch",
      "main",
      "--package-manager",
      "bun",
      "--install-cmd",
      "true",
    ],
    built.deps,
    bufferIO(),
  );

  const briefPath = writeTemp("legacy brief body", "brief.md");
  const ticketPath = writeTemp("legacy ticket snapshot", "ticket.md");

  const io = bufferIO();
  const result = await dispatch(
    [
      "enqueue",
      "--repo",
      "repo-bf",
      "--brief-file",
      briefPath,
      "--ticket-snapshot-file",
      ticketPath,
      "--external-ref",
      "ITRY-900",
      "--slack-thread-ref",
      "C123:1700000000.0001",
    ],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");
  const out = JSON.parse(io.out().trim());
  expect(out.state).toBe("queued");
  expect(typeof out.task_id).toBe("string");

  // No tags landed (the legacy path doesn't supply any).
  const tagCount = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM task_tags WHERE task_id = ?`,
    )
    .get(out.task_id);
  expect(tagCount?.n).toBe(0);

  // authors_json stays NULL on the legacy path.
  const authorsRow = h.db
    .query<{ authors_json: string | null }, [string]>(
      `SELECT authors_json FROM tasks WHERE task_id = ?`,
    )
    .get(out.task_id);
  expect(authorsRow?.authors_json).toBeNull();

  // Adapters were never touched (linear disabled, slack disabled).
  expect(built.linear.getIssueCalls).toEqual([]);
  expect(built.slack.fetchThreadContextCalls).toEqual([]);
  // Validator was never invoked on the legacy path.
  expect(built.validatorRunner.runCalls).toEqual([]);
});
