import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertRepo, insertRunningTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("dead-worker classifier ingests .quay-usage.json on any terminal path", async () => {
  // Crashed path is the most demanding: the worker died without a PR
  // or signal, but the classifier should still capture the usage
  // envelope the wrapper persisted before death. Per the DoD this
  // pins capture on every terminal exit_kind, not just pr_opened.
  h = createHarness();
  h.clock.set("2026-05-10T13:30:00.000Z");

  const repoId = insertRepo(h.db, "repo-usage-e2e");
  const worktreesRoot = join(h.dataDir, "worktrees");
  const t = insertRunningTask(h.db, {
    taskId: "task-usage-e2e",
    repoId,
    worktreesRoot,
    remoteShaAtSpawn: null,
    prExistedAtSpawn: 0,
  });

  // Drop a realistic claude `--output-format json` envelope into the
  // worktree so the classifier can ingest it. Real envelopes have far
  // more fields; the artifact is content-addressed verbatim, so any
  // valid JSON suffices to assert the wiring.
  const envelope = {
    agent_identity: "claude/2.1.132/opus-4.7",
    input_tokens: 12345,
    output_tokens: 6789,
    cache_creation_tokens: 0,
    cache_read_tokens: 5432,
    total_cost_usd: 0.1234,
    duration_ms: 54321,
  };
  writeFileSync(
    join(t.worktreePath, ".quay-usage.json"),
    JSON.stringify(envelope),
  );

  const built = buildTickDeps(h);
  built.tmux.markDead(t.sessionName!);
  built.git.setRemoteHeadSha(repoId, t.branchName, null);
  built.github.setPrExists(repoId, t.branchName, false);

  await tick_once(built.deps);

  const rows = h.db
    .query<{ artifact_id: number; kind: string }, [string, number]>(
      `SELECT artifact_id, kind FROM artifacts
         WHERE task_id = ? AND attempt_id = ? AND kind = 'usage'`,
    )
    .all(t.taskId, t.attemptId);
  expect(rows).toHaveLength(1);
});

test("dead Codex worker normalizes usage from JSONL tool_trace", async () => {
  h = createHarness();
  h.clock.set("2026-05-10T13:30:30.000Z");

  const repoId = insertRepo(h.db, "repo-codex-usage-e2e");
  const worktreesRoot = join(h.dataDir, "worktrees");
  const t = insertRunningTask(h.db, {
    taskId: "task-codex-usage-e2e",
    repoId,
    worktreesRoot,
    remoteShaAtSpawn: null,
    prExistedAtSpawn: 0,
  });

  const trace = [
    JSON.stringify({ type: "session_configured", model: "gpt-5.5-codex" }),
    JSON.stringify({
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 12,
          output_tokens: 8,
          cached_input_tokens: 3,
          reasoning_output_tokens: 2,
          total_tokens: 20,
        },
      },
    }),
  ].join("\n");
  writeFileSync(join(t.worktreePath, ".quay-tool-trace.log"), `${trace}\n`);

  const built = buildTickDeps(h);
  built.tmux.markDead(t.sessionName!);
  built.git.setRemoteHeadSha(repoId, t.branchName, null);
  built.github.setPrExists(repoId, t.branchName, false);

  await tick_once(built.deps);

  const usage = h.db
    .query<{ file_path: string }, [string, number]>(
      `SELECT file_path FROM artifacts
         WHERE task_id = ? AND attempt_id = ? AND kind = 'usage'`,
    )
    .get(t.taskId, t.attemptId);
  expect(usage).not.toBeNull();
  expect(JSON.parse(readFileSync(usage!.file_path, "utf8"))).toEqual({
    source: "codex_jsonl",
    model: "gpt-5.5-codex",
    input_tokens: 12,
    output_tokens: 8,
    cache_read_tokens: 3,
    reasoning_tokens: 2,
    total_tokens: 20,
  });

  const toolTrace = h.db
    .query<{ file_path: string }, [string, number]>(
      `SELECT file_path FROM artifacts
         WHERE task_id = ? AND attempt_id = ? AND kind = 'tool_trace'`,
    )
    .get(t.taskId, t.attemptId);
  expect(toolTrace).not.toBeNull();
  expect(readFileSync(toolTrace!.file_path, "utf8")).toBe(`${trace}\n`);
});

test("no usage artifact when the worker did not write .quay-usage.json", async () => {
  h = createHarness();
  h.clock.set("2026-05-10T13:31:00.000Z");

  const repoId = insertRepo(h.db, "repo-usage-absent");
  const worktreesRoot = join(h.dataDir, "worktrees");
  const t = insertRunningTask(h.db, {
    taskId: "task-usage-absent",
    repoId,
    worktreesRoot,
    remoteShaAtSpawn: null,
    prExistedAtSpawn: 0,
  });

  const built = buildTickDeps(h);
  built.tmux.markDead(t.sessionName!);
  built.git.setRemoteHeadSha(repoId, t.branchName, null);
  built.github.setPrExists(repoId, t.branchName, false);

  await tick_once(built.deps);

  const count = h.db
    .query<{ n: number }, [string, number]>(
      `SELECT COUNT(*) AS n FROM artifacts
         WHERE task_id = ? AND attempt_id = ? AND kind = 'usage'`,
    )
    .get(t.taskId, t.attemptId);
  expect(count!.n).toBe(0);
});
