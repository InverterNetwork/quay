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
  repo_id: "repo-fresh",
  repo_url: "git@example.com:owner/fresh.git",
  base_branch: "main",
  package_manager: "bun",
  install_cmd: "bun install",
} as const;

test("test_055_enqueue_missing_bare_clone_errors_loudly", () => {
  h = createHarness();
  const repos = createRepoService({ db: h.db, clock: h.clock });
  repos.add({ ...REPO });

  const built = buildEnqueueDeps(h);
  // Intentionally do NOT call built.git.seedBareClone(REPO.repo_id).
  h.ids.push("aaaaaaaabbbbccccddddeeeeeeeeffff");

  let caught: unknown;
  try {
    enqueue(built.deps, {
      repo_id: REPO.repo_id,
      external_ref: "ITRY-900",
      brief: "Implement feature X",
      ticket_snapshot: "Ticket body for ITRY-900",
    });
  } catch (err) {
    caught = err;
  }

  // Must throw QuayError with code "bare_clone_missing".
  expect(caught).toBeInstanceOf(QuayError);
  const qErr = caught as QuayError;
  expect(qErr.code).toBe("bare_clone_missing");

  // Details include the expected path and the repo_id.
  expect(qErr.details).not.toBeNull();
  expect(qErr.details!.repo_id).toBe(REPO.repo_id);
  expect(typeof qErr.details!.expected_path).toBe("string");
  expect((qErr.details!.expected_path as string).endsWith(`${REPO.repo_id}.git`)).toBe(true);

  // No database rows written.
  const tasks = h.db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM tasks")
    .get()!.c;
  const attempts = h.db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM attempts")
    .get()!.c;
  const artifacts = h.db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM artifacts")
    .get()!.c;
  expect(tasks).toBe(0);
  expect(attempts).toBe(0);
  expect(artifacts).toBe(0);

  // No worktree directory created on disk.
  const expectedWorktreePath = join(built.worktreesRoot, "aaaaaaaabbbbccccddddeeeeeeeeffff");
  expect(existsSync(expectedWorktreePath)).toBe(false);

  // install_cmd never ran.
  expect(built.commandRunner.calls).toHaveLength(0);
});
