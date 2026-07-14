import { afterEach, expect, test } from "bun:test";
import {
  enqueueReviewFindingLinearIssuesIfEnabledInOpenTxn,
  resolveReviewFindingLinearEnabled,
} from "../../src/core/review_finding_linear_policy.ts";
import { REVIEW_FINDING_LINEAR_ISSUE_OUTBOX_KIND } from "../../src/core/review_finding_linear_outbox.ts";
import { persistStructuredReviewFindingsInOpenTxn } from "../../src/core/tick.ts";
import { createDeploymentSettingsService } from "../../src/core/deployment_settings.ts";
import { createRepoService } from "../../src/core/repos/service.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo, insertTask } from "../support/fixtures.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

function setGlobal(enabled: boolean | null): void {
  if (!h) throw new Error("missing harness");
  createDeploymentSettingsService({ db: h.db, clock: h.clock }).update({
    review_finding_linear_enabled: enabled,
  });
}

function setRepoOverride(repoId: string, enabled: boolean | null): void {
  if (!h) throw new Error("missing harness");
  createRepoService({ db: h.db, clock: h.clock }).update(repoId, {
    review_finding_linear_enabled: enabled,
  });
}

// --- resolution logic -----------------------------------------------------

test("resolution defaults to ON when unset at both scopes", () => {
  h = createHarness();
  const repoId = insertRepo(h.db, "repo-default");
  expect(resolveReviewFindingLinearEnabled(h.db, repoId)).toBe(true);
});

test("resolution follows the global default when the repo inherits", () => {
  h = createHarness();
  const repoId = insertRepo(h.db, "repo-inherits");

  setGlobal(false);
  expect(resolveReviewFindingLinearEnabled(h.db, repoId)).toBe(false);

  setGlobal(true);
  expect(resolveReviewFindingLinearEnabled(h.db, repoId)).toBe(true);
});

test("resolution: repo override wins over the global default", () => {
  h = createHarness();
  const repoId = insertRepo(h.db, "repo-override");

  setGlobal(true);
  setRepoOverride(repoId, false);
  expect(resolveReviewFindingLinearEnabled(h.db, repoId)).toBe(false);

  setGlobal(false);
  setRepoOverride(repoId, true);
  expect(resolveReviewFindingLinearEnabled(h.db, repoId)).toBe(true);
});

test("resolution: clearing the repo override falls back to the global default", () => {
  h = createHarness();
  const repoId = insertRepo(h.db, "repo-cleared");

  setGlobal(false);
  setRepoOverride(repoId, true);
  expect(resolveReviewFindingLinearEnabled(h.db, repoId)).toBe(true);

  setRepoOverride(repoId, null);
  expect(resolveReviewFindingLinearEnabled(h.db, repoId)).toBe(false);
});

// --- enqueue gate ---------------------------------------------------------

test("enqueue gate off (repo) persists findings but skips the outbox row", () => {
  h = createHarness();
  const seeded = seedSyntheticReviewTask("repo-gate-off");
  setRepoOverride(seeded.repoId, false);

  persistAndGatedEnqueue(seeded);

  expect(findingCount()).toBe(1);
  expect(listFindingOutbox()).toHaveLength(0);
});

test("enqueue gate off (global) skips the outbox row", () => {
  h = createHarness();
  const seeded = seedSyntheticReviewTask("repo-global-off");
  setGlobal(false);

  persistAndGatedEnqueue(seeded);

  expect(findingCount()).toBe(1);
  expect(listFindingOutbox()).toHaveLength(0);
});

test("enqueue gate default ON enqueues the outbox row", () => {
  h = createHarness();
  const seeded = seedSyntheticReviewTask("repo-gate-on");

  persistAndGatedEnqueue(seeded);

  expect(findingCount()).toBe(1);
  const outbox = listFindingOutbox();
  expect(outbox).toHaveLength(1);
  expect(outbox[0]!.kind).toBe(REVIEW_FINDING_LINEAR_ISSUE_OUTBOX_KIND);
});

test("enqueue gate: repo ON overrides a global OFF default", () => {
  h = createHarness();
  const seeded = seedSyntheticReviewTask("repo-gate-repo-on");
  setGlobal(false);
  setRepoOverride(seeded.repoId, true);

  persistAndGatedEnqueue(seeded);

  expect(listFindingOutbox()).toHaveLength(1);
});

// --- helpers --------------------------------------------------------------

function seedSyntheticReviewTask(repoId: string): {
  repoId: string;
  taskId: string;
  attemptId: number;
} {
  if (!h) throw new Error("missing harness");
  insertRepo(h.db, repoId);
  const taskId = insertTask(h.db, {
    repoId,
    taskId: `task-${repoId}`,
    state: "pr-review",
  });
  h.db
    .query(
      `UPDATE tasks
          SET authoring_mode = 'synthetic_review',
              pr_number = 21,
              pr_url = 'https://github.test/acme/repo/pull/21',
              head_sha = 'head-review'
        WHERE task_id = ?`,
    )
    .run(taskId);
  const attemptId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: h.clock.nowISO(),
  });
  return { repoId, taskId, attemptId };
}

function persistAndGatedEnqueue(seeded: {
  repoId: string;
  taskId: string;
  attemptId: number;
}): void {
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
          findings: [
            { severity: "non_blocking", title: "Follow-up", body: "Body text" },
          ],
        }),
      },
    );
    enqueueReviewFindingLinearIssuesIfEnabledInOpenTxn(
      { db: h.db, clock: h.clock },
      {
        taskId: seeded.taskId,
        attemptId: seeded.attemptId,
        reviewId: "review-1",
        repoId: seeded.repoId,
      },
    );
    h.db.exec("COMMIT");
  } catch (err) {
    h.db.exec("ROLLBACK");
    throw err;
  }
}

function findingCount(): number {
  if (!h) throw new Error("missing harness");
  return h.db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM review_findings`)
    .get()!.n;
}

function listFindingOutbox(): Array<{ outbox_item_id: number; kind: string }> {
  if (!h) throw new Error("missing harness");
  return h.db
    .query<{ outbox_item_id: number; kind: string }, [string]>(
      `SELECT outbox_item_id, kind
         FROM outbox_items
        WHERE kind = ?
        ORDER BY outbox_item_id`,
    )
    .all(REVIEW_FINDING_LINEAR_ISSUE_OUTBOX_KIND);
}
