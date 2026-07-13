import { afterEach, expect, test } from "bun:test";
import {
  enqueueReviewFindingLinearIssuesInOpenTxn,
  REVIEW_FINDING_LINEAR_ISSUE_OUTBOX_KIND,
} from "../../src/core/review_finding_linear_outbox.ts";
import { persistStructuredReviewFindingsInOpenTxn } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo, insertTask } from "../support/fixtures.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("synthetic non-blocking findings enqueue one Linear issue outbox row", () => {
  h = createHarness();
  const seeded = seedReviewFindingTask("synthetic_review");
  persistFindings(seeded, [
    finding("non_blocking", "Persist the follow-up", "Body text", {
      locations: [{ path: "src/a.ts", start_line: 7, end_line: 9 }],
      principle_text: "Prefer durable side effects.",
    }),
  ]);

  const outbox = listFindingOutbox();
  expect(outbox).toHaveLength(1);
  const item = outbox[0]!;
  expect(item.kind).toBe(REVIEW_FINDING_LINEAR_ISSUE_OUTBOX_KIND);
  const payload = JSON.parse(item.payload_json ?? "{}");
  expect(payload.title).toBe("Persist the follow-up");
  expect(payload.principle_text).toBe("Prefer durable side effects.");
  expect(payload.locations).toHaveLength(1);
  expect(payload.locations[0].path).toBe("src/a.ts");
  expect(payload.locations[0].start_line).toBe(7);
  expect(payload.locations[0].end_line).toBe(9);
});

test("adopted external PR findings do not create Linear follow-up outbox rows", () => {
  h = createHarness();
  // Quay owns the feedback loop for adopted PRs: the worker respawns on
  // changes_requested and fixes non-blocking findings in-loop, so filing a
  // Linear issue for them would be redundant.
  const seeded = seedReviewFindingTask("adopted_external_pr");
  persistFindings(seeded, [
    finding("non_blocking", "Adopted follow-up", "Body text"),
    finding("blocking", "Blocking review", "Do not ticket this path"),
  ]);

  expect(listFindingOutbox()).toHaveLength(0);
});

test("quay-owned review findings do not create Linear follow-up outbox rows", () => {
  h = createHarness();
  const seeded = seedReviewFindingTask("quay_owned");
  persistFindings(seeded, [
    finding("non_blocking", "Worker should handle this", "Body text"),
  ]);

  expect(listFindingOutbox()).toHaveLength(0);
});

test("re-persisting the same review reattaches an existing provider link to the new finding", () => {
  h = createHarness();
  const seeded = seedReviewFindingTask("synthetic_review");
  const rows = [finding("non_blocking", "Stable follow-up", "Body text")];
  persistFindings(seeded, rows);
  const outbox = listFindingOutbox()[0]!;
  const firstFindingId = currentFindingId();
  // Simulate the orchestrator recording the delivered Linear issue back into
  // Quay's dedup ledger. Re-enqueue must then reattach the link to the newly
  // persisted finding rather than minting a second outbox row.
  seedExternalLink(firstFindingId, outbox.outbox_item_id);

  persistFindings(seeded, rows);

  expect(listFindingOutbox()).toHaveLength(1);
  expect(linkCount()).toBe(1);
  expect(currentFindingId()).not.toBe(firstFindingId);
  expect(linkFindingId()).toBe(currentFindingId());
});

function seedReviewFindingTask(
  authoringMode: "synthetic_review" | "adopted_external_pr" | "quay_owned",
): { taskId: string; attemptId: number } {
  if (!h) throw new Error("missing harness");
  const repoId = insertRepo(h.db, `repo-${authoringMode}`);
  const taskId = insertTask(h.db, {
    repoId,
    taskId: `task-${authoringMode}`,
    state: "pr-review",
  });
  h.db
    .query(
      `UPDATE tasks
          SET authoring_mode = ?,
              pr_number = 17,
              pr_url = 'https://github.test/acme/repo/pull/17',
              head_sha = 'head-review'
        WHERE task_id = ?`,
    )
    .run(authoringMode, taskId);
  const attemptId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: h.clock.nowISO(),
  });
  return { taskId, attemptId };
}

function persistFindings(
  seeded: { taskId: string; attemptId: number },
  findings: unknown[],
): void {
  if (!h) throw new Error("missing harness");
  h.db.exec("BEGIN IMMEDIATE");
  try {
    persistStructuredReviewFindingsInOpenTxn(
      { db: h.db },
      {
        taskId: seeded.taskId,
        attemptId: seeded.attemptId,
        reviewId: "review-1",
        headSha: "head-review",
        now: h.clock.nowISO(),
        rawReviewResult: JSON.stringify({
          verdict: "changes_requested",
          body: "review body",
          findings,
        }),
      },
    );
    enqueueReviewFindingLinearIssuesInOpenTxn(
      { db: h.db, clock: h.clock },
      {
        taskId: seeded.taskId,
        attemptId: seeded.attemptId,
        reviewId: "review-1",
      },
    );
    h.db.exec("COMMIT");
  } catch (err) {
    h.db.exec("ROLLBACK");
    throw err;
  }
}

function finding(
  severity: "blocking" | "non_blocking",
  title: string,
  body: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { severity, title, body, ...extra };
}

function listFindingOutbox(): Array<{
  outbox_item_id: number;
  kind: string;
  payload_json: string | null;
}> {
  if (!h) throw new Error("missing harness");
  return h.db
    .query<{ outbox_item_id: number; kind: string; payload_json: string | null }, [string]>(
      `SELECT outbox_item_id, kind, payload_json
         FROM outbox_items
        WHERE kind = ?
        ORDER BY outbox_item_id`,
    )
    .all(REVIEW_FINDING_LINEAR_ISSUE_OUTBOX_KIND);
}

// Seed the Quay-owned dedup ledger row the orchestrator would write back after
// creating the Linear issue, so enqueue's reattachment path can be exercised
// without the (removed) in-process delivery handler.
function seedExternalLink(findingId: number, outboxItemId: number): void {
  if (!h) throw new Error("missing harness");
  const finding = h.db
    .query<{ task_id: string; review_id: string; fingerprint: string }, [number]>(
      `SELECT task_id, review_id, fingerprint
         FROM review_findings
        WHERE finding_id = ?`,
    )
    .get(findingId);
  if (finding === null) throw new Error(`finding ${findingId} not found`);
  const now = h.clock.nowISO();
  h.db
    .query(
      `INSERT INTO review_finding_external_links (
         finding_id, task_id, review_id, fingerprint, provider,
         provider_external_id, provider_url, outbox_item_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'linear', 'linear-created-1', 'https://linear.test/1', ?, ?, ?)`,
    )
    .run(
      findingId,
      finding.task_id,
      finding.review_id,
      finding.fingerprint,
      outboxItemId,
      now,
      now,
    );
}

function linkCount(): number {
  if (!h) throw new Error("missing harness");
  return h.db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM review_finding_external_links`,
    )
    .get()!.n;
}

function currentFindingId(): number {
  if (!h) throw new Error("missing harness");
  return h.db
    .query<{ finding_id: number }, []>(
      `SELECT finding_id FROM review_findings ORDER BY finding_id DESC LIMIT 1`,
    )
    .get()!.finding_id;
}

function linkFindingId(): number | null {
  if (!h) throw new Error("missing harness");
  return h.db
    .query<{ finding_id: number | null }, []>(
      `SELECT finding_id FROM review_finding_external_links LIMIT 1`,
    )
    .get()!.finding_id;
}
