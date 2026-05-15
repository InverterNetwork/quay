import { afterEach, expect, test } from "bun:test";
import { dispatch } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";
import { createAgentResolver } from "../../src/core/agents.ts";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { buildCliDeps } from "../support/cli_deps.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("enqueue snapshots task-level agent and model overrides", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  built.deps.agentResolver = createAgentResolver({
    db: h.db,
    config: {
      agents: {
        worker: "claude",
        worker_model: "global-worker-model",
        reviewer_model: "global-reviewer-model",
        invocations: {
          claude: { worker: "claude --w", reviewer: "claude --r" },
          codex: { worker: "codex exec", reviewer: "codex exec --review" },
        },
      },
    },
  });

  await dispatch(
    [
      "repo",
      "add",
      "--id",
      "quay",
      "--url",
      "git@github.com:acc/quay.git",
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
  built.git.seedBareClone("quay");

  const briefPath = `${h.dataDir}/brief.md`;
  await Bun.write(briefPath, "implement it\n");
  const io = bufferIO();
  const result = await dispatch(
    [
      "enqueue",
      "--repo",
      "quay",
      "--brief-file",
      briefPath,
      "--worker-agent",
      "codex",
      "--worker-model",
      "gpt-5.4",
      "--reviewer-model",
      "gpt-5.5",
    ],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  const out = JSON.parse(io.out());
  const row = h.db
    .query<
      {
        worker_agent: string | null;
        worker_model: string | null;
        reviewer_agent: string | null;
        reviewer_model: string | null;
      },
      [string]
    >(
      `SELECT worker_agent, worker_model, reviewer_agent, reviewer_model
         FROM tasks
        WHERE task_id = ?`,
    )
    .get(out.task_id);
  expect(row).toEqual({
    worker_agent: "codex",
    worker_model: "gpt-5.4",
    reviewer_agent: "claude",
    reviewer_model: "gpt-5.5",
  });
});

test("spawn uses snapshotted model even after repo defaults change", async () => {
  h = createHarness();
  h.clock.set("2026-05-15T10:00:00.000Z");
  const built = buildCliDeps(h);
  built.deps.agentResolver = createAgentResolver({
    db: h.db,
    config: {
      agents: {
        worker: "codex",
        worker_model: "global-model",
        invocations: {
          claude: { worker: "claude --w", reviewer: "claude --r" },
          codex: { worker: "bun --version", reviewer: "bun --version" },
        },
      },
    },
  });
  await dispatch(
    [
      "repo",
      "add",
      "--id",
      "quay",
      "--url",
      "git@github.com:acc/quay.git",
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
  built.git.seedBareClone("quay");
  const briefPath = `${h.dataDir}/brief.md`;
  await Bun.write(briefPath, "implement it\n");
  const io = bufferIO();
  await dispatch(
    ["enqueue", "--repo", "quay", "--brief-file", briefPath, "--worker-model", "snapshot-model"],
    built.deps,
    io,
  );
  const enqueued = JSON.parse(io.out()) as { task_id: string; branch_name: string };
  const taskId = enqueued.task_id;

  h.db
    .query(`UPDATE repos SET model_worker = ? WHERE repo_id = ?`)
    .run("changed-repo-model", "quay");

  const tickBuilt = buildTickDeps(h);
  tickBuilt.git.setRemoteHeadSha("quay", enqueued.branch_name, null);
  tickBuilt.github.setPrExists("quay", enqueued.branch_name, false);
  const results = await tick_once(tickBuilt.deps, {
    agentResolver: built.deps.agentResolver,
  });
  expect(results).toEqual([{ task_id: taskId, action: "spawned" }]);
  expect(tickBuilt.tmux.spawnCalls[0]!.agentInvocation).toBe(
    "bun --version --model 'snapshot-model'",
  );
  const attempt = h.db
    .query<{ agent_name: string | null; agent_model: string | null }, [string]>(
      `SELECT agent_name, agent_model FROM attempts WHERE task_id = ?`,
    )
    .get(taskId);
  expect(attempt).toEqual({ agent_name: "codex", agent_model: "snapshot-model" });
});
