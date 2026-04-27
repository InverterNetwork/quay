import { test, expect, afterEach } from "bun:test";
import { createHarness, type Harness } from "../support/harness.ts";
import { QuayError } from "../../src/core/errors.ts";
import { createRepoService, type RepoRow } from "../../src/core/repos/service.ts";
import { insertTask } from "../support/fixtures.ts";

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

test("test_repo_remove_soft_deletes_repo", () => {
  h = createHarness();
  const repos = createRepoService({ db: h.db, clock: h.clock });

  repos.add({ ...REQUIRED_FIELDS });
  // Create a terminal task that references the repo so we can prove the FK is preserved.
  insertTask(h.db, {
    repoId: REQUIRED_FIELDS.repo_id,
    taskId: "task-keep",
    state: "merged",
  });

  h.clock.advanceMs(60_000);
  const expectedArchivedAt = h.clock.nowISO();

  const removed = repos.remove(REQUIRED_FIELDS.repo_id);
  expect(removed.archived_at).toBe(expectedArchivedAt);

  // Row is still present (soft delete), with archived_at set.
  const row = h.db
    .query<RepoRow, [string]>(
      `SELECT repo_id, repo_url, base_branch, package_manager, install_cmd,
              test_cmd, ci_workflow_name, contribution_guide_path,
              archived_at, created_at
       FROM repos WHERE repo_id = ?`,
    )
    .get(REQUIRED_FIELDS.repo_id);
  expect(row).not.toBeNull();
  expect(row!.archived_at).toBe(expectedArchivedAt);

  // Foreign key still resolves: the referencing task remains intact.
  const taskRow = h.db
    .query<{ task_id: string; repo_id: string }, [string]>(
      "SELECT task_id, repo_id FROM tasks WHERE task_id = ?",
    )
    .get("task-keep");
  expect(taskRow?.repo_id).toBe(REQUIRED_FIELDS.repo_id);
});

test("test_repo_remove_rejects_active_tasks", () => {
  h = createHarness();
  const repos = createRepoService({ db: h.db, clock: h.clock });

  repos.add({ ...REQUIRED_FIELDS });
  insertTask(h.db, { repoId: REQUIRED_FIELDS.repo_id, taskId: "task-active" });

  let caught: unknown = null;
  try {
    repos.remove(REQUIRED_FIELDS.repo_id);
  } catch (err) {
    caught = err;
  }

  expect(caught).toBeInstanceOf(QuayError);
  expect((caught as QuayError).code).toBe("repo_has_active_tasks");
  expect(repos.get(REQUIRED_FIELDS.repo_id)!.archived_at).toBeNull();
});
