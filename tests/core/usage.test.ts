import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { createArtifactStore } from "../../src/artifacts/store.ts";
import { collectToolTraceArtifact } from "../../src/core/tool_trace.ts";
import { collectUsageArtifact } from "../../src/core/usage.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import {
  insertAttempt,
  insertRepo,
  insertTask,
} from "../support/fixtures.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

interface UsageRow {
  artifact_id: number;
  kind: string;
  content_hash: string | null;
  file_path: string;
}

function setupAttempt(): { taskId: string; attemptId: number } {
  const repoId = insertRepo(h!.db, "repo-usage");
  const taskId = insertTask(h!.db, { taskId: "task-usage", repoId });
  const attemptId = insertAttempt(h!.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
  });
  return { taskId, attemptId };
}

function deps() {
  return {
    db: h!.db,
    artifactStore: createArtifactStore({
      db: h!.db,
      artifactRoot: h!.artifactRoot,
      clock: h!.clock,
    }),
  };
}

function usageArtifact(taskId: string, attemptId: number): unknown {
  const row = h!.db
    .query<{ file_path: string }, [string, number]>(
      `SELECT file_path
         FROM artifacts WHERE task_id = ? AND attempt_id = ? AND kind = 'usage'
        ORDER BY artifact_id DESC LIMIT 1`,
    )
    .get(taskId, attemptId);
  expect(row).not.toBeNull();
  return JSON.parse(readFileSync(row!.file_path, "utf8"));
}

test("writes a usage artifact when .quay-usage.json contains valid JSON", () => {
  h = createHarness();
  h.clock.set("2026-05-10T13:00:00.000Z");
  const { taskId, attemptId } = setupAttempt();

  const envelope = {
    agent_identity: "claude/2.1.132/opus-4.7",
    input_tokens: 12345,
    output_tokens: 6789,
    total_cost_usd: 0.1234,
    duration_ms: 54321,
  };
  writeFileSync(
    join(h.dataDir, ".quay-usage.json"),
    JSON.stringify(envelope),
  );

  collectUsageArtifact(deps(), taskId, attemptId, h.dataDir);

  const rows = h.db
    .query<UsageRow, [string, number]>(
      `SELECT artifact_id, kind, content_hash, file_path
         FROM artifacts WHERE task_id = ? AND attempt_id = ? AND kind = 'usage'`,
    )
    .all(taskId, attemptId);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.content_hash).not.toBeNull();
});

test("normalizes Codex JSONL usage from .quay-tool-trace.log", () => {
  h = createHarness();
  h.clock.set("2026-05-10T13:02:00.000Z");
  const { taskId, attemptId } = setupAttempt();

  const trace = [
    JSON.stringify({ type: "session_configured", model: "gpt-5.5-codex" }),
    JSON.stringify({
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 123,
          cached_input_tokens: 45,
          output_tokens: 67,
          reasoning_output_tokens: 8,
          total_tokens: 190,
        },
        last_token_usage: {
          input_tokens: 3,
          output_tokens: 4,
          total_tokens: 7,
        },
      },
    }),
  ].join("\n");
  writeFileSync(join(h.dataDir, ".quay-tool-trace.log"), `${trace}\n`);

  collectUsageArtifact(deps(), taskId, attemptId, h.dataDir);

  expect(usageArtifact(taskId, attemptId)).toEqual({
    source: "codex_jsonl",
    model: "gpt-5.5-codex",
    input_tokens: 123,
    output_tokens: 67,
    cache_read_tokens: 45,
    reasoning_tokens: 8,
    total_tokens: 190,
  });
});

test("skips Codex JSONL that has no usage data", () => {
  h = createHarness();
  const { taskId, attemptId } = setupAttempt();
  writeFileSync(
    join(h.dataDir, ".quay-tool-trace.log"),
    `${JSON.stringify({ type: "session_configured", model: "gpt-5.5-codex" })}\n`,
  );

  collectUsageArtifact(deps(), taskId, attemptId, h.dataDir);

  const count = h.db
    .query<{ n: number }, [string, number]>(
      `SELECT COUNT(*) AS n FROM artifacts
         WHERE task_id = ? AND attempt_id = ? AND kind = 'usage'`,
    )
    .get(taskId, attemptId);
  expect(count!.n).toBe(0);
});

test("skips malformed Codex JSONL without blocking capture", () => {
  h = createHarness();
  const { taskId, attemptId } = setupAttempt();
  writeFileSync(
    join(h.dataDir, ".quay-tool-trace.log"),
    [
      JSON.stringify({ type: "session_configured", model: "gpt-5.5-codex" }),
      '{"type":"token_count","info":{"total_token_usage":{"input_tokens":1}',
    ].join("\n"),
  );

  collectUsageArtifact(deps(), taskId, attemptId, h.dataDir);

  const count = h.db
    .query<{ n: number }, [string, number]>(
      `SELECT COUNT(*) AS n FROM artifacts
         WHERE task_id = ? AND attempt_id = ? AND kind = 'usage'`,
    )
    .get(taskId, attemptId);
  expect(count!.n).toBe(0);
});

test("Codex usage normalization preserves the raw tool_trace artifact", () => {
  h = createHarness();
  h.clock.set("2026-05-10T13:03:00.000Z");
  const { taskId, attemptId } = setupAttempt();
  const trace = [
    JSON.stringify({
      type: "response.completed",
      response: {
        model: "gpt-5.5",
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 4 },
          output_tokens: 5,
          output_tokens_details: { reasoning_tokens: 2 },
        },
      },
    }),
  ].join("\n");
  writeFileSync(join(h.dataDir, ".quay-tool-trace.log"), `${trace}\n`);

  collectUsageArtifact(deps(), taskId, attemptId, h.dataDir);
  collectToolTraceArtifact(deps(), taskId, attemptId, h.dataDir);

  expect(usageArtifact(taskId, attemptId)).toEqual({
    source: "codex_jsonl",
    model: "gpt-5.5",
    input_tokens: 10,
    output_tokens: 5,
    cache_read_tokens: 4,
    reasoning_tokens: 2,
    total_tokens: 15,
  });
  const traceRow = h.db
    .query<{ file_path: string }, [string, number]>(
      `SELECT file_path FROM artifacts
        WHERE task_id = ? AND attempt_id = ? AND kind = 'tool_trace'`,
    )
    .get(taskId, attemptId);
  expect(traceRow).not.toBeNull();
  expect(readFileSync(traceRow!.file_path, "utf8")).toBe(`${trace}\n`);
});

test("re-reading the same envelope is idempotent (no duplicate artifact)", () => {
  h = createHarness();
  h.clock.set("2026-05-10T13:01:00.000Z");
  const { taskId, attemptId } = setupAttempt();

  const envelope = { input_tokens: 1, output_tokens: 1 };
  writeFileSync(
    join(h.dataDir, ".quay-usage.json"),
    JSON.stringify(envelope),
  );

  // Two calls — recovery-path semantics. The partial unique index on
  // (task_id, attempt_id, kind, content_hash) collapses the second
  // insert; the helper swallows the resulting error.
  collectUsageArtifact(deps(), taskId, attemptId, h.dataDir);
  collectUsageArtifact(deps(), taskId, attemptId, h.dataDir);

  const count = h.db
    .query<{ n: number }, [string, number]>(
      `SELECT COUNT(*) AS n FROM artifacts
         WHERE task_id = ? AND attempt_id = ? AND kind = 'usage'`,
    )
    .get(taskId, attemptId);
  expect(count!.n).toBe(1);
});

test("skips when the file is absent", () => {
  h = createHarness();
  const { taskId, attemptId } = setupAttempt();

  // No file written — common case for spawn_failed and for agents
  // whose invocation does not emit a structured envelope.
  collectUsageArtifact(deps(), taskId, attemptId, h.dataDir);

  const count = h.db
    .query<{ n: number }, [string, number]>(
      `SELECT COUNT(*) AS n FROM artifacts
         WHERE task_id = ? AND attempt_id = ? AND kind = 'usage'`,
    )
    .get(taskId, attemptId);
  expect(count!.n).toBe(0);
});

test("skips when the file is empty", () => {
  h = createHarness();
  const { taskId, attemptId } = setupAttempt();
  writeFileSync(join(h.dataDir, ".quay-usage.json"), "");

  // A wall-clock kill that fires before claude flushes the JSON
  // produces an empty file. Empty is not valid JSON; capture skips.
  collectUsageArtifact(deps(), taskId, attemptId, h.dataDir);

  const count = h.db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'usage'`,
    )
    .get();
  expect(count!.n).toBe(0);
});

test("skips when the file contains malformed JSON", () => {
  h = createHarness();
  const { taskId, attemptId } = setupAttempt();
  writeFileSync(
    join(h.dataDir, ".quay-usage.json"),
    '{"input_tokens": 1, "output',
  );

  collectUsageArtifact(deps(), taskId, attemptId, h.dataDir);

  const count = h.db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'usage'`,
    )
    .get();
  expect(count!.n).toBe(0);
});
