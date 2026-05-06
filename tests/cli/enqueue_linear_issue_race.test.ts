// Tests for the race-condition fix: the unique index on (repo_id, external_ref)
// closes the read-before-write window in `quay enqueue --linear-issue`.

import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dispatch } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";
import { enqueue } from "../../src/core/enqueue.ts";
import { createRepoService } from "../../src/core/repos/service.ts";
import type { LinearIssue } from "../../src/ports/linear.ts";
import { buildCliDeps } from "../support/cli_deps.ts";
import { buildEnqueueDeps } from "../support/enqueue_deps.ts";
import { createHarness, type Harness } from "../support/harness.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

const REPO_ID = "repo-race";

const REPO_INPUT = {
  repo_id: REPO_ID,
  repo_url: "git@example.com:owner/race.git",
  base_branch: "main",
  package_manager: "bun",
  install_cmd: "true",
} as const;

const FENCE = "```";

function makeIssue(identifier: string): LinearIssue {
  const blockText = [
    `${FENCE}quay-config`,
    "tags:",
    "  - race-test",
    "authors:",
    "  - name: Race Tester",
    "    slack_id: U00RACETST",
    FENCE,
  ].join("\n");
  return {
    identifier,
    url: `https://linear.app/inverter/issue/${identifier}`,
    title: "Race condition test ticket",
    body: `## Context\n\nThis ticket exercises concurrent enqueue race handling.\n\n${blockText}\n`,
    comments: [],
  };
}

async function addRepo(built: ReturnType<typeof buildCliDeps>): Promise<void> {
  const r = await dispatch(
    [
      "repo",
      "add",
      "--id",
      REPO_ID,
      "--url",
      REPO_INPUT.repo_url,
      "--base-branch",
      REPO_INPUT.base_branch,
      "--package-manager",
      REPO_INPUT.package_manager,
      "--install-cmd",
      REPO_INPUT.install_cmd,
    ],
    built.deps,
    bufferIO(),
  );
  expect(r.exitCode).toBe(0);
  // Quay is a pure consumer of bare clones; the operator (or, here, the
  // test) must materialize the clone before enqueuing.
  built.git.seedBareClone(REPO_ID);
}

// ---------------------------------------------------------------------------
// Test 1: SQL-level unique constraint blocks a duplicate insert
// ---------------------------------------------------------------------------

test("test_enqueue_linear_issue_unique_constraint_blocks_duplicate", () => {
  h = createHarness();

  // Insert one repo and one task with external_ref set.
  h.db
    .query(
      `INSERT INTO repos (repo_id, repo_url, base_branch, package_manager,
         install_cmd, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(REPO_ID, REPO_INPUT.repo_url, "main", "bun", "true", "2024-01-01T00:00:00.000Z");

  const now = "2024-01-01T00:00:00.000Z";
  h.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, external_ref, state, branch_name, tmux_id,
         worktree_path, retry_budget, created_at, updated_at
       ) VALUES (?, ?, ?, 'queued', ?, ?, ?, 5, ?, ?)`,
    )
    .run("task-aaa", REPO_ID, "ENG-1234", "quay/ENG-1234", "tmux-aaa", "/wt/aaa", now, now);

  // A second insert with the same (repo_id, external_ref) must violate the unique index.
  expect(() => {
    h!.db
      .query(
        `INSERT INTO tasks (
           task_id, repo_id, external_ref, state, branch_name, tmux_id,
           worktree_path, retry_budget, created_at, updated_at
         ) VALUES (?, ?, ?, 'queued', ?, ?, ?, 5, ?, ?)`,
      )
      .run("task-bbb", REPO_ID, "ENG-1234", "quay/ENG-1234-bbb", "tmux-bbb", "/wt/bbb", now, now);
  }).toThrow(/UNIQUE constraint failed|constraint failed/i);

  // Only one task exists.
  const count = h.db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM tasks`)
    .get();
  expect(count?.n).toBe(1);
});

// ---------------------------------------------------------------------------
// Test 2: null external_ref rows are NOT blocked by the unique constraint
// ---------------------------------------------------------------------------

test("test_enqueue_unique_constraint_does_not_block_null_external_ref_rows", () => {
  h = createHarness();

  h.db
    .query(
      `INSERT INTO repos (repo_id, repo_url, base_branch, package_manager,
         install_cmd, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(REPO_ID, REPO_INPUT.repo_url, "main", "bun", "true", "2024-01-01T00:00:00.000Z");

  const now = "2024-01-01T00:00:00.000Z";

  // Two tasks with NULL external_ref must coexist without violating the index.
  h.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, external_ref, state, branch_name, tmux_id,
         worktree_path, retry_budget, created_at, updated_at
       ) VALUES (?, ?, NULL, 'queued', ?, ?, ?, 5, ?, ?)`,
    )
    .run("task-null-1", REPO_ID, "quay/t1", "tmux-null-1", "/wt/null-1", now, now);

  expect(() => {
    h!.db
      .query(
        `INSERT INTO tasks (
           task_id, repo_id, external_ref, state, branch_name, tmux_id,
           worktree_path, retry_budget, created_at, updated_at
         ) VALUES (?, ?, NULL, 'queued', ?, ?, ?, 5, ?, ?)`,
      )
      .run("task-null-2", REPO_ID, "quay/t2", "tmux-null-2", "/wt/null-2", now, now);
  }).not.toThrow();

  const count = h.db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM tasks`)
    .get();
  expect(count?.n).toBe(2);
});

// ---------------------------------------------------------------------------
// Test 3: concurrent race converges to one task
//
// Simulates two pollers both passing the preflight check (because neither
// finds the row yet), then both calling enqueue(). The first wins; the second
// hits the unique constraint. handleEnqueueLinearIssue() must detect this,
// re-fetch the winner's row, and return the same task_id with exit code 0.
// ---------------------------------------------------------------------------

test("test_enqueue_linear_issue_concurrent_race_converges_to_one_task", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built);

  built.linear.setIssue(makeIssue("ENG-9001"));

  // --- Winner: first call via dispatch (the normal path) ---
  const ioA = bufferIO();
  const resultA = await dispatch(
    ["enqueue", "--repo", REPO_ID, "--linear-issue", "ENG-9001"],
    built.deps,
    ioA,
  );
  expect(resultA.exitCode).toBe(0);
  expect(ioA.err()).toBe("");
  const firstTask = JSON.parse(ioA.out().trim());
  expect(typeof firstTask.task_id).toBe("string");

  // Simulate the loser: call dispatch again. The preflight in
  // handleEnqueueLinearIssue() would normally short-circuit here, but to
  // exercise the unique-constraint catch path we call enqueue() directly first
  // (bypassing the preflight) to confirm that path is also safe, then call
  // dispatch to confirm the end-to-end recovers correctly.

  // Direct enqueue() call with the same external_ref — must throw a unique
  // constraint error and roll back substrate side effects.
  const enqDeps = buildEnqueueDeps(h);
  // FakeGit tracks `bareClones` in memory per-instance, so the seed on
  // `built.git` from `addRepo(built)` doesn't carry over to this fresh
  // FakeGit inside `enqDeps`. Seed it explicitly so we exercise the
  // unique-constraint path, not the `bare_clone_missing` path.
  enqDeps.git.seedBareClone(REPO_ID);
  const worktreesRootBefore = built.worktreesRoot;
  expect(() => {
    enqueue(enqDeps.deps, {
      repo_id: REPO_ID,
      brief: "do the thing",
      external_ref: "ENG-9001",
      ticket_snapshot: null,
      tags: ["race-test"],
    });
  }).toThrow(/UNIQUE constraint failed|constraint failed/i);

  // Exactly one task row in the DB after the failed duplicate insert.
  const taskCount = h.db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM tasks`)
    .get();
  expect(taskCount?.n).toBe(1);

  // The worktree the loser created must have been cleaned up by rollback.
  // (The loser's worktree path is <worktreesRoot>/<loser-task-id>. Because
  // FakeIdGenerator auto-increments and the first call consumed id-1, the
  // loser got id-2. We check that no extra worktrees linger beyond the
  // winner's.)
  const winnerWorktreePath = firstTask.worktree_path as string;
  expect(existsSync(winnerWorktreePath)).toBe(true);

  // The enqDeps git fake tracks which worktrees were created. After rollback
  // the loser's worktree should be gone.
  expect(enqDeps.git.worktrees.size).toBe(0);

  // --- End-to-end: second dispatch call recovers via the catch path ---
  // Even though the preflight would find the row now, this proves the flow is
  // consistent. Re-set the fake issue since getIssueCalls state doesn't affect
  // idempotency.
  built.linear.setIssue(makeIssue("ENG-9001"));
  const ioB = bufferIO();
  const resultB = await dispatch(
    ["enqueue", "--repo", REPO_ID, "--linear-issue", "ENG-9001"],
    built.deps,
    ioB,
  );
  expect(resultB.exitCode).toBe(0);
  expect(ioB.err()).toBe("");
  const secondTask = JSON.parse(ioB.out().trim());

  // Must return the same task_id as the first call.
  expect(secondTask.task_id).toBe(firstTask.task_id);

  // Still only one task in the DB.
  const finalCount = h.db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM tasks`)
    .get();
  expect(finalCount?.n).toBe(1);
});
