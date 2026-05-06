import { test, expect, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { createHarness, type Harness } from "../support/harness.ts";
import { createRepoService } from "../../src/core/repos/service.ts";
import { enqueue } from "../../src/core/enqueue.ts";
import { buildEnqueueDeps } from "../support/enqueue_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

const REPO = {
  repo_id: "repo-existing",
  repo_url: "git@example.com:owner/existing.git",
  base_branch: "main",
  package_manager: "bun",
  install_cmd: "bun install",
} as const;

test("test_056_enqueue_with_present_bare_clone_queues_task", () => {
  h = createHarness();
  const repos = createRepoService({ db: h.db, clock: h.clock });
  repos.add({ ...REPO });

  const built = buildEnqueueDeps(h);
  // Pre-existing bare clone from a prior task in this repo.
  built.git.seedBareClone(REPO.repo_id);

  h.ids.push("11111111aaaaaaaaaaaaaaaaaaaaaaaa");
  const result = enqueue(built.deps, {
    repo_id: REPO.repo_id,
    external_ref: "ITRY-901",
    brief: "Brief content",
    ticket_snapshot: "Ticket body",
  });

  // Bare clone was pre-seeded and still present.
  expect(built.git.bareCloneExists(REPO.repo_id)).toBe(true);

  // Fetch + worktree + install still ran.
  expect(built.git.countCalls("fetch")).toBe(1);
  expect(built.git.countCalls("worktreeAdd")).toBe(1);
  expect(existsSync(result.worktree_path)).toBe(true);
  expect(built.commandRunner.calls).toHaveLength(1);
  expect(built.commandRunner.calls[0]!.command).toBe(REPO.install_cmd);

  // Queued task created.
  const taskState = h.db
    .query<{ state: string }, [string]>(
      "SELECT state FROM tasks WHERE task_id = ?",
    )
    .get(result.task_id);
  expect(taskState!.state).toBe("queued");
});
