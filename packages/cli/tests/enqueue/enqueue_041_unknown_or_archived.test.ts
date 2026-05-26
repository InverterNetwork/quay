import { test, expect, afterEach } from "bun:test";
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
  repo_id: "repo-known",
  repo_url: "git@example.com:owner/r.git",
  base_branch: "main",
  package_manager: "bun",
  install_cmd: "bun install",
} as const;

function assertNoSideEffects(
  h: Harness,
  built: ReturnType<typeof buildEnqueueDeps>,
): void {
  expect(built.git.calls).toHaveLength(0);
  expect(built.commandRunner.calls).toHaveLength(0);
  expect(built.git.bareClones.size).toBe(0);
  expect(built.git.worktrees.size).toBe(0);
  const tasks = h.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM tasks").get()!.c;
  const attempts = h.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM attempts").get()!.c;
  const artifacts = h.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM artifacts").get()!.c;
  expect(tasks).toBe(0);
  expect(attempts).toBe(0);
  expect(artifacts).toBe(0);
}

test("test_041_enqueue_rejects_unknown_or_archived_repo", () => {
  // Unknown repo.
  h = createHarness();
  {
    const built = buildEnqueueDeps(h);
    let caught: unknown;
    try {
      enqueue(built.deps, {
        repo_id: "no-such-repo",
        brief: "anything",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QuayError);
    expect((caught as QuayError).code).toBe("unknown_repo");
    assertNoSideEffects(h, built);
  }
  h.cleanup();

  // Archived repo.
  h = createHarness();
  {
    const repos = createRepoService({ db: h.db, clock: h.clock });
    repos.add({ ...REPO });
    repos.remove(REPO.repo_id);

    const built = buildEnqueueDeps(h);

    let caught: unknown;
    try {
      enqueue(built.deps, {
        repo_id: REPO.repo_id,
        brief: "anything",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QuayError);
    expect((caught as QuayError).code).toBe("repo_archived");
    assertNoSideEffects(h, built);
  }
  h.cleanup();
  h = null;
});
