// AST-76: An empty directory at <repos_root>/<repo_id>.git (typoed path,
// half-finished clone) must route through the bare_clone_missing friendly-error
// path, not fall through to an obscure git error.
//
// This test exercises the FakeGit path: manually mkdirSync the expected
// directory WITHOUT calling seedBareClone (no HEAD file), then assert that
// enqueue throws bare_clone_missing.

import { test, expect, afterEach } from "bun:test";
import { mkdirSync } from "node:fs";
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
  repo_id: "repo-empty-dir",
  repo_url: "git@example.com:owner/empty.git",
  base_branch: "main",
  package_manager: "bun",
  install_cmd: "bun install",
} as const;

test("test_055b_empty_dir_at_bare_clone_path_throws_bare_clone_missing", () => {
  h = createHarness();
  const repos = createRepoService({ db: h.db, clock: h.clock });
  repos.add({ ...REPO });

  const built = buildEnqueueDeps(h);

  // Manually create the directory at the expected bare-clone path WITHOUT
  // calling seedBareClone (no HEAD file, so it is not a valid bare clone).
  mkdirSync(join(built.git.reposRoot, `${REPO.repo_id}.git`), { recursive: true });

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

  // Must throw bare_clone_missing even though the directory exists,
  // because it lacks a HEAD file.
  expect(caught).toBeInstanceOf(QuayError);
  const qErr = caught as QuayError;
  expect(qErr.code).toBe("bare_clone_missing");
  expect(qErr.details!.repo_id).toBe(REPO.repo_id);
});
