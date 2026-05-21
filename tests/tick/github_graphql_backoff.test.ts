import { afterEach, expect, test } from "bun:test";
import { tick_once } from "../../src/core/tick.ts";
import type { PrSnapshot } from "../../src/ports/github.ts";
import { insertAttempt, insertRepo, insertTask } from "../support/fixtures.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("github graphql rate-limit exhaustion pauses later tick PR polling until reset", async () => {
  h = createHarness();
  h.clock.set("2026-05-21T12:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-graphql-backoff");
  const first = insertTask(h.db, { taskId: "task-rate-limited", repoId, state: "pr-open" });
  const second = insertTask(h.db, { taskId: "task-skipped", repoId, state: "pr-open" });
  insertAttempt(h.db, { taskId: first, spawnedAt: "2026-05-21T11:00:00.000Z" });
  insertAttempt(h.db, { taskId: second, spawnedAt: "2026-05-21T11:00:00.000Z" });

  const built = buildTickDeps(h);
  built.github.setGraphqlRateLimit({
    limit: 5000,
    used: 5000,
    remaining: 0,
    resetAt: "2026-05-21T12:15:00.000Z",
  });

  let snapshotCalls = 0;
  built.github.setPrSnapshotHandler((_repoId, branch) => {
    snapshotCalls += 1;
    if (snapshotCalls === 1) {
      throw new Error(
        `gh pr view ${branch} failed: GraphQL: API rate limit already exceeded for installation ID 129473146.`,
      );
    }
    return openPendingSnapshot(branch);
  });

  const firstTick = await tick_once(built.deps);
  expect(firstTick.map((r) => r.action)).toEqual([
    "tick_error",
    "github_backoff_skipped",
  ]);
  expect(firstTick[0]!.error).toContain(
    "GitHub GraphQL polling paused until 2026-05-21T12:15:30.000Z",
  );
  expect(snapshotCalls).toBe(1);

  const backoff = h.db
    .query<{ pause_until: string; reason: string }, []>(
      `SELECT pause_until, reason FROM github_backoffs WHERE scope = 'graphql'`,
    )
    .get();
  expect(backoff).toEqual({
    pause_until: "2026-05-21T12:15:30.000Z",
    reason: expect.stringContaining("graphql remaining=0, used=5000"),
  });

  h.clock.set("2026-05-21T12:10:00.000Z");
  const pausedTick = await tick_once(built.deps);
  expect(pausedTick.map((r) => r.action)).toEqual([
    "github_backoff_skipped",
    "github_backoff_skipped",
  ]);
  expect(snapshotCalls).toBe(1);

  h.clock.set("2026-05-21T12:16:00.000Z");
  const afterReset = await tick_once(built.deps);
  expect(afterReset).toEqual([
    { task_id: first, action: "ci_pending" },
    { task_id: second, action: "ci_pending" },
  ]);
  expect(snapshotCalls).toBe(3);
});

test("low-priority done tasks honor github_pr_polled_at cadence while pr-open stays active", async () => {
  h = createHarness();
  h.clock.set("2026-05-21T12:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-pr-cadence");
  const prOpen = insertTask(h.db, { taskId: "task-active-pr", repoId, state: "pr-open" });
  const doneRecent = insertTask(h.db, { taskId: "task-done-recent", repoId, state: "done" });
  const doneDue = insertTask(h.db, { taskId: "task-done-due", repoId, state: "done" });
  for (const taskId of [prOpen, doneRecent, doneDue]) {
    insertAttempt(h.db, { taskId, spawnedAt: "2026-05-21T11:00:00.000Z" });
  }
  h.db
    .query(`UPDATE tasks SET github_pr_polled_at = ? WHERE task_id = ?`)
    .run("2026-05-21T11:56:00.000Z", doneRecent);
  h.db
    .query(`UPDATE tasks SET github_pr_polled_at = ? WHERE task_id = ?`)
    .run("2026-05-21T11:54:00.000Z", doneDue);

  const built = buildTickDeps(h);
  built.github.setPrSnapshot(repoId, `quay/${prOpen}`, openPendingSnapshot(`quay/${prOpen}`));
  built.github.setPrSnapshot(repoId, `quay/${doneRecent}`, openPassingSnapshot(`quay/${doneRecent}`));
  built.github.setPrSnapshot(repoId, `quay/${doneDue}`, openPassingSnapshot(`quay/${doneDue}`));

  const results = await tick_once(built.deps);
  expect(results).toEqual([{ task_id: prOpen, action: "ci_pending" }]);
  expect(built.github.snapshotCalls.map((c) => c.branch)).toEqual([
    `quay/${prOpen}`,
    `quay/${doneDue}`,
  ]);
});

test("synthetic review lifecycle polling uses lightweight PR probe", async () => {
  h = createHarness();
  h.clock.set("2026-05-21T12:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-lightweight");
  const taskId = insertTask(h.db, {
    taskId: "pr-review-42",
    repoId,
    state: "waiting_external_changes",
  });
  h.db
    .query(`UPDATE tasks SET pr_number = ? WHERE task_id = ?`)
    .run(42, taskId);
  insertAttempt(h.db, { taskId, spawnedAt: "2026-05-21T11:00:00.000Z" });

  const built = buildTickDeps(h);
  built.github.setPrLightweightSnapshotByNumber(
    repoId,
    42,
    openPassingSnapshot("quay/reviewed"),
  );

  const results = await tick_once(built.deps);
  expect(results).toEqual([]);
  expect(built.github.lightweightSnapshotByNumberCalls).toEqual([
    { repoId, prNumber: 42 },
  ]);
  expect(built.github.snapshotByNumberCalls).toEqual([]);
});

function openPendingSnapshot(branch: string): PrSnapshot {
  return {
    state: "open",
    prNumber: numberFromBranch(branch),
    prUrl: `https://github.example/${branch}`,
    headSha: `head-${branch}`,
    baseSha: "base-sha",
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: `head-${branch}`,
      items: [{ name: "build", workflow: "ci", bucket: "pending", required: true }],
    },
  };
}

function openPassingSnapshot(branch: string): PrSnapshot {
  return {
    ...openPendingSnapshot(branch),
    checks: {
      checkSha: `head-${branch}`,
      items: [{ name: "build", workflow: "ci", bucket: "pass", required: true }],
    },
  };
}

function numberFromBranch(branch: string): number {
  let hash = 0;
  for (let i = 0; i < branch.length; i += 1) {
    hash = (hash * 31 + branch.charCodeAt(i)) % 10_000;
  }
  return hash + 1;
}
