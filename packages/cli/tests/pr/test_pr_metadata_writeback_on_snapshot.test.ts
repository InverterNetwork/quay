// A successful PR snapshot during pr-open / done polling must persist
// `pr_number`, `pr_url`, `pr_title`, `head_sha`, and `base_sha` onto the task row so the
// operator-visible task carries the PR linkage. Previously the adapter scrape
// errored out (Unknown JSON field "baseRefOid" on gh 2.45.0) before any field
// could be written; this test pins the fixed behavior — even though it
// doesn't exercise the gh CLI directly, it verifies tick consumes the
// snapshot fields and writes them to the row.
import { afterEach, expect, test } from "bun:test";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo, insertTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

interface TaskRow {
  pr_number: number | null;
  pr_url: string | null;
  pr_title: string | null;
  head_sha: string | null;
  base_sha: string | null;
  base_branch: string | null;
}

function readTaskMetadata(taskId: string): TaskRow {
  return h!.db
    .query<TaskRow, [string]>(
      `SELECT pr_number, pr_url, pr_title, head_sha, base_sha, base_branch
         FROM tasks WHERE task_id = ?`,
    )
    .get(taskId)!;
}

test("pr-open snapshot populates PR metadata on the task row", async () => {
  h = createHarness();
  h.clock.set("2026-05-11T10:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-pr-meta");
  const taskId = insertTask(h.db, {
    taskId: "task-pr-meta",
    repoId,
    state: "pr-open",
  });
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-05-11T09:00:00.000Z",
  });

  const built = buildTickDeps(h);
  // Snapshot is OPEN with mergeable + a pending check, so tick stays in
  // pr-open after the writeback. The metadata fields are what we're pinning.
  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    state: "open",
    headSha: "head-aabbccdd",
    baseSha: "base-eeff0011",
    prNumber: 42,
    prUrl: "https://github.com/example/repo/pull/42",
    prTitle: "Fix checkout flow",
    baseRef: "main",
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "head-aabbccdd",
      items: [
        { name: "build", workflow: null, bucket: "pending", required: true },
      ],
    },
  });

  await tick_once(built.deps);

  const row = readTaskMetadata(taskId);
  expect(row.pr_number).toBe(42);
  expect(row.pr_url).toBe("https://github.com/example/repo/pull/42");
  expect(row.pr_title).toBe("Fix checkout flow");
  expect(row.head_sha).toBe("head-aabbccdd");
  expect(row.base_sha).toBe("base-eeff0011");
  expect(row.base_branch).toBe("main");
});

test("pr-open snapshot records a human-updated GitHub PR base branch on the task row", async () => {
  h = createHarness();
  h.clock.set("2026-05-11T10:02:00.000Z");

  const repoId = insertRepo(h.db, "repo-pr-base-override");
  const taskId = insertTask(h.db, {
    taskId: "task-pr-base-override",
    repoId,
    state: "pr-open",
  });
  h.db.query(`UPDATE tasks SET base_branch = 'main' WHERE task_id = ?`).run(taskId);
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-05-11T09:00:00.000Z",
  });

  const built = buildTickDeps(h);
  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    state: "open",
    headSha: "head-retargeted",
    baseSha: "base-dev",
    prNumber: 43,
    prUrl: "https://github.com/example/repo/pull/43",
    baseRef: "dev",
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "head-retargeted",
      items: [
        { name: "build", workflow: null, bucket: "pending", required: true },
      ],
    },
  });

  await tick_once(built.deps);

  const row = readTaskMetadata(taskId);
  expect(row.pr_number).toBe(43);
  expect(row.base_sha).toBe("base-dev");
  expect(row.base_branch).toBe("dev");
});

test("a snapshot with missing prNumber/prUrl does not nullify previously captured values", async () => {
  h = createHarness();
  h.clock.set("2026-05-11T10:01:00.000Z");

  const repoId = insertRepo(h.db, "repo-pr-meta-coalesce");
  const taskId = insertTask(h.db, {
    taskId: "task-pr-meta-coalesce",
    repoId,
    state: "pr-open",
  });
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-05-11T09:00:00.000Z",
  });
  // Pre-seed values as if a prior tick captured them.
  h.db
    .query(
      `UPDATE tasks SET pr_number = 7, pr_url = 'https://github.com/example/repo/pull/7'
        WHERE task_id = ?`,
    )
    .run(taskId);

  const built = buildTickDeps(h);
  // This snapshot omits prNumber / prUrl entirely (older gh version, or a
  // partial-failure mode). The COALESCE writeback must keep the prior values.
  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    state: "open",
    headSha: "head-newer",
    baseSha: null,
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "head-newer",
      items: [
        { name: "build", workflow: null, bucket: "pending", required: true },
      ],
    },
  });

  await tick_once(built.deps);

  const row = readTaskMetadata(taskId);
  expect(row.pr_number).toBe(7);
  expect(row.pr_url).toBe("https://github.com/example/repo/pull/7");
  expect(row.head_sha).toBe("head-newer");
  // base_sha was null in the snapshot — column stays null (no prior value).
  expect(row.base_sha).toBeNull();
});
