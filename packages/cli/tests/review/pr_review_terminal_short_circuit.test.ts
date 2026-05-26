// A `pr-review` task whose PR has become terminal externally (human merged
// or closed the PR while the reviewer was running) must short-circuit to
// `merged` / `closed_unmerged` instead of iterating review attempts and
// respawning panes on the already-terminal PR. Mirrors the precedent in
// processPrOpenTask / processDoneTask: poll prSnapshot once per task tick
// before touching review attempts.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tick_once } from "../../src/core/tick.ts";
import { syntheticTaskId } from "../../src/core/pr_review.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("pr-review task with externally-merged PR transitions to merged and reaps reviewer pane", async () => {
  h = createHarness();
  h.clock.set("2026-05-13T08:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-review-merged");
  const taskId = "task-review-merged";
  const worktreePath = `${h.dataDir}/worktrees/review-merged`;
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(
    `${worktreePath}/.quay-usage.json`,
    JSON.stringify({ model: "claude-test", usage: { input_tokens: 13 } }),
  );
  writeFileSync(
    `${worktreePath}/.quay-tool-trace.log`,
    "terminal reviewer trace\n",
  );
  h.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, state, branch_name, tmux_id, worktree_path,
         pr_number, head_sha, retry_budget, created_at, updated_at
       ) VALUES (?, ?, 'pr-review', ?, ?, ?, 6, 'sha-6', 1, ?, ?)`,
    )
    .run(
      taskId,
      repoId,
      `quay/${taskId}`,
      `quay-task-${taskId}`,
      worktreePath,
      h.clock.nowISO(),
      h.clock.nowISO(),
    );
  const attemptId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: h.clock.nowISO(),
  });
  const sessionName = "quay-review-merged-1";
  h.db
    .query(
      `UPDATE attempts
          SET head_sha = 'sha-6', tmux_session = ?
        WHERE attempt_id = ?`,
    )
    .run(sessionName, attemptId);

  const built = buildTickDeps(h);
  built.tmux.liveSessions.add(sessionName);
  built.git.setLocalBranches(repoId, [`quay/${taskId}`]);
  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    prNumber: 6,
    state: "merged",
    headSha: "sha-6",
    baseSha: "base-6",
    mergeable: "unknown",
    latestReview: { decision: "APPROVED", latestReviewId: "R_x", comments: "" },
    checks: {
      checkSha: "sha-6",
      items: [{ name: "build", workflow: null, bucket: "pass", required: true }],
    },
  });

  const results = await tick_once(built.deps, { reviewerEnabled: true });

  expect(results).toEqual([{ task_id: taskId, action: "pr_merged" }]);

  const task = h.db
    .query<{ state: string }, [string]>(
      `SELECT state FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task?.state).toBe("merged");

  // Reviewer attempt ended + superseded; its tmux session killed.
  const attempt = h.db
    .query<
      {
        ended_at: string | null;
        review_verdict: string | null;
        kill_intent: string | null;
      },
      [number]
    >(
      `SELECT ended_at, review_verdict, kill_intent FROM attempts WHERE attempt_id = ?`,
    )
    .get(attemptId);
  expect(attempt?.ended_at).not.toBeNull();
  expect(attempt?.review_verdict).toBe("superseded");
  expect(attempt?.kill_intent).toBe("superseded");
  expect(built.tmux.killCalls).toContain(sessionName);
  expect(built.tmux.liveSessions.has(sessionName)).toBe(false);

  // No new reviewer spawn this tick.
  expect(built.tmux.spawnCalls).toHaveLength(0);

  // Worktree + local branch cleaned up; remote left to GitHub on merge.
  expect(existsSync(worktreePath)).toBe(false);
  expect(built.git.localBranches.get(repoId)?.has(`quay/${taskId}`)).toBeFalsy();

  // Usage + tool trace are captured before terminal cleanup removes the
  // reviewer worktree.
  const observabilityArtifacts = h.db
    .query<{ kind: string; n: number }, [string, number]>(
      `SELECT kind, COUNT(*) AS n FROM artifacts
        WHERE task_id = ? AND attempt_id = ?
          AND kind IN ('usage', 'tool_trace')
        GROUP BY kind
        ORDER BY kind`,
    )
    .all(taskId, attemptId);
  expect(observabilityArtifacts).toEqual([
    { kind: "tool_trace", n: 1 },
    { kind: "usage", n: 1 },
  ]);

  // Event recorded with from_state = pr-review.
  const evt = h.db
    .query<
      { event_type: string; from_state: string; to_state: string },
      [string]
    >(
      `SELECT event_type, from_state, to_state FROM events
        WHERE task_id = ? AND event_type = 'merged'`,
    )
    .get(taskId);
  expect(evt).toEqual({
    event_type: "merged",
    from_state: "pr-review",
    to_state: "merged",
  });
});

test("pr-review task with externally-closed PR transitions to closed_unmerged and deletes remote branch", async () => {
  h = createHarness();
  h.clock.set("2026-05-13T08:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-review-closed");
  const taskId = "task-review-closed";
  const worktreePath = `${h.dataDir}/worktrees/review-closed`;
  mkdirSync(worktreePath, { recursive: true });
  h.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, state, branch_name, tmux_id, worktree_path,
         pr_number, head_sha, retry_budget, created_at, updated_at
       ) VALUES (?, ?, 'pr-review', ?, ?, ?, 7, 'sha-7', 1, ?, ?)`,
    )
    .run(
      taskId,
      repoId,
      `quay/${taskId}`,
      `quay-task-${taskId}`,
      worktreePath,
      h.clock.nowISO(),
      h.clock.nowISO(),
    );
  const attemptId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: h.clock.nowISO(),
  });
  const sessionName = "quay-review-closed-1";
  h.db
    .query(
      `UPDATE attempts
          SET head_sha = 'sha-7', tmux_session = ?
        WHERE attempt_id = ?`,
    )
    .run(sessionName, attemptId);

  const built = buildTickDeps(h);
  built.tmux.liveSessions.add(sessionName);
  built.git.setLocalBranches(repoId, [`quay/${taskId}`]);
  built.git.setRemoteBranches(repoId, [`quay/${taskId}`]);
  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    prNumber: 7,
    state: "closed_unmerged",
    headSha: "sha-7",
    baseSha: "base-7",
    mergeable: "unknown",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "sha-7",
      items: [{ name: "build", workflow: null, bucket: "pass", required: true }],
    },
  });

  const results = await tick_once(built.deps, { reviewerEnabled: true });

  expect(results).toEqual([{ task_id: taskId, action: "pr_closed_unmerged" }]);

  const task = h.db
    .query<{ state: string }, [string]>(
      `SELECT state FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task?.state).toBe("closed_unmerged");

  // Remote branch deleted on closed_unmerged (human discarded the work).
  expect(built.git.localBranches.get(repoId)?.has(`quay/${taskId}`)).toBeFalsy();
  expect(built.git.remoteBranches.get(repoId)?.has(`quay/${taskId}`)).toBeFalsy();
  expect(built.tmux.killCalls).toContain(sessionName);
});

test("adopted pr-review task closed_unmerged preserves human-owned remote branch", async () => {
  h = createHarness();
  h.clock.set("2026-05-13T08:15:00.000Z");

  const repoId = insertRepo(h.db, "repo-review-adopted-closed");
  const taskId = "pr-review-repo-review-adopted-closed-7";
  const branchName = "feature/human-owned";
  const worktreePath = `${h.dataDir}/worktrees/review-adopted-closed`;
  mkdirSync(worktreePath, { recursive: true });
  h.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, state, authoring_mode, branch_name, tmux_id,
         worktree_path, pr_number, head_sha, retry_budget, created_at, updated_at
       ) VALUES (?, ?, 'pr-review', 'adopted_external_pr', ?, ?, ?, 71, 'sha-71', 1, ?, ?)`,
    )
    .run(
      taskId,
      repoId,
      branchName,
      "quay-review-adopted-closed-71",
      worktreePath,
      h.clock.nowISO(),
      h.clock.nowISO(),
    );
  const attemptId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: h.clock.nowISO(),
  });
  h.db
    .query(
      `UPDATE attempts
          SET head_sha = 'sha-71', tmux_session = 'quay-review-adopted-closed'
        WHERE attempt_id = ?`,
    )
    .run(attemptId);

  const built = buildTickDeps(h);
  built.git.setLocalBranches(repoId, [branchName]);
  built.git.setRemoteBranches(repoId, [branchName]);
  built.github.setPrLightweightSnapshotByNumber(repoId, 71, {
    prNumber: 71,
    state: "closed_unmerged",
    headSha: "sha-71",
    baseSha: "base-71",
    mergeable: "unknown",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "sha-71",
      items: [{ name: "build", workflow: null, bucket: "pass", required: true }],
    },
  });

  const results = await tick_once(built.deps, { reviewerEnabled: true });

  expect(results).toEqual([{ task_id: taskId, action: "pr_closed_unmerged" }]);
  expect(built.git.localBranches.get(repoId)?.has(branchName)).toBeFalsy();
  expect(built.git.remoteBranches.get(repoId)?.has(branchName)).toBe(true);
});

test("synthetic pr-review task probes by pr_number and short-circuits on external merge", async () => {
  // Synthetic review tasks store `branch_name = quay-review/<num>`, an
  // internal placeholder that has no GitHub ref. A branch-keyed prSnapshot
  // returns null in that case (the real adapter's `gh pr view quay-review/8`
  // would fall through to "no pull requests found"), so the short-circuit
  // must dispatch to `prSnapshotByNumber`.
  h = createHarness();
  h.clock.set("2026-05-13T08:30:00.000Z");

  const repoId = insertRepo(h.db, "repo-synthetic-merged");
  const prNumber = 42;
  const taskId = syntheticTaskId(repoId, prNumber);
  const branchName = `quay-review/${prNumber}`;
  const worktreePath = `${h.dataDir}/worktrees/synthetic-merged`;
  mkdirSync(worktreePath, { recursive: true });
  h.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, state, branch_name, tmux_id, worktree_path,
         pr_number, head_sha, retry_budget, created_at, updated_at
       ) VALUES (?, ?, 'pr-review', ?, ?, ?, ?, 'sha-42', 1, ?, ?)`,
    )
    .run(
      taskId,
      repoId,
      branchName,
      `synthetic-${prNumber}`,
      worktreePath,
      prNumber,
      h.clock.nowISO(),
      h.clock.nowISO(),
    );
  const attemptId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: h.clock.nowISO(),
  });
  const sessionName = "quay-review-synthetic-42-1";
  h.db
    .query(
      `UPDATE attempts
          SET head_sha = 'sha-42', tmux_session = ?
        WHERE attempt_id = ?`,
    )
    .run(sessionName, attemptId);

  const built = buildTickDeps(h);
  built.tmux.liveSessions.add(sessionName);
  // Deliberately do NOT seed setPrSnapshot for branch — branch-keyed lookup
  // must miss; only the by-number lookup should surface terminal state.
  built.github.setPrSnapshotByNumber(repoId, prNumber, {
    prNumber,
    state: "merged",
    headSha: "sha-42",
    baseSha: "base-42",
    mergeable: "unknown",
    latestReview: { decision: "APPROVED", latestReviewId: "R_synth", comments: "" },
    checks: {
      checkSha: "sha-42",
      items: [{ name: "build", workflow: null, bucket: "pass", required: true }],
    },
  });

  const results = await tick_once(built.deps, { reviewerEnabled: true });

  expect(results).toEqual([{ task_id: taskId, action: "pr_merged" }]);

  const task = h.db
    .query<{ state: string }, [string]>(
      `SELECT state FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task?.state).toBe("merged");

  const attempt = h.db
    .query<{ review_verdict: string | null }, [number]>(
      `SELECT review_verdict FROM attempts WHERE attempt_id = ?`,
    )
    .get(attemptId);
  expect(attempt?.review_verdict).toBe("superseded");
  expect(built.tmux.killCalls).toContain(sessionName);
  expect(existsSync(worktreePath)).toBe(false);
});
