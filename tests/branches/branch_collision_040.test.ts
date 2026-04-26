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
  repo_id: "repo-collision",
  repo_url: "git@example.com:owner/r.git",
  base_branch: "main",
  package_manager: "bun",
  install_cmd: "bun install",
} as const;

interface CollisionCase {
  source: "local" | "remote" | "open_pr";
}

const CASES: CollisionCase[] = [
  { source: "local" },
  { source: "remote" },
  { source: "open_pr" },
];

test("test_040_branch_collision_adds_task_suffix", () => {
  for (const c of CASES) {
    h = createHarness();
    const repos = createRepoService({ db: h.db, clock: h.clock });
    repos.add({ ...REPO });

    const built = buildEnqueueDeps(h);
    const taskId = "abcdef0123456789abcdef0123456789";
    h.ids.push(taskId);
    const shortId = taskIdShort(taskId);

    const preferred = "quay/ITRY-900";
    if (c.source === "local") built.git.setLocalBranches(REPO.repo_id, [preferred]);
    if (c.source === "remote") built.git.setRemoteBranches(REPO.repo_id, [preferred]);
    if (c.source === "open_pr")
      built.git.setOpenPrBranches(REPO.repo_id, [preferred]);

    const result = enqueue(built.deps, {
      repo_id: REPO.repo_id,
      external_ref: "ITRY-900",
      brief: "b",
      ticket_snapshot: "t",
    });

    expect(result.branch_name).toBe(`quay/ITRY-900-${shortId}`);

    // Resolution must check both sources for both the preferred and the
    // disambiguated form.
    const localChecks = built.git.calls.filter(
      (k) => k.op === "hasLocalBranch",
    );
    const remoteChecks = built.git.calls.filter(
      (k) => k.op === "hasRemoteBranch",
    );
    const prChecks = built.git.calls.filter(
      (k) => k.op === "hasOpenPullRequestForBranch",
    );
    expect(localChecks.length).toBeGreaterThanOrEqual(2);
    expect(remoteChecks.length + prChecks.length).toBeGreaterThanOrEqual(1);

    h.cleanup();
    h = null;
  }
});
