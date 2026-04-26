import { test, expect, afterEach } from "bun:test";
import { createHarness, type Harness } from "../support/harness.ts";
import { createRepoService } from "../../src/core/repos/service.ts";
import { enqueue } from "../../src/core/enqueue.ts";
import { QuayError } from "../../src/core/errors.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

const REQUIRED_FIELDS = {
  repo_id: "repo-1",
  repo_url: "git@example.com:owner/repo.git",
  base_branch: "main",
  package_manager: "bun",
  install_cmd: "bun install",
} as const;

test("test_enqueue_rejects_archived_repo", () => {
  h = createHarness();
  const repos = createRepoService({ db: h.db, clock: h.clock });

  repos.add({ ...REQUIRED_FIELDS });
  repos.remove(REQUIRED_FIELDS.repo_id);

  let caught: unknown;
  try {
    enqueue({ db: h.db, clock: h.clock }, { repo_id: REQUIRED_FIELDS.repo_id });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(QuayError);
  expect((caught as QuayError).code).toBe("repo_archived");

  // No task row was created as a side effect of the rejected enqueue.
  const taskCount = h.db
    .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM tasks")
    .get()!.c;
  expect(taskCount).toBe(0);
});
