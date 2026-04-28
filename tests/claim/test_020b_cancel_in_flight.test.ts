import { afterEach, expect, test } from "bun:test";
import {
  claim_task,
  escalate_human,
  submit_brief,
} from "../../src/core/claims.ts";
import { createArtifactStore } from "../../src/artifacts/store.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo, insertTask } from "../support/fixtures.ts";
import { FakeSlack } from "../support/fakes/slack.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_020b_cancel_in_flight_fences_claim_scoped_writes", () => {
  h = createHarness();
  h.clock.set("2026-04-28T10:00:00.000Z");
  const repoId = insertRepo(h.db, "repo-cancel-race");
  const taskId = insertTask(h.db, {
    taskId: "task-cancel-race",
    repoId,
    state: "awaiting-next-brief",
  });
  insertAttempt(h.db, { taskId, attemptNumber: 1, spawnedAt: "2026-04-28T08:00:00.000Z" });
  // Set a default Slack thread so escalate_human won't reject for missing ref.
  h.db
    .query(`UPDATE tasks SET slack_thread_ref = ? WHERE task_id = ?`)
    .run("C123:0.1", taskId);

  const claim = claim_task({ db: h.db, clock: h.clock }, { taskId });
  if (!claim.ok) throw new Error("expected claim to succeed");
  const claimId = claim.value.claim_id;

  // Operator runs `quay cancel` — write durable cancel intent at the task
  // level. (Slice 7 owns the finalizer; here we only verify the fence.)
  h.db
    .query(
      `UPDATE tasks SET cancel_requested_at = ? WHERE task_id = ?`,
    )
    .run("2026-04-28T10:01:00.000Z", taskId);

  const store = createArtifactStore({ db: h.db, artifactRoot: h.artifactRoot, clock: h.clock });
  const slack = new FakeSlack();

  const submission = submit_brief(
    { db: h.db, clock: h.clock, artifactStore: store },
    { taskId, claimId, brief: "follow-up brief", reason: "blocker_resolved" },
  );
  expect(submission.ok).toBe(false);
  if (submission.ok) throw new Error("expected submit to fail");
  expect(submission.error.code).toBe("cancelled");

  const escalation = escalate_human(
    { db: h.db, clock: h.clock, artifactStore: store, ids: h.ids },
    { taskId, claimId, questionBody: "should not post" },
  );
  expect(escalation.ok).toBe(false);
  if (escalation.ok) throw new Error("expected escalate to fail");
  expect(escalation.error.code).toBe("cancelled");

  // No new attempt, brief, or escalation artifact rows were written.
  const pendingAttempts = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM attempts WHERE task_id = ? AND spawned_at IS NULL`,
    )
    .get(taskId);
  expect(pendingAttempts!.n).toBe(0);
  const briefs = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM artifacts WHERE task_id = ? AND kind = 'brief'`,
    )
    .get(taskId);
  expect(briefs!.n).toBe(0);
  const escalations = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM artifacts
         WHERE task_id = ? AND kind = 'slack_escalation_post'`,
    )
    .get(taskId);
  expect(escalations!.n).toBe(0);

  // No Slack API call ever happened.
  expect(slack.totalCalls()).toBe(0);

  // Task state is unchanged from the claim it had pre-cancel.
  const task = h.db
    .query<{ state: string; claim_id: string | null }, [string]>(
      `SELECT state, claim_id FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task!.state).toBe("claimed-by-orchestrator");
  expect(task!.claim_id).toBe(claimId);
});
