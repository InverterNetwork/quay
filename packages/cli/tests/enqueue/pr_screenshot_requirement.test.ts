import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createAgentResolver } from "../../src/core/agents.ts";
import { enqueue } from "../../src/core/enqueue.ts";
import { QuayError } from "../../src/core/errors.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { buildEnqueueDeps } from "../support/enqueue_deps.ts";
import { insertRepo } from "../support/fixtures.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("require PR screenshots rejects default worker without side effects", () => {
  h = createHarness();
  const repoId = insertRepo(h.db, "repo-require-default");
  const built = buildEnqueueDeps(h);
  built.deps.agentResolver = createAgentResolver({ db: h.db, config: {} });

  let caught: unknown;
  try {
    enqueue(built.deps, {
      repo_id: repoId,
      brief: "Implement UI change",
      require_pr_screenshots: true,
    });
  } catch (err) {
    caught = err;
  }

  expect(caught).toBeInstanceOf(QuayError);
  expect((caught as QuayError).code).toBe("missing_agent_capability");
  expect(built.git.calls).toHaveLength(0);
  expect(built.commandRunner.calls).toHaveLength(0);
  const taskCount = h.db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM tasks`)
    .get();
  expect(taskCount?.n).toBe(0);
});

test("require PR screenshots succeeds for screenshot-capable default worker", () => {
  h = createHarness();
  const repoId = insertRepo(h.db, "repo-require-capable");
  const built = buildEnqueueDeps(h);
  built.git.seedBareClone(repoId);
  h.ids.push("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  built.deps.agentResolver = createAgentResolver({
    db: h.db,
    config: {
      agents: {
        worker: "hermes_codex_browser",
        invocations: {
          hermes_codex_browser: {
            worker: "hermes chat --toolsets file,terminal,browser,vision",
            capabilities: ["browser", "screenshots"],
          },
        },
      },
    },
  });

  const result = enqueue(built.deps, {
    repo_id: repoId,
    brief: "Implement UI change",
    require_pr_screenshots: true,
  });

  const task = h.db
    .query<
      {
        pr_screenshots_requested: number;
        pr_screenshots_required: number;
        worker_agent: string | null;
      },
      [string]
    >(
      `SELECT pr_screenshots_requested, pr_screenshots_required, worker_agent
         FROM tasks WHERE task_id = ?`,
    )
    .get(result.task_id);
  expect(task).toEqual({
    pr_screenshots_requested: 1,
    pr_screenshots_required: 1,
    worker_agent: "hermes_codex_browser",
  });

  const brief = h.db
    .query<{ file_path: string }, [string, number]>(
      `SELECT file_path FROM artifacts
        WHERE task_id = ? AND attempt_id = ? AND kind = 'brief'`,
    )
    .get(result.task_id, result.attempt_id);
  expect(readFileSync(brief!.file_path, "utf8")).toContain(
    'required="true"',
  );
  expect(readFileSync(brief!.file_path, "utf8")).toContain(
    "Screenshots are required for this task.",
  );
});

test("require PR screenshots honors per-task worker-agent override", () => {
  h = createHarness();
  const repoId = insertRepo(h.db, "repo-require-override");
  const built = buildEnqueueDeps(h);
  built.git.seedBareClone(repoId);
  h.ids.push("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  built.deps.agentResolver = createAgentResolver({
    db: h.db,
    config: {
      agents: {
        invocations: {
          hermes_codex_browser: {
            worker: "hermes chat --toolsets file,terminal,browser,vision",
            worker_capabilities: ["screenshots"],
          },
        },
      },
    },
  });

  const result = enqueue(built.deps, {
    repo_id: repoId,
    brief: "Implement UI change",
    worker_agent: "hermes_codex_browser",
    require_pr_screenshots: true,
  });

  const task = h.db
    .query<{ worker_agent: string | null; pr_screenshots_required: number }, [string]>(
      `SELECT worker_agent, pr_screenshots_required FROM tasks WHERE task_id = ?`,
    )
    .get(result.task_id);
  expect(task).toEqual({
    worker_agent: "hermes_codex_browser",
    pr_screenshots_required: 1,
  });
});
