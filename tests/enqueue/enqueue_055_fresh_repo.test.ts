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
  repo_id: "repo-fresh",
  repo_url: "git@example.com:owner/fresh.git",
  base_branch: "main",
  package_manager: "bun",
  install_cmd: "bun install",
} as const;

test("test_055_enqueue_fresh_repo_bootstraps_and_queues_task", () => {
  h = createHarness();
  const repos = createRepoService({ db: h.db, clock: h.clock });
  repos.add({ ...REPO });

  const built = buildEnqueueDeps(h);
  h.ids.push("aaaaaaaabbbbccccddddeeeeeeeeffff");

  const result = enqueue(built.deps, {
    repo_id: REPO.repo_id,
    external_ref: "ITRY-900",
    brief: "Implement feature X",
    ticket_snapshot: "Ticket body for ITRY-900",
  });

  // Bootstrap side effects (in order matters for clone-then-fetch-then-worktree).
  expect(built.git.bareCloneExists(REPO.repo_id)).toBe(true);
  expect(built.git.countCalls("cloneBare")).toBe(1);
  expect(built.git.countCalls("fetch")).toBe(1);
  expect(built.git.countCalls("worktreeAdd")).toBe(1);
  expect(existsSync(result.worktree_path)).toBe(true);

  // Install ran exactly once, in the worktree.
  expect(built.commandRunner.calls).toHaveLength(1);
  expect(built.commandRunner.calls[0]!.command).toBe(REPO.install_cmd);
  expect(built.commandRunner.calls[0]!.cwd).toBe(result.worktree_path);

  // Task row.
  const task = h.db
    .query<
      {
        task_id: string;
        repo_id: string;
        state: string;
        external_ref: string | null;
        branch_name: string;
        tmux_id: string;
        worktree_path: string;
        retry_budget: number;
        attempts_consumed: number;
      },
      [string]
    >(
      `SELECT task_id, repo_id, state, external_ref, branch_name, tmux_id,
              worktree_path, retry_budget, attempts_consumed
         FROM tasks WHERE task_id = ?`,
    )
    .get(result.task_id);
  expect(task).not.toBeNull();
  expect(task!.state).toBe("queued");
  expect(task!.repo_id).toBe(REPO.repo_id);
  expect(task!.external_ref).toBe("ITRY-900");
  expect(task!.branch_name).toBe("quay/ITRY-900");
  expect(task!.attempts_consumed).toBe(0);
  expect(task!.retry_budget).toBeGreaterThan(0);

  // Attempt #1: pending.
  const attempt = h.db
    .query<
      {
        attempt_id: number;
        attempt_number: number;
        reason: string;
        consumed_budget: number;
        spawned_at: string | null;
        tmux_session: string | null;
      },
      [string]
    >(
      `SELECT attempt_id, attempt_number, reason, consumed_budget, spawned_at, tmux_session
         FROM attempts WHERE task_id = ?`,
    )
    .get(result.task_id);
  expect(attempt).not.toBeNull();
  expect(attempt!.attempt_number).toBe(1);
  expect(attempt!.reason).toBe("initial");
  expect(attempt!.consumed_budget).toBe(1);
  expect(attempt!.spawned_at).toBeNull();
  expect(attempt!.tmux_session).toBeNull();

  // No tmux activity occurred — slice 2 owns no TmuxPort, so the assertion
  // is structural: spawned_at and tmux_session both remain NULL.
});
