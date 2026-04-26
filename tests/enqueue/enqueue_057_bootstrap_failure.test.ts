import { test, expect, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHarness, type Harness } from "../support/harness.ts";
import { createRepoService } from "../../src/core/repos/service.ts";
import { enqueue } from "../../src/core/enqueue.ts";
import { QuayError } from "../../src/core/errors.ts";
import { buildEnqueueDeps } from "../support/enqueue_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

const REPO = {
  repo_id: "repo-fail",
  repo_url: "git@example.com:owner/fail.git",
  base_branch: "main",
  package_manager: "bun",
  install_cmd: "bun install",
} as const;

function setupRepo(): { built: ReturnType<typeof buildEnqueueDeps>; repoId: string } {
  if (!h) throw new Error("harness not initialized");
  const repos = createRepoService({ db: h.db, clock: h.clock });
  repos.add({ ...REPO });
  return { built: buildEnqueueDeps(h), repoId: REPO.repo_id };
}

function assertNoTaskOrAttempt(harness: Harness): void {
  const tasks = harness.db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM tasks")
    .get()!.c;
  const attempts = harness.db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM attempts")
    .get()!.c;
  const artifacts = harness.db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM artifacts")
    .get()!.c;
  expect(tasks).toBe(0);
  expect(attempts).toBe(0);
  expect(artifacts).toBe(0);
}

test("test_057_enqueue_bootstrap_failure_leaves_no_task_row", () => {
  // Sub-case 1: install_cmd fails. Worktree + branch must be cleaned up.
  h = createHarness();
  {
    const { built } = setupRepo();
    built.commandRunner.failNext("install boom");
    h.ids.push("11111111aaaaaaaaaaaaaaaaaaaaaaaa");

    let caught: unknown;
    try {
      enqueue(built.deps, {
        repo_id: REPO.repo_id,
        external_ref: "ITRY-1",
        brief: "anything",
        ticket_snapshot: "ticket",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QuayError);
    expect((caught as QuayError).code).toBe("bootstrap_failed");

    assertNoTaskOrAttempt(h);

    // Cleanup invoked: worktree removed and branch deleted.
    expect(built.git.countCalls("worktreeRemove")).toBe(1);
    expect(built.git.countCalls("branchDelete")).toBe(1);
    expect(built.git.worktrees.size).toBe(0);
    const wtPath = join(built.worktreesRoot, "11111111aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(existsSync(wtPath)).toBe(false);
  }
  h.cleanup();

  // Sub-case 2: clone fails on a fresh repo. Partial bare clone is removed.
  h = createHarness();
  {
    const { built } = setupRepo();
    built.git.fail.cloneBare = () => true;
    h.ids.push("22222222aaaaaaaaaaaaaaaaaaaaaaaa");

    let caught: unknown;
    try {
      enqueue(built.deps, {
        repo_id: REPO.repo_id,
        brief: "anything",
        ticket_snapshot: "ticket",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);

    assertNoTaskOrAttempt(h);
    // Bare clone removal attempted.
    expect(built.git.countCalls("removeBareClone")).toBe(1);
    expect(built.git.bareCloneExists(REPO.repo_id)).toBe(false);
  }
  h.cleanup();

  // Sub-case 3: worktree add fails. No worktree to remove, branch wasn't created.
  h = createHarness();
  {
    const { built } = setupRepo();
    built.git.fail.worktreeAdd = () => true;
    h.ids.push("33333333aaaaaaaaaaaaaaaaaaaaaaaa");

    let caught: unknown;
    try {
      enqueue(built.deps, {
        repo_id: REPO.repo_id,
        external_ref: "ITRY-3",
        brief: "anything",
        ticket_snapshot: "ticket",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);

    assertNoTaskOrAttempt(h);
    // install should NOT have run (bootstrap failed before install step).
    expect(built.commandRunner.calls).toHaveLength(0);
  }
  h.cleanup();

  // Sub-case 4: artifact-store write failure during the SQL transaction step.
  h = createHarness();
  {
    const { built } = setupRepo();
    h.ids.push("44444444aaaaaaaaaaaaaaaaaaaaaaaa");
    // Force an artifact-store failure by making the artifact root unwritable
    // partway through. Simpler: monkey-patch writeArtifact to throw on second call.
    let calls = 0;
    const orig = built.deps.artifactStore.writeArtifact.bind(
      built.deps.artifactStore,
    );
    built.deps.artifactStore.writeArtifact = (input) => {
      calls += 1;
      if (calls === 2) throw new Error("synthetic artifact failure");
      return orig(input);
    };

    let caught: unknown;
    try {
      enqueue(built.deps, {
        repo_id: REPO.repo_id,
        external_ref: "ITRY-4",
        brief: "anything",
        ticket_snapshot: "ticket",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);

    assertNoTaskOrAttempt(h);
    // Worktree and branch were cleaned up after the in-transaction failure.
    expect(built.git.countCalls("worktreeRemove")).toBe(1);
    expect(built.git.countCalls("branchDelete")).toBe(1);
    expect(built.git.worktrees.size).toBe(0);
  }
  h.cleanup();
  h = null;
});
