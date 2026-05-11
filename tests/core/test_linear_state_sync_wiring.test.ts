// Linear ticket-state writeback wired into the existing tick / claims /
// cancel emitters. These tests pin the four mapped transitions, the no-op
// on PR-driven events, the idempotent-skip semantics, and the best-effort
// behaviour on adapter failures.
//
// The Linear adapter is exercised via the FakeLinearAdapter built into the
// test harness; assertions read `setIssueStateCalls` to observe the
// writebacks (or their deliberate absence).

import { afterEach, expect, test } from "bun:test";
import { cancel_task } from "../../src/core/cancel.ts";
import { claim_task, escalate_human } from "../../src/core/claims.ts";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import {
  insertAttempt,
  insertFinalPromptArtifact,
  insertRepo,
  insertTask,
} from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

// Helpers ---------------------------------------------------------------

function setExternalRef(harness: Harness, taskId: string, ref: string | null) {
  harness.db
    .query(`UPDATE tasks SET external_ref = ? WHERE task_id = ?`)
    .run(ref, taskId);
}

function setSlackThread(harness: Harness, taskId: string, threadRef: string) {
  harness.db
    .query(`UPDATE tasks SET slack_thread_ref = ? WHERE task_id = ?`)
    .run(threadRef, taskId);
}

// Tests -----------------------------------------------------------------

test("test_linear_sync_spawn_writes_in_progress", async () => {
  h = createHarness();
  h.clock.set("2026-05-11T10:00:00.000Z");
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-sync-spawn");
  const taskId = insertTask(h.db, {
    taskId: "task-sync-spawn",
    repoId,
    state: "queued",
  });
  setExternalRef(h, taskId, "ENG-100");
  const attemptId = insertAttempt(h.db, { taskId, attemptNumber: 1 });
  insertFinalPromptArtifact(h.db, h.artifactRoot, h.clock, taskId, attemptId);

  const results = await tick_once(built.deps);
  expect(results.some((r) => r.action === "spawned")).toBe(true);

  expect(built.linear.setIssueStateCalls).toEqual([
    { identifier: "ENG-100", stateName: "In Progress" },
  ]);
});

test("test_linear_sync_escalate_human_writes_waiting", async () => {
  h = createHarness();
  h.clock.set("2026-05-11T10:00:00.000Z");
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-sync-escalate");
  const taskId = insertTask(h.db, {
    taskId: "task-sync-escalate",
    repoId,
    state: "awaiting-next-brief",
  });
  setExternalRef(h, taskId, "ITRY-42");
  setSlackThread(h, taskId, "C123:0.42");
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-05-11T08:00:00.000Z",
  });

  const claim = claim_task({ db: h.db, clock: h.clock }, { taskId });
  if (!claim.ok) throw new Error("expected claim");
  h.ids.push("12345678");
  const esc = await escalate_human(
    {
      db: h.db,
      clock: h.clock,
      artifactStore: built.artifactStore,
      ids: h.ids,
      linear: built.linear,
    },
    {
      taskId,
      claimId: claim.value.claim_id,
      questionBody: "need a humans answer?",
    },
  );
  if (!esc.ok) throw new Error("expected escalate");

  expect(built.linear.setIssueStateCalls).toEqual([
    { identifier: "ITRY-42", stateName: "Waiting" },
  ]);
});

test("test_linear_sync_slack_reply_ingest_writes_in_progress", async () => {
  h = createHarness();
  h.clock.set("2026-05-11T10:00:00.000Z");
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-sync-reply");
  const taskId = insertTask(h.db, {
    taskId: "task-sync-reply",
    repoId,
    state: "awaiting-next-brief",
  });
  const threadRef = "Cabc:1.0";
  setExternalRef(h, taskId, "ENG-200");
  setSlackThread(h, taskId, threadRef);
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-05-11T08:00:00.000Z",
  });

  // Drive into waiting_human via escalate_human, then reset the call log so
  // the slack-reply path is the only thing this assertion sees.
  const claim = claim_task({ db: h.db, clock: h.clock }, { taskId });
  if (!claim.ok) throw new Error("expected claim");
  h.ids.push("abcdef12");
  const esc = await escalate_human(
    {
      db: h.db,
      clock: h.clock,
      artifactStore: built.artifactStore,
      ids: h.ids,
      linear: built.linear,
    },
    {
      taskId,
      claimId: claim.value.claim_id,
      questionBody: "ping me",
    },
  );
  if (!esc.ok) throw new Error("expected escalate");

  // First tick: fence + bot post. Second tick: human reply lands, gets
  // ingested, fires the writeback.
  await tick_once(built.deps);
  built.slack.appendHumanReply(threadRef, "all good, proceed");
  built.linear.resetSetIssueStateCalls();
  await tick_once(built.deps);

  expect(built.linear.setIssueStateCalls).toEqual([
    { identifier: "ENG-200", stateName: "In Progress" },
  ]);
});

test("test_linear_sync_cancel_writes_canceled", async () => {
  h = createHarness();
  h.clock.set("2026-05-11T10:00:00.000Z");
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-sync-cancel");
  const taskId = insertTask(h.db, {
    taskId: "task-sync-cancel",
    repoId,
    state: "queued",
  });
  setExternalRef(h, taskId, "ENG-300");
  insertAttempt(h.db, { taskId, attemptNumber: 1 });

  const result = await cancel_task(built.deps, { taskId });
  if (!result.ok) throw new Error("expected cancel ok");

  expect(
    built.linear.setIssueStateCalls.some(
      (c) => c.identifier === "ENG-300" && c.stateName === "Canceled",
    ),
  ).toBe(true);
});

test("test_linear_sync_pr_terminal_transitions_do_not_write", async () => {
  // Linear's GitHub integration owns PR-driven transitions. Quay must NOT
  // double-write on `pr_opened`, `merged`, or `closed_unmerged` events —
  // doing so would race the integration.
  h = createHarness();
  h.clock.set("2026-05-11T10:00:00.000Z");
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-sync-pr");
  const taskId = insertTask(h.db, {
    taskId: "task-sync-pr",
    repoId,
    state: "pr-open",
  });
  setExternalRef(h, taskId, "ENG-400");
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    spawnedAt: "2026-05-11T08:00:00.000Z",
  });

  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    prNumber: 42,
    prUrl: "https://example/pr/42",
    headSha: "headsha",
    baseSha: "basesha",
    state: "merged",
    mergeable: "mergeable",
    checks: { items: [], checkSha: "headsha" },
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
  });

  const results = await tick_once(built.deps);
  expect(results.some((r) => r.action === "pr_merged")).toBe(true);
  expect(built.linear.setIssueStateCalls).toEqual([]);
});

test("test_linear_sync_idempotent_skip_when_already_at_target", async () => {
  // The fake mirrors the real adapter's read-before-write: when the issue's
  // current Linear state already matches the requested name, the call is
  // a no-op and nothing lands in `setIssueStateCalls`.
  h = createHarness();
  h.clock.set("2026-05-11T10:00:00.000Z");
  const built = buildTickDeps(h);
  built.linear.setCurrentState("ENG-500", "In Progress");

  const repoId = insertRepo(h.db, "repo-sync-idem");
  const taskId = insertTask(h.db, {
    taskId: "task-sync-idem",
    repoId,
    state: "queued",
  });
  setExternalRef(h, taskId, "ENG-500");
  const attemptId = insertAttempt(h.db, { taskId, attemptNumber: 1 });
  insertFinalPromptArtifact(h.db, h.artifactRoot, h.clock, taskId, attemptId);

  const results = await tick_once(built.deps);
  expect(results.some((r) => r.action === "spawned")).toBe(true);
  expect(built.linear.setIssueStateCalls).toEqual([]);
});

test("test_linear_sync_skips_when_external_ref_is_not_linear_format", async () => {
  // The sync helper format-gates on `^[A-Z][A-Z0-9]*-\d+$`; a non-Linear
  // external_ref (legacy `--brief-file --external-ref` callers, or some
  // future non-Linear source) must never reach the Linear adapter.
  h = createHarness();
  h.clock.set("2026-05-11T10:00:00.000Z");
  const built = buildTickDeps(h);

  const repoId = insertRepo(h.db, "repo-sync-non-linear");
  const taskId = insertTask(h.db, {
    taskId: "task-sync-non-linear",
    repoId,
    state: "queued",
  });
  setExternalRef(h, taskId, "JIRA/some-other-source-123");
  const attemptId = insertAttempt(h.db, { taskId, attemptNumber: 1 });
  insertFinalPromptArtifact(h.db, h.artifactRoot, h.clock, taskId, attemptId);

  const results = await tick_once(built.deps);
  expect(results.some((r) => r.action === "spawned")).toBe(true);
  expect(built.linear.setIssueStateCalls).toEqual([]);
});

test("test_linear_sync_failure_is_best_effort_and_does_not_fail_tick", async () => {
  // Adapter error must downgrade to a warning and NOT propagate into the
  // tick result. The task's own state remains the source of truth — the
  // spawn still committed.
  h = createHarness();
  h.clock.set("2026-05-11T10:00:00.000Z");
  const built = buildTickDeps(h);
  built.linear.failNextSetIssueState(new Error("simulated Linear 500"));

  const repoId = insertRepo(h.db, "repo-sync-failure");
  const taskId = insertTask(h.db, {
    taskId: "task-sync-failure",
    repoId,
    state: "queued",
  });
  setExternalRef(h, taskId, "ENG-600");
  const attemptId = insertAttempt(h.db, { taskId, attemptNumber: 1 });
  insertFinalPromptArtifact(h.db, h.artifactRoot, h.clock, taskId, attemptId);

  const results = await tick_once(built.deps);
  expect(results.some((r) => r.action === "spawned")).toBe(true);

  // Task moved to running despite the Linear failure.
  const state = h.db
    .query<{ state: string }, [string]>(
      `SELECT state FROM tasks WHERE task_id = ?`,
    )
    .get(taskId)!.state;
  expect(state).toBe("running");
});
