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

test("enqueue uses task-level base_branch override for fetch, worktree, and task row", () => {
  h = createHarness();
  const repos = createRepoService({ db: h.db, clock: h.clock });
  repos.add({ ...REPO });

  const built = buildEnqueueDeps(h);
  built.git.seedBareClone(REPO.repo_id);

  h.ids.push("22222222aaaaaaaaaaaaaaaaaaaaaaaa");
  const result = enqueue(built.deps, {
    repo_id: REPO.repo_id,
    external_ref: "ITRY-902",
    brief: "Brief content",
    ticket_snapshot: "Ticket body",
    base_branch: "dev",
  });

  expect(built.git.calls.find((c) => c.op === "fetch")?.args).toEqual({
    repoId: REPO.repo_id,
    ref: "dev",
  });
  expect(built.git.calls.find((c) => c.op === "worktreeAdd")?.args).toMatchObject({
    repoId: REPO.repo_id,
    baseRef: "origin/dev",
  });

  const row = h.db
    .query<{ task_base: string; repo_base: string }, [string]>(
      `SELECT t.base_branch AS task_base, r.base_branch AS repo_base
         FROM tasks t JOIN repos r ON r.repo_id = t.repo_id
        WHERE t.task_id = ?`,
    )
    .get(result.task_id);
  expect(row).toEqual({ task_base: "dev", repo_base: "main" });
});

test("enqueue stores canonical slack_thread_ref", () => {
  h = createHarness();
  const repos = createRepoService({ db: h.db, clock: h.clock });
  repos.add({ ...REPO });

  const built = buildEnqueueDeps(h);
  built.git.seedBareClone(REPO.repo_id);

  h.ids.push("33333333aaaaaaaaaaaaaaaaaaaaaaaa");
  const result = enqueue(built.deps, {
    repo_id: REPO.repo_id,
    external_ref: "ITRY-904",
    brief: "Brief content",
    ticket_snapshot: "Ticket body",
    slack_thread_ref: "C0AEN8KDRT2:1782803100.722179",
  });

  const row = h.db
    .query<{ slack_thread_ref: string | null }, [string]>(
      "SELECT slack_thread_ref FROM tasks WHERE task_id = ?",
    )
    .get(result.task_id);
  expect(row?.slack_thread_ref).toBe("C0AEN8KDRT2:1782803100.722179");
});

test("enqueue normalizes prefixed slack_thread_ref before insert", () => {
  h = createHarness();
  const repos = createRepoService({ db: h.db, clock: h.clock });
  repos.add({ ...REPO });

  const built = buildEnqueueDeps(h);
  built.git.seedBareClone(REPO.repo_id);

  h.ids.push("44444444aaaaaaaaaaaaaaaaaaaaaaaa");
  const result = enqueue(built.deps, {
    repo_id: REPO.repo_id,
    external_ref: "ITRY-905",
    brief: "Brief content",
    ticket_snapshot: "Ticket body",
    slack_thread_ref: "slack:C0AEN8KDRT2:1782803100.722179",
  });

  const row = h.db
    .query<{ slack_thread_ref: string | null }, [string]>(
      "SELECT slack_thread_ref FROM tasks WHERE task_id = ?",
    )
    .get(result.task_id);
  expect(row?.slack_thread_ref).toBe("C0AEN8KDRT2:1782803100.722179");
});

test("enqueue rejects malformed slack_thread_ref before task creation", () => {
  h = createHarness();
  const repos = createRepoService({ db: h.db, clock: h.clock });
  repos.add({ ...REPO });

  const built = buildEnqueueDeps(h);
  built.git.seedBareClone(REPO.repo_id);

  expect(() =>
    enqueue(built.deps, {
      repo_id: REPO.repo_id,
      external_ref: "ITRY-906",
      brief: "Brief content",
      ticket_snapshot: "Ticket body",
      slack_thread_ref: "slack:C0AEN8KDRT2",
    }),
  ).toThrow(/slack_thread_ref must be CHANNEL:THREAD_TS/);

  expect(built.git.countCalls("fetch")).toBe(0);
  const row = h.db
    .query<{ count: number }, []>("SELECT count(*) AS count FROM tasks")
    .get();
  expect(row?.count).toBe(0);
});

test("enqueue rejects unsafe task-level base_branch override", () => {
  h = createHarness();
  const repos = createRepoService({ db: h.db, clock: h.clock });
  repos.add({ ...REPO });

  const built = buildEnqueueDeps(h);
  built.git.seedBareClone(REPO.repo_id);

  expect(() =>
    enqueue(built.deps, {
      repo_id: REPO.repo_id,
      external_ref: "ITRY-903",
      brief: "Brief content",
      ticket_snapshot: "Ticket body",
      base_branch: "../main",
    }),
  ).toThrow(/base_branch/);

  expect(built.git.countCalls("fetch")).toBe(0);
});
