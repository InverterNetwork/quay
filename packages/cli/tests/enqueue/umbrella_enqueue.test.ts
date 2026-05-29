import { afterEach, expect, test } from "bun:test";
import { createHarness, type Harness } from "../support/harness.ts";
import { createRepoService } from "../../src/core/repos/service.ts";
import { enqueue } from "../../src/core/enqueue.ts";
import { buildEnqueueDeps } from "../support/enqueue_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("umbrella enqueue creates workflow branch and retargets subtask base", () => {
  h = createHarness();
  const repos = createRepoService({ db: h.db, clock: h.clock });
  repos.add({
    repo_id: "repo-umbrella",
    repo_url: "git@example.com:owner/repo.git",
    base_branch: "main",
    package_manager: "bun",
    install_cmd: "bun install",
  });
  const built = buildEnqueueDeps(h);
  built.git.seedBareClone("repo-umbrella");
  h.ids.push("11111111222233334444555555555555");

  const result = enqueue(built.deps, {
    repo_id: "repo-umbrella",
    external_ref: "BRIX-1510",
    brief: "Implement umbrella subtask",
    umbrella: {
      external_ref: "BRIX-1509",
      base_branch: "dev",
      feature_branch: "feature/brix-1509",
    },
  });

  expect(result.state).toBe("queued");
  const task = h.db
    .query<
      { base_branch: string; branch_name: string },
      [string]
    >(`SELECT base_branch, branch_name FROM tasks WHERE task_id = ?`)
    .get(result.task_id);
  expect(task).toMatchObject({
    base_branch: "feature/brix-1509",
    branch_name: result.branch_name,
  });

  const workflow = h.db
    .query<
      {
        external_ref: string;
        repo_id: string;
        base_branch: string;
        feature_branch: string;
        state: string;
        final_pr_task_id: string | null;
        final_pr_number: number | null;
        final_pr_url: string | null;
      },
      []
    >(
      `SELECT external_ref, repo_id, base_branch, feature_branch, state,
              final_pr_task_id, final_pr_number, final_pr_url
         FROM umbrella_workflows`,
    )
    .get();
  expect(workflow).toEqual({
    external_ref: "BRIX-1509",
    repo_id: "repo-umbrella",
    base_branch: "dev",
    feature_branch: "feature/brix-1509",
    state: "active",
    final_pr_task_id: null,
    final_pr_number: null,
    final_pr_url: null,
  });

  const link = h.db
    .query<{ task_id: string; external_ref: string }, []>(
      `SELECT task_id, external_ref FROM umbrella_tasks`,
    )
    .get();
  expect(link).toEqual({
    task_id: result.task_id,
    external_ref: "BRIX-1510",
  });

  expect(built.git.calls).toContainEqual({
    op: "ensureRemoteBranchFromBase",
    args: {
      repoId: "repo-umbrella",
      branch: "feature/brix-1509",
      baseBranch: "dev",
    },
  });
  expect(built.git.calls).toContainEqual({
    op: "worktreeAdd",
    args: {
      repoId: "repo-umbrella",
      worktreePath: result.worktree_path,
      branch: result.branch_name,
      baseRef: "origin/feature/brix-1509",
    },
  });
});

test("umbrella enqueue derives deterministic feature branch when omitted", () => {
  h = createHarness();
  const repos = createRepoService({ db: h.db, clock: h.clock });
  repos.add({
    repo_id: "repo-umbrella-derived",
    repo_url: "git@example.com:owner/repo.git",
    base_branch: "main",
    package_manager: "bun",
    install_cmd: "bun install",
  });
  const built = buildEnqueueDeps(h);
  built.git.seedBareClone("repo-umbrella-derived");
  h.ids.push("aaaaaaaa222233334444555555555555");

  enqueue(built.deps, {
    repo_id: "repo-umbrella-derived",
    external_ref: "BRIX-1511",
    brief: "Implement umbrella subtask",
    umbrella: {
      external_ref: "Umbrella BRIX-1509!",
    },
  });

  const row = h.db
    .query<{ feature_branch: string; base_branch: string }, []>(
      `SELECT feature_branch, base_branch FROM umbrella_workflows`,
    )
    .get();
  expect(row).toEqual({
    feature_branch: "quay/umbrella/Umbrella-BRIX-1509",
    base_branch: "main",
  });
});
