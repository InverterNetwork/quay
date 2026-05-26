import { existsSync, mkdirSync } from "node:fs";
import { afterEach, expect, test } from "bun:test";
import {
  REVIEWER_GH_TOKEN_ENV,
  tick_once,
  type TickOptions,
} from "../../src/core/tick.ts";
import { enterReview, syntheticTaskId } from "../../src/core/pr_review.ts";
import type { PrSnapshot } from "../../src/ports/github.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo } from "../support/fixtures.ts";
import { buildTickDeps, type BuiltTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

const REVIEWER_ENV: NodeJS.ProcessEnv = {
  GH_TOKEN: "ghs_worker_runtime_test",
  [REVIEWER_GH_TOKEN_ENV]: "ghs_reviewer_runtime_test",
};

function reviewerTickOptions(extra: TickOptions = {}): TickOptions {
  return { reviewerEnabled: true, env: REVIEWER_ENV, ...extra };
}

test("approved synthetic review keeps tracking and schedules one review for a new PR head", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-synth-approved-new-head");
  const seeded = seedSyntheticReviewTask(repoId, 130, {
    state: "done",
    headSha: "old-head",
    verdict: "approved",
  });
  setOpenPr(built, repoId, 130, "new-head");

  const results = await tick_once(built.deps, reviewerTickOptions());

  expect(results).toEqual([{ task_id: seeded.taskId, action: "review_requested" }]);
  expect(taskState(seeded.taskId)).toEqual({
    state: "pr-review",
    head_sha: "new-head",
  });
  expect(reviewAttemptCount(seeded.taskId, "new-head")).toBe(1);

  const second = await tick_once(built.deps, reviewerTickOptions());

  expect(second).toEqual([{ task_id: seeded.taskId, action: "spawned" }]);
  expect(reviewAttemptCount(seeded.taskId, "new-head")).toBe(1);
});

test("changes-requested synthetic review waits for an external commit and never spawns a worker", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-synth-changes-new-head");
  const seeded = seedSyntheticReviewTask(repoId, 131, {
    state: "waiting_external_changes",
    headSha: "needs-work",
    verdict: "changes_requested",
  });
  setOpenPr(built, repoId, 131, "fixed-head");

  const results = await tick_once(built.deps, reviewerTickOptions());

  expect(results).toEqual([{ task_id: seeded.taskId, action: "review_requested" }]);
  expect(taskState(seeded.taskId)).toEqual({
    state: "pr-review",
    head_sha: "fixed-head",
  });
  expect(reviewAttemptCount(seeded.taskId, "fixed-head")).toBe(1);
  expect(nonReviewAttemptCount(seeded.taskId)).toBe(0);
});

test("same-head synthetic terminal review is a tick no-op", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-synth-same-head");
  const seeded = seedSyntheticReviewTask(repoId, 132, {
    state: "done",
    headSha: "same-head",
    verdict: "approved",
  });
  setOpenPr(built, repoId, 132, "same-head");

  const results = await tick_once(built.deps, reviewerTickOptions());

  expect(results).toEqual([]);
  expect(taskState(seeded.taskId)).toEqual({
    state: "done",
    head_sha: "same-head",
  });
  expect(reviewAttemptCount(seeded.taskId, "same-head")).toBe(1);
});

test("active synthetic review is superseded when tick observes a new PR head", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-synth-active-new-head");
  const seeded = seedSyntheticReviewTask(repoId, 133, {
    state: "pr-review",
    headSha: "stale-head",
    active: true,
  });
  built.tmux.liveSessions.add(seeded.sessionName!);
  setOpenPr(built, repoId, 133, "fresh-head");

  const results = await tick_once(built.deps, reviewerTickOptions());

  expect(results).toEqual([{ task_id: seeded.taskId, action: "review_requested" }]);
  const stale = h.db
    .query<
      { ended_at: string | null; review_verdict: string | null; kill_intent: string | null },
      [number]
    >(
      `SELECT ended_at, review_verdict, kill_intent
         FROM attempts
        WHERE attempt_id = ?`,
    )
    .get(seeded.attemptId);
  expect(stale?.ended_at).not.toBeNull();
  expect(stale?.review_verdict).toBe("superseded");
  expect(stale?.kill_intent).toBe("superseded");
  expect(built.tmux.killCalls).toContain(seeded.sessionName!);
  expect(reviewAttemptCount(seeded.taskId, "fresh-head")).toBe(1);
});

test("completed synthetic review task transitions terminal by PR number", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-synth-closed");
  const seeded = seedSyntheticReviewTask(repoId, 134, {
    state: "waiting_external_changes",
    headSha: "closed-head",
    verdict: "changes_requested",
  });
  built.git.setLocalBranches(repoId, [seeded.branchName]);
  built.git.setRemoteBranches(repoId, [seeded.branchName]);
  built.github.setPrSnapshotByNumber(
    repoId,
    134,
    snapshot("closed_unmerged", 134, "closed-head"),
  );

  const results = await tick_once(built.deps, reviewerTickOptions());

  expect(results).toEqual([
    { task_id: seeded.taskId, action: "pr_closed_unmerged" },
  ]);
  expect(taskState(seeded.taskId).state).toBe("closed_unmerged");
  expect(existsSync(seeded.worktreePath)).toBe(false);
  expect(built.git.localBranches.get(repoId)?.has(seeded.branchName)).toBe(false);
  expect(built.git.remoteBranches.get(repoId)?.has(seeded.branchName)).toBe(false);
});

test("pending synthetic review request is scheduled by tick after CI turns green", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-synth-pending-queue");
  setOpenPr(built, repoId, 135, "queue-head");
  built.github.setPrSnapshotByNumber(
    repoId,
    135,
    snapshot("open", 135, "queue-head", [
      { name: "build", workflow: null, bucket: "pending", required: true },
    ]),
  );

  const queued = enterReview(
    {
      db: built.deps.db,
      clock: built.deps.clock,
      github: built.deps.github,
      artifactStore: built.deps.artifactStore,
      tmux: built.deps.tmux,
      paths: { worktreesRoot: h.dataDir + "/worktrees" },
    },
    {
      repoId,
      prNumber: 135,
      reviewerEnabled: true,
      gateQuayOwnedDone: true,
    },
  );
  expect(queued.pending_ci).toBe(true);

  built.github.setPrSnapshotByNumber(
    repoId,
    135,
    snapshot("open", 135, "queue-head"),
  );
  const results = await tick_once(built.deps, reviewerTickOptions());
  expect(results).toContainEqual({ task_id: queued.task_id, action: "review_requested" });
  expect(reviewAttemptCount(queued.task_id, "queue-head")).toBe(1);
});

function seedSyntheticReviewTask(
  repoId: string,
  prNumber: number,
  opts: {
    state: "pr-review" | "done" | "waiting_external_changes";
    headSha: string;
    verdict?: "approved" | "changes_requested";
    active?: boolean;
  },
): {
  taskId: string;
  branchName: string;
  worktreePath: string;
  attemptId: number;
  sessionName: string | null;
} {
  if (!h) throw new Error("missing harness");
  const taskId = syntheticTaskId(repoId, prNumber);
  const branchName = `quay-review/${prNumber}`;
  const worktreePath = `${h.dataDir}/worktrees/synth-${prNumber}`;
  const tmuxId = `synth-${prNumber}`;
  mkdirSync(worktreePath, { recursive: true });
  h.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, state, branch_name, tmux_id, worktree_path,
         pr_number, head_sha, retry_budget, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      taskId,
      repoId,
      opts.state,
      branchName,
      tmuxId,
      worktreePath,
      prNumber,
      opts.headSha,
      h.clock.nowISO(),
      h.clock.nowISO(),
    );
  const attemptId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: h.clock.nowISO(),
  });
  const sessionName = opts.active ? `quay-review-${tmuxId}-1` : null;
  if (opts.active) {
    h.db
      .query(
        `UPDATE attempts
            SET head_sha = ?, tmux_session = ?
          WHERE attempt_id = ?`,
      )
      .run(opts.headSha, sessionName, attemptId);
  } else {
    const verdict = opts.verdict ?? "approved";
    h.db
      .query(
        `UPDATE attempts
            SET head_sha = ?,
                ended_at = ?,
                exit_kind = ?,
                review_verdict = ?,
                review_id = ?
          WHERE attempt_id = ?`,
      )
      .run(
        opts.headSha,
        h.clock.nowISO(),
        verdict === "approved" ? "review_approved" : "review_changes_requested",
        verdict,
        verdict === "approved" ? "R_approved_old" : "R_changes_old",
        attemptId,
      );
  }
  return { taskId, branchName, worktreePath, attemptId, sessionName };
}

function setOpenPr(
  built: BuiltTickDeps,
  repoId: string,
  prNumber: number,
  headSha: string,
): void {
  built.github.setPrSnapshotByNumber(
    repoId,
    prNumber,
    snapshot("open", prNumber, headSha),
  );
  built.github.setPrView(repoId, prNumber, {
    number: prNumber,
    title: "Synthetic lifecycle PR",
    body: "Review me",
    url: `https://example.test/${repoId}/pull/${prNumber}`,
    headRefName: `feature/${prNumber}`,
    headSha,
  });
}

function snapshot(
  state: PrSnapshot["state"],
  prNumber: number,
  headSha: string,
  items: PrSnapshot["checks"]["items"] = [
    { name: "build", workflow: null, bucket: "pass", required: true },
  ],
): PrSnapshot {
  return {
    prNumber,
    prUrl: `https://example.test/pull/${prNumber}`,
    state,
    headSha,
    baseSha: `base-${prNumber}`,
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: headSha,
      items,
    },
  };
}

function taskState(taskId: string): { state: string; head_sha: string | null } {
  if (!h) throw new Error("missing harness");
  const row = h.db
    .query<{ state: string; head_sha: string | null }, [string]>(
      `SELECT state, head_sha FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  if (!row) throw new Error(`missing task ${taskId}`);
  return row;
}

function reviewAttemptCount(taskId: string, headSha: string): number {
  if (!h) throw new Error("missing harness");
  return h.db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n
         FROM attempts
        WHERE task_id = ?
          AND reason = 'review_only'
          AND head_sha = ?`,
    )
    .get(taskId, headSha)!.n;
}

function nonReviewAttemptCount(taskId: string): number {
  if (!h) throw new Error("missing harness");
  return h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n
         FROM attempts
        WHERE task_id = ?
          AND reason <> 'review_only'`,
    )
    .get(taskId)!.n;
}
