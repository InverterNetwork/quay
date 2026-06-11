import { afterEach, expect, test } from "bun:test";
import { dispatch } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";
import {
  enqueueReviewFindingLinearIssuesInOpenTxn,
  processReviewFindingLinearIssueOutboxItem,
  REVIEW_FINDING_LINEAR_ISSUE_OUTBOX_KIND,
} from "../../src/core/review_finding_linear_outbox.ts";
import { persistStructuredReviewFindingsInOpenTxn } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo, insertTask } from "../support/fixtures.ts";
import { buildCliDeps } from "../support/cli_deps.ts";
import { FakeLinearAdapter } from "../support/fakes/linear.ts";
import { QuayError } from "../../src/core/errors.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("synthetic non-blocking findings enqueue and deliver one Linear issue", async () => {
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

  const linear = new FakeLinearAdapter();
  await processReviewFindingLinearIssueOutboxItem(
    { db: h.db, clock: h.clock, linear },
    { outboxItemId: item.outbox_item_id },
  );

  expect(linear.createIssueCalls).toHaveLength(1);
  const call = linear.createIssueCalls[0]!;
  expect(call.title).toBe("Persist the follow-up");
  expect(call.body).toContain("src/a.ts:7-9");
  expect(call.body).toContain("quay-principle");
  expect(call.idempotencyKey).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(linkCount()).toBe(1);
});

test("outbox deliver command executes the Linear issue delivery handler", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  const seeded = seedReviewFindingTask("synthetic_review");
  persistFindings(seeded, [
    finding("non_blocking", "CLI follow-up", "Body text"),
  ]);
  const outbox = listFindingOutbox()[0]!;
  const io = bufferIO();

  const result = await dispatch(
    ["outbox", "deliver", String(outbox.outbox_item_id)],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");
  expect(JSON.parse(io.out())).toMatchObject({
    outbox_item_id: outbox.outbox_item_id,
    status: "completed",
  });
  expect(built.linear.createIssueCalls).toHaveLength(1);
  expect(linkCount()).toBe(1);
});

test("outbox deliver command rejects disabled Linear adapter before delivery", async () => {
  h = createHarness();
  const built = buildCliDeps(h, { linearEnabled: false });
  const seeded = seedReviewFindingTask("synthetic_review");
  persistFindings(seeded, [
    finding("non_blocking", "CLI follow-up", "Body text"),
  ]);
  const outbox = listFindingOutbox()[0]!;
  const io = bufferIO();

  const result = await dispatch(
    ["outbox", "deliver", String(outbox.outbox_item_id)],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(1);
  expect(io.out()).toBe("");
  expect(JSON.parse(io.err())).toMatchObject({
    error: "adapter_not_enabled",
    adapter: "linear",
  });
  expect(built.linear.createIssueCalls).toHaveLength(0);
  expect(linkCount()).toBe(0);
});

test("outbox deliver normalizes Linear delivery failures through CLI errors", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  const seeded = seedReviewFindingTask("synthetic_review");
  persistFindings(seeded, [
    finding("non_blocking", "CLI failure", "Body text"),
  ]);
  const outbox = listFindingOutbox()[0]!;
  built.linear.createIssue = async () => {
    throw new QuayError("adapter_error", "Linear failed", {
      adapter: "linear",
      retryable: true,
    });
  };
  const io = bufferIO();

  const result = await dispatch(
    ["outbox", "deliver", String(outbox.outbox_item_id)],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(1);
  expect(io.out()).toBe("");
  expect(JSON.parse(io.err())).toMatchObject({
    error: "adapter_error",
    message: "Linear failed",
    adapter: "linear",
  });
});

test("adopted external PR findings are human-owned and blocking findings are skipped", () => {
  h = createHarness();
  const seeded = seedReviewFindingTask("adopted_external_pr");
  persistFindings(seeded, [
    finding("non_blocking", "Adopted follow-up", "Body text"),
    finding("blocking", "Blocking review", "Do not ticket this path"),
  ]);

  const outbox = listFindingOutbox();
  expect(outbox).toHaveLength(1);
  const payload = JSON.parse(outbox[0]!.payload_json ?? "{}");
  expect(payload.title).toBe("Adopted follow-up");
});

test("quay-owned review findings do not create Linear follow-up outbox rows", () => {
  h = createHarness();
  const seeded = seedReviewFindingTask("quay_owned");
  persistFindings(seeded, [
    finding("non_blocking", "Worker should handle this", "Body text"),
  ]);

  expect(listFindingOutbox()).toHaveLength(0);
});

test("retrying a Linear issue outbox row does not create duplicate issues", async () => {
  h = createHarness();
  const seeded = seedReviewFindingTask("synthetic_review");
  persistFindings(seeded, [
    finding("non_blocking", "Retry follow-up", "Body text"),
  ]);
  const outbox = listFindingOutbox()[0]!;
  const linear = new FakeLinearAdapter();

  await processReviewFindingLinearIssueOutboxItem(
    { db: h.db, clock: h.clock, linear },
    { outboxItemId: outbox.outbox_item_id },
  );

  h.db
    .query(
      `UPDATE outbox_items
          SET status = 'pending',
              claim_id = NULL,
              claimed_at = NULL
        WHERE outbox_item_id = ?`,
    )
    .run(outbox.outbox_item_id);
  await processReviewFindingLinearIssueOutboxItem(
    { db: h.db, clock: h.clock, linear },
    { outboxItemId: outbox.outbox_item_id },
  );

  expect(linear.createIssueCalls).toHaveLength(1);
  expect(linkCount()).toBe(1);
});

test("Linear rate limits preserve retry-after as outbox cooldown", async () => {
  h = createHarness();
  h.clock.set("2026-06-11T16:00:00.000Z");
  const seeded = seedReviewFindingTask("synthetic_review");
  persistFindings(seeded, [
    finding("non_blocking", "Rate limited follow-up", "Body text"),
  ]);
  const outbox = listFindingOutbox()[0]!;
  const linear = new FakeLinearAdapter();
  linear.createIssue = async () => {
    throw new QuayError("adapter_error", "Linear rate-limited", {
      adapter: "linear",
      retryable: true,
      retry_after: 90,
    });
  };

  await expect(
    processReviewFindingLinearIssueOutboxItem(
      { db: h.db, clock: h.clock, linear },
      { outboxItemId: outbox.outbox_item_id },
    ),
  ).rejects.toThrow("Linear rate-limited");

  const row = h.db
    .query<{ next_eligible_at: string | null }, [number]>(
      `SELECT next_eligible_at FROM outbox_items WHERE outbox_item_id = ?`,
    )
    .get(outbox.outbox_item_id);
  expect(row?.next_eligible_at).toBe("2026-06-11T16:01:30.000Z");
});

test("provider idempotency converges when link persistence fails after Linear create", async () => {
  h = createHarness();
  const seeded = seedReviewFindingTask("synthetic_review");
  persistFindings(seeded, [
    finding("non_blocking", "Crash-window follow-up", "Body text"),
  ]);
  const outbox = listFindingOutbox()[0]!;
  const linear = new FakeLinearAdapter();

  h.db.exec(
    `CREATE TRIGGER review_finding_external_links_crash
       BEFORE INSERT ON review_finding_external_links
       BEGIN
         SELECT RAISE(FAIL, 'simulated link write crash');
       END`,
  );
  await expect(
    processReviewFindingLinearIssueOutboxItem(
      { db: h.db, clock: h.clock, linear },
      { outboxItemId: outbox.outbox_item_id },
    ),
  ).rejects.toThrow("simulated link write crash");
  h.db.exec("DROP TRIGGER review_finding_external_links_crash");

  await processReviewFindingLinearIssueOutboxItem(
    { db: h.db, clock: h.clock, linear },
    { outboxItemId: outbox.outbox_item_id },
  );

  expect(linear.createIssueCalls).toHaveLength(2);
  expect(linear.createIssueCalls[0]!.idempotencyKey).toBe(
    linear.createIssueCalls[1]!.idempotencyKey,
  );
  expect(linkProviderExternalId()).toBe("linear-created-1");
  expect(linkCount()).toBe(1);
});

test("re-persisting the same review reuses outbox idempotency and reattaches the provider link", async () => {
  h = createHarness();
  const seeded = seedReviewFindingTask("synthetic_review");
  const rows = [finding("non_blocking", "Stable follow-up", "Body text")];
  persistFindings(seeded, rows);
  const outbox = listFindingOutbox()[0]!;
  const linear = new FakeLinearAdapter();
  await processReviewFindingLinearIssueOutboxItem(
    { db: h.db, clock: h.clock, linear },
    { outboxItemId: outbox.outbox_item_id },
  );
  const firstFindingId = currentFindingId();

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

function linkProviderExternalId(): string | null {
  if (!h) throw new Error("missing harness");
  return h.db
    .query<{ provider_external_id: string | null }, []>(
      `SELECT provider_external_id FROM review_finding_external_links LIMIT 1`,
    )
    .get()!.provider_external_id;
}
