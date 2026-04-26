import { test, expect, afterEach } from "bun:test";
import { createHarness, type Harness } from "../support/harness.ts";
import { createRepoService } from "../../src/core/repos/service.ts";
import { enqueue } from "../../src/core/enqueue.ts";
import { buildEnqueueDeps } from "../support/enqueue_deps.ts";
import { taskIdShort } from "../../src/core/branch_slug.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

const REPO = {
  repo_id: "repo-slug",
  repo_url: "git@example.com:owner/r.git",
  base_branch: "main",
  package_manager: "bun",
  install_cmd: "bun install",
} as const;

interface Case {
  externalRef: string | undefined;
  taskId: string;
  expectedBranch: (taskIdShortValue: string) => string;
  expectedExternalRef: string | null;
}

const CASES: Case[] = [
  {
    externalRef: "ITRY-900",
    taskId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    expectedBranch: () => "quay/ITRY-900",
    expectedExternalRef: "ITRY-900",
  },
  {
    externalRef: "feat/ABC.123",
    taskId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    expectedBranch: () => "quay/feat/ABC.123",
    expectedExternalRef: "feat/ABC.123",
  },
  {
    externalRef: undefined,
    taskId: "cccccccccccccccccccccccccccccccc",
    expectedBranch: (s) => `quay/task-${s}`,
    expectedExternalRef: null,
  },
  {
    externalRef: "...",
    taskId: "dddddddddddddddddddddddddddddddd",
    expectedBranch: (s) => `quay/task-${s}`,
    expectedExternalRef: "...",
  },
];

test("test_039_branch_slug_examples", () => {
  for (const c of CASES) {
    h = createHarness();
    const repos = createRepoService({ db: h.db, clock: h.clock });
    repos.add({ ...REPO });

    const built = buildEnqueueDeps(h);
    h.ids.push(c.taskId);

    const result = enqueue(built.deps, {
      repo_id: REPO.repo_id,
      ...(c.externalRef !== undefined ? { external_ref: c.externalRef } : {}),
      brief: "b",
      ticket_snapshot: "t",
    });

    const shortId = taskIdShort(c.taskId);
    expect(result.branch_name).toBe(c.expectedBranch(shortId));

    const row = h.db
      .query<{ external_ref: string | null; branch_name: string }, [string]>(
        "SELECT external_ref, branch_name FROM tasks WHERE task_id = ?",
      )
      .get(result.task_id);
    expect(row!.branch_name).toBe(c.expectedBranch(shortId));
    expect(row!.external_ref).toBe(c.expectedExternalRef);

    h.cleanup();
    h = null;
  }
});
