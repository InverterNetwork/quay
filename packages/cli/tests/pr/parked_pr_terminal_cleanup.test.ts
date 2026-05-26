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
