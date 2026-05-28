import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tick_once } from "../../src/core/tick.ts";
import {
  enqueueOrchestratorHandoff,
  type OrchestratorHandoffReason,
} from "../../src/core/orchestrator_handoffs.ts";
import type { PrSnapshot, PrTerminalState } from "../../src/ports/github.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo, insertTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("awaiting-next-brief task with externally merged PR transitions terminal and cancels handoff", async () => {
  h = createHarness();
  h.clock.set("2026-05-15T08:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-parked-awaiting-merged");
  const taskId = insertTask(h.db, {
    taskId: "task-parked-awaiting-merged",
    repoId,
    state: "awaiting-next-brief",
  });
  const branchName = `quay/${taskId}`;
  const worktreePath = setWorktreePath(taskId, "awaiting-merged");
  h.db
    .query(`UPDATE tasks SET pr_number = 90 WHERE task_id = ?`)
    .run(taskId);
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-05-15T07:00:00.000Z",
  });
  const eventId = insertEvent(
    taskId,
    "budget_exhausted",
    "running",
    "awaiting-next-brief",
  );
  enqueueHandoff(taskId, "budget_exhausted", eventId);

  const built = buildTickDeps(h);
  built.git.setLocalBranches(repoId, [branchName]);
  built.git.setRemoteBranches(repoId, [branchName]);
  built.git.setWorktreeBranch(repoId, worktreePath, branchName);
  built.github.setPrSnapshotByNumber(
    repoId,
    90,
    terminalSnapshot("merged", 90),
  );

  const results = await tick_once(built.deps);

  expect(results).toEqual([{ task_id: taskId, action: "pr_merged" }]);
  expect(taskState(taskId)).toMatchObject({
    state: "merged",
    claim_id: null,
    claimed_at: null,
    attempts_consumed: 0,
  });
  expect(handoffStatus(taskId)).toBe("cancelled");
  expect(existsSync(worktreePath)).toBe(false);
  expect(built.git.localBranches.get(repoId)?.has(branchName)).toBe(false);
  expect(built.git.remoteBranches.get(repoId)?.has(branchName)).toBe(true);
  expect(terminalEvent(taskId, "merged")).toEqual({
    from_state: "awaiting-next-brief",
    to_state: "merged",
  });
});

test("waiting_human task with externally merged PR clears claim and cancels handoff", async () => {
  h = createHarness();
  h.clock.set("2026-05-15T08:30:00.000Z");

  const repoId = insertRepo(h.db, "repo-parked-waiting-merged");
  const taskId = insertTask(h.db, {
    taskId: "task-parked-waiting-merged",
    repoId,
    state: "waiting_human",
  });
  const branchName = `quay/${taskId}`;
  const worktreePath = setWorktreePath(taskId, "waiting-merged");
  h.db
    .query(
      `UPDATE tasks
          SET claim_id = 'claim-parked',
              claimed_at = ?,
              slack_thread_ref = 'C123:1.000000'
        WHERE task_id = ?`,
    )
    .run(h.clock.nowISO(), taskId);
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-05-15T07:30:00.000Z",
  });
  const eventId = insertEvent(
    taskId,
    "blocker_ingested",
    "running",
    "awaiting-next-brief",
  );
  enqueueHandoff(taskId, "worker_blocker", eventId);
  h.db
    .query(
      `UPDATE orchestrator_handoffs
          SET status = 'claimed',
              claim_id = 'claim-parked',
              claimed_at = ?
        WHERE task_id = ?`,
    )
    .run(h.clock.nowISO(), taskId);

  const built = buildTickDeps(h);
  built.git.setLocalBranches(repoId, [branchName]);
  built.git.setRemoteBranches(repoId, [branchName]);
  built.git.setWorktreeBranch(repoId, worktreePath, branchName);
  built.github.setPrSnapshot(repoId, branchName, terminalSnapshot("merged", 91));

  const results = await tick_once(built.deps);

  expect(results).toEqual([{ task_id: taskId, action: "pr_merged" }]);
  expect(taskState(taskId)).toMatchObject({
    state: "merged",
    claim_id: null,
    claimed_at: null,
  });
  expect(handoffStatus(taskId)).toBe("cancelled");
  expect(built.slack.totalCalls()).toBe(0);
  expect(existsSync(worktreePath)).toBe(false);
  expect(terminalEvent(taskId, "merged")).toEqual({
    from_state: "waiting_human",
    to_state: "merged",
  });
});

test("waiting_human adopted PR with newer green approved head reconciles to done", async () => {
  h = createHarness();
  h.clock.set("2026-05-15T08:45:00.000Z");

  const repoId = insertRepo(h.db, "repo-parked-adopted-ready");
  const taskId = insertTask(h.db, {
    taskId: "task-parked-adopted-ready",
    repoId,
    state: "waiting_human",
  });
  const branchName = "feature/human-adopted";
  h.db
    .query(
      `UPDATE tasks
          SET authoring_mode = 'adopted_external_pr',
              branch_name = ?,
              pr_number = 963,
              pr_url = 'https://example.invalid/pr/963',
              head_sha = 'stale-head',
              attempts_consumed = 5,
              budget_exhausted = 1,
              claim_id = 'claim-stale',
              claimed_at = ?,
              slack_thread_ref = 'C123:1.000000'
        WHERE task_id = ?`,
    )
    .run(branchName, h.clock.nowISO(), taskId);
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 5,
    spawnedAt: "2026-05-15T07:45:00.000Z",
  });
  const eventId = insertEvent(
    taskId,
    "budget_exhausted",
    "running",
    "awaiting-next-brief",
  );
  enqueueHandoff(taskId, "budget_exhausted", eventId);
  h.db
    .query(
      `UPDATE orchestrator_handoffs
          SET status = 'claimed',
              claim_id = 'claim-stale',
              claimed_at = ?
        WHERE task_id = ?`,
    )
    .run(h.clock.nowISO(), taskId);

  const built = buildTickDeps(h);
  built.github.setPrSnapshotByNumber(
    repoId,
    963,
    readyApprovedSnapshot(963, "current-head"),
  );

  const results = await tick_once(built.deps);

  expect(results).toEqual([{ task_id: taskId, action: "ci_passed" }]);
  expect(taskState(taskId)).toMatchObject({
    state: "done",
    claim_id: null,
    claimed_at: null,
    attempts_consumed: 5,
  });
  expect(taskPrMetadata(taskId)).toMatchObject({
    pr_number: 963,
    pr_url: "https://example.invalid/pr/963",
    head_sha: "current-head",
    base_sha: "base-963",
    budget_exhausted: 0,
  });
  expect(handoffStatus(taskId)).toBe("cancelled");
  expect(built.github.closePrCalls).toHaveLength(0);
  expect(outboxPayload(taskId)).toMatchObject({
    task_id: taskId,
    pr_number: 963,
    head_sha: "current-head",
    review_id: "review-963",
    review_attempt_id: null,
    approval_status: "approved",
  });
  expect(ciPassedEvent(taskId)).toEqual({
    from_state: "waiting_human",
    to_state: "done",
  });
});

test("waiting_human adopted PR with newer pending head reconciles to pr-open", async () => {
  h = createHarness();
  h.clock.set("2026-05-15T08:50:00.000Z");

  const repoId = insertRepo(h.db, "repo-parked-adopted-pending");
  const taskId = insertTask(h.db, {
    taskId: "task-parked-adopted-pending",
    repoId,
    state: "waiting_human",
  });
  h.db
    .query(
      `UPDATE tasks
          SET authoring_mode = 'adopted_external_pr',
              branch_name = 'feature/human-pending',
              pr_number = 964,
              head_sha = 'stale-head',
              budget_exhausted = 1,
              claim_id = 'claim-stale',
              claimed_at = ?
        WHERE task_id = ?`,
    )
    .run(h.clock.nowISO(), taskId);
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 5,
    spawnedAt: "2026-05-15T07:50:00.000Z",
  });
  const eventId = insertEvent(
    taskId,
    "budget_exhausted",
    "running",
    "awaiting-next-brief",
  );
  enqueueHandoff(taskId, "budget_exhausted", eventId);

  const built = buildTickDeps(h);
  built.github.setPrSnapshotByNumber(
    repoId,
    964,
    pendingSnapshot(964, "current-pending-head"),
  );

  const results = await tick_once(built.deps);

  expect(results).toEqual([{ task_id: taskId, action: "ci_pending" }]);
  expect(taskState(taskId)).toMatchObject({
    state: "pr-open",
    claim_id: null,
    claimed_at: null,
  });
  expect(taskPrMetadata(taskId)).toMatchObject({
    pr_number: 964,
    head_sha: "current-pending-head",
    base_sha: "base-964",
    budget_exhausted: 0,
  });
  expect(handoffStatus(taskId)).toBe("cancelled");
  expect(readyApprovedOutboxCount(taskId)).toBe(0);
});

test("adopted PR reconciliation evaluates full snapshot instead of lightweight metadata", async () => {
  h = createHarness();
  h.clock.set("2026-05-15T08:55:00.000Z");

  const repoId = insertRepo(h.db, "repo-parked-adopted-full-snapshot");
  const taskId = insertTask(h.db, {
    taskId: "task-parked-adopted-full-snapshot",
    repoId,
    state: "waiting_human",
  });
  h.db
    .query(
      `UPDATE tasks
          SET authoring_mode = 'adopted_external_pr',
              branch_name = 'feature/human-lightweight',
              pr_number = 965,
              head_sha = 'stale-head',
              budget_exhausted = 1
        WHERE task_id = ?`,
    )
    .run(taskId);
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 5,
    spawnedAt: "2026-05-15T07:55:00.000Z",
  });
  const eventId = insertEvent(
    taskId,
    "budget_exhausted",
    "running",
    "awaiting-next-brief",
  );
  enqueueHandoff(taskId, "budget_exhausted", eventId);

  const built = buildTickDeps(h);
  built.github.setPrLightweightSnapshotByNumber(
    repoId,
    965,
    readyApprovedSnapshot(965, "current-head"),
  );
  built.github.setPrSnapshotByNumber(
    repoId,
    965,
    pendingSnapshot(965, "current-head"),
  );

  const results = await tick_once(built.deps);

  expect(results).toEqual([{ task_id: taskId, action: "ci_pending" }]);
  expect(built.github.lightweightSnapshotByNumberCalls).toEqual([
    { repoId, prNumber: 965 },
  ]);
  expect(built.github.snapshotByNumberCalls).toEqual([
    { repoId, prNumber: 965 },
  ]);
  expect(taskState(taskId).state).toBe("pr-open");
  expect(readyApprovedOutboxCount(taskId)).toBe(0);
});

test("non_budget_loop task with externally closed PR transitions terminal and deletes remote branch", async () => {
  h = createHarness();
  h.clock.set("2026-05-15T09:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-parked-closed");
  const taskId = insertTask(h.db, {
    taskId: "task-parked-closed",
    repoId,
    state: "non_budget_loop",
  });
  const branchName = `quay/${taskId}`;
  const worktreePath = setWorktreePath(taskId, "non-budget-closed");
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-05-15T08:00:00.000Z",
  });

  const built = buildTickDeps(h);
  built.git.setLocalBranches(repoId, [branchName]);
  built.git.setRemoteBranches(repoId, [branchName]);
  built.git.setWorktreeBranch(repoId, worktreePath, branchName);
  built.github.setPrSnapshot(
    repoId,
    branchName,
    terminalSnapshot("closed_unmerged", 92),
  );

  const results = await tick_once(built.deps);

  expect(results).toEqual([{ task_id: taskId, action: "pr_closed_unmerged" }]);
  expect(taskState(taskId).state).toBe("closed_unmerged");
  expect(existsSync(worktreePath)).toBe(false);
  expect(built.git.localBranches.get(repoId)?.has(branchName)).toBe(false);
  expect(built.git.remoteBranches.get(repoId)?.has(branchName)).toBe(false);
  expect(terminalEvent(taskId, "closed")).toEqual({
    from_state: "non_budget_loop",
    to_state: "closed_unmerged",
  });
});

function setWorktreePath(taskId: string, leaf: string): string {
  if (!h) throw new Error("missing harness");
  const worktreePath = join(h.dataDir, "worktrees", leaf);
  mkdirSync(worktreePath, { recursive: true });
  h.db
    .query(`UPDATE tasks SET worktree_path = ? WHERE task_id = ?`)
    .run(worktreePath, taskId);
  return worktreePath;
}

function insertEvent(
  taskId: string,
  eventType: string,
  fromState: string,
  toState: string,
): number {
  if (!h) throw new Error("missing harness");
  const row = h.db
    .query<{ event_id: number }, [string, string, string, string, string]>(
      `INSERT INTO events (
         task_id, event_type, from_state, to_state, occurred_at
       ) VALUES (?, ?, ?, ?, ?)
       RETURNING event_id`,
    )
    .get(taskId, eventType, fromState, toState, h.clock.nowISO());
  if (!row) throw new Error("event insert returned no row");
  return row.event_id;
}

function enqueueHandoff(
  taskId: string,
  reason: OrchestratorHandoffReason,
  eventId: number,
): void {
  if (!h) throw new Error("missing harness");
  enqueueOrchestratorHandoff(
    { db: h.db, clock: h.clock },
    { taskId, reason, stateEventId: eventId },
  );
}

function taskState(taskId: string): {
  state: string;
  claim_id: string | null;
  claimed_at: string | null;
  attempts_consumed: number;
} {
  if (!h) throw new Error("missing harness");
  const row = h.db
    .query<
      {
        state: string;
        claim_id: string | null;
        claimed_at: string | null;
        attempts_consumed: number;
      },
      [string]
    >(
      `SELECT state, claim_id, claimed_at, attempts_consumed
         FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  if (!row) throw new Error(`missing task ${taskId}`);
  return row;
}

function taskPrMetadata(taskId: string): {
  pr_number: number | null;
  pr_url: string | null;
  head_sha: string | null;
  base_sha: string | null;
  budget_exhausted: number;
} {
  if (!h) throw new Error("missing harness");
  const row = h.db
    .query<
      {
        pr_number: number | null;
        pr_url: string | null;
        head_sha: string | null;
        base_sha: string | null;
        budget_exhausted: number;
      },
      [string]
    >(
      `SELECT pr_number, pr_url, head_sha, base_sha, budget_exhausted
         FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  if (!row) throw new Error(`missing task ${taskId}`);
  return row;
}

function handoffStatus(taskId: string): string {
  if (!h) throw new Error("missing harness");
  const row = h.db
    .query<{ status: string }, [string]>(
      `SELECT status FROM orchestrator_handoffs WHERE task_id = ?`,
    )
    .get(taskId);
  if (!row) throw new Error(`missing handoff for ${taskId}`);
  return row.status;
}

function terminalEvent(
  taskId: string,
  eventType: "merged" | "closed",
): { from_state: string; to_state: string } {
  if (!h) throw new Error("missing harness");
  const row = h.db
    .query<{ from_state: string; to_state: string }, [string, string]>(
      `SELECT from_state, to_state
         FROM events
        WHERE task_id = ? AND event_type = ?`,
    )
    .get(taskId, eventType);
  if (!row) throw new Error(`missing ${eventType} event for ${taskId}`);
  return row;
}

function ciPassedEvent(taskId: string): { from_state: string; to_state: string } {
  if (!h) throw new Error("missing harness");
  const row = h.db
    .query<{ from_state: string; to_state: string }, [string]>(
      `SELECT from_state, to_state
         FROM events
        WHERE task_id = ? AND event_type = 'ci_passed'`,
    )
    .get(taskId);
  if (!row) throw new Error(`missing ci_passed event for ${taskId}`);
  return row;
}

function outboxPayload(taskId: string): Record<string, unknown> {
  if (!h) throw new Error("missing harness");
  const row = h.db
    .query<{ payload_json: string }, [string]>(
      `SELECT payload_json
         FROM outbox_items
        WHERE task_id = ? AND kind = 'pr_ready_approved'`,
    )
    .get(taskId);
  if (!row) throw new Error(`missing ready-approved outbox row for ${taskId}`);
  return JSON.parse(row.payload_json) as Record<string, unknown>;
}

function readyApprovedOutboxCount(taskId: string): number {
  if (!h) throw new Error("missing harness");
  const row = h.db
    .query<{ count: number }, [string]>(
      `SELECT COUNT(*) AS count
         FROM outbox_items
        WHERE task_id = ? AND kind = 'pr_ready_approved'`,
    )
    .get(taskId);
  return row?.count ?? 0;
}

function terminalSnapshot(
  state: PrTerminalState,
  prNumber: number,
): PrSnapshot {
  return {
    prNumber,
    prUrl: `https://example.invalid/pr/${prNumber}`,
    state,
    headSha: `head-${prNumber}`,
    baseSha: `base-${prNumber}`,
    mergeable: "unknown",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: `head-${prNumber}`,
      items: [
        { name: "build", workflow: null, bucket: "pending", required: true },
      ],
    },
  };
}

function readyApprovedSnapshot(prNumber: number, headSha: string): PrSnapshot {
  return {
    prNumber,
    prUrl: `https://example.invalid/pr/${prNumber}`,
    state: "open",
    headSha,
    baseSha: `base-${prNumber}`,
    mergeable: "mergeable",
    latestReview: {
      decision: "APPROVED",
      latestReviewId: `review-${prNumber}`,
      comments: "Approved",
    },
    checks: {
      checkSha: headSha,
      items: [
        { name: "build", workflow: null, bucket: "pass", required: true },
      ],
    },
  };
}

function pendingSnapshot(prNumber: number, headSha: string): PrSnapshot {
  return {
    prNumber,
    prUrl: `https://example.invalid/pr/${prNumber}`,
    state: "open",
    headSha,
    baseSha: `base-${prNumber}`,
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: headSha,
      items: [
        { name: "build", workflow: null, bucket: "pending", required: true },
      ],
    },
  };
}
