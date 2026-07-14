import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dispatch } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";
import { enterReview } from "../../src/core/pr_review.ts";
import { createRepoService } from "../../src/core/repos/service.ts";
import { fetchTicketContextWithIssue } from "../../src/core/ticket_context.ts";
import { loadOriginalTaskObjective } from "../../src/core/worker_prompt.ts";
import type { DB } from "../../src/db/connection.ts";
import type { LinearIssue } from "../../src/ports/linear.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { buildCliDeps } from "../support/cli_deps.ts";
import { insertPreamble, seedTaskObjective } from "../support/fixtures.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

const FENCE = "```";
const REPO_ID = "repo-1";
const EXTERNAL_REF = "BRIX-1907";

type Built = ReturnType<typeof buildCliDeps>;

function addRepo(harness: Harness, repoId = REPO_ID): void {
  createRepoService({ db: harness.db, clock: harness.clock }).add({
    repo_id: repoId,
    repo_url: `git@example.com:owner/${repoId}.git`,
    base_branch: "main",
    package_manager: "bun",
    install_cmd: "bun install",
  });
}

function block(repo = REPO_ID): string {
  return [
    `${FENCE}quay-config`,
    `repo: ${repo}`,
    "tags:",
    "  - resnapshot",
    "authors:",
    "  - name: Fabian Scherer",
    "    slack_id: U06TDC56VJB",
    FENCE,
  ].join("\n");
}

function makeIssue(context: string, identifier = EXTERNAL_REF): LinearIssue {
  return {
    identifier,
    url: `https://linear.app/inverter/issue/${identifier}`,
    title: "Re-baseline the acceptance criteria",
    body: `## Context\n\n${context}\n\n${block()}\n`,
    comments: [],
  };
}

function insertTask(
  db: DB,
  opts: { taskId: string; state?: string; externalRef?: string | null },
): void {
  db.query(
    `INSERT INTO tasks (
       task_id, repo_id, external_ref, state, branch_name, tmux_id, worktree_path,
       retry_budget, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 5, ?, ?)`,
  ).run(
    opts.taskId,
    REPO_ID,
    opts.externalRef === undefined ? EXTERNAL_REF : opts.externalRef,
    opts.state ?? "waiting_external_changes",
    `quay/${opts.taskId}`,
    `quay-task-${opts.taskId}`,
    `/tmp/${opts.taskId}`,
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
  );
}

// Mirror what enqueue does: compose the snapshot from the (currently set)
// Linear issue via the exact fetch+parse+snapshot path, so the seeded artifact
// is byte-identical to a real creation-time snapshot.
async function composeSnapshot(built: Built, issue: LinearIssue): Promise<string> {
  built.linear.setIssue(issue);
  const fetched = await fetchTicketContextWithIssue(
    {
      linear: built.linear,
      slack: built.slack,
      config: { linearEnabled: true, slackEnabled: true },
    },
    issue.identifier,
  );
  return fetched.ctx.ticket_snapshot;
}

function seedSnapshot(built: Built, taskId: string, content: string): void {
  built.deps.artifactStore.writeArtifact({
    taskId,
    attemptId: null,
    kind: "ticket_snapshot",
    content,
    extension: "md",
  });
}

function latestSnapshot(harness: Harness, taskId: string): string {
  const row = harness.db
    .query<{ file_path: string }, [string]>(
      `SELECT file_path FROM artifacts
        WHERE task_id = ? AND kind = 'ticket_snapshot' AND attempt_id IS NULL
        ORDER BY artifact_id DESC LIMIT 1`,
    )
    .get(taskId)!;
  return readFileSync(row.file_path, "utf8");
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function snapshotCount(harness: Harness, taskId: string): number {
  return harness.db
    .query<{ n: number }, [string]>(
      `SELECT count(*) AS n FROM artifacts
        WHERE task_id = ? AND kind = 'ticket_snapshot'`,
    )
    .get(taskId)!.n;
}

function latestEvent(
  harness: Harness,
  taskId: string,
): { event_type: string; from_state: string | null; to_state: string | null; event_data: string | null } {
  return harness.db
    .query<
      { event_type: string; from_state: string | null; to_state: string | null; event_data: string | null },
      [string]
    >(
      `SELECT event_type, from_state, to_state, event_data
         FROM events WHERE task_id = ?
        ORDER BY event_id DESC LIMIT 1`,
    )
    .get(taskId)!;
}

function seedReviewOnlyAttempt(
  harness: Harness,
  taskId: string,
  verdict: string,
  headSha = "sha-original",
): void {
  const preambleId = insertPreamble(harness.db);
  harness.db
    .query(
      `INSERT INTO attempts (
         task_id, attempt_number, preamble_id, reason, consumed_budget,
         spawned_at, ended_at, head_sha, review_verdict
       ) VALUES (?, 1, ?, 'review_only', 0, ?, ?, ?, ?)`,
    )
    .run(
      taskId,
      preambleId,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
      headSha,
      verdict,
    );
}

function reviewVerdict(harness: Harness, taskId: string): string | null {
  return (
    harness.db
      .query<{ review_verdict: string | null }, [string]>(
        `SELECT review_verdict FROM attempts
          WHERE task_id = ? AND reason = 'review_only'
          ORDER BY attempt_id DESC LIMIT 1`,
      )
      .get(taskId)?.review_verdict ?? null
  );
}

test("resnapshot replaces the frozen snapshot from the current Linear ticket", async () => {
  h = createHarness();
  addRepo(h);
  const built = buildCliDeps(h);

  const original = await composeSnapshot(
    built,
    makeIssue("Original strict AC: must handle every edge case."),
  );
  insertTask(h.db, { taskId: "task-1" });
  seedSnapshot(built, "task-1", original);
  seedTaskObjective(h, "task-1", "Original worker objective: Original strict AC.");

  // Operator relaxes the AC on the live ticket.
  built.linear.setIssue(makeIssue("Relaxed AC: the happy path is sufficient."));

  const io = bufferIO();
  const result = await dispatch(
    ["task", "resnapshot", "task-1", "--reason", "operator relaxed AC in BRIX-1907"],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");
  const payload = JSON.parse(io.out());
  expect(payload).toMatchObject({
    task_id: "task-1",
    external_ref: EXTERNAL_REF,
    changed: true,
    review_invalidated: 0,
  });
  expect(payload.snapshot_artifact_id).not.toBeNull();
  expect(payload.objective_artifact_id).not.toBeNull();

  expect(snapshotCount(h, "task-1")).toBe(2);
  const parsed = JSON.parse(latestSnapshot(h, "task-1"));
  expect(parsed.linear_issue.body).toContain("Relaxed AC");
  expect(parsed.linear_issue.body).not.toContain("Original strict AC");
  expect(parsed.quay_config_block.repo).toBe(REPO_ID);
  expect(parsed.quay_config_block.tags).toEqual(["resnapshot"]);
  expect(built.linear.getIssueCalls).toContain(EXTERNAL_REF);

  const objective = loadOriginalTaskObjective(h.db, "task-1");
  expect(objective.artifactId).toBe(payload.objective_artifact_id);
  expect(objective.body).toContain("Relaxed AC");
  expect(objective.body).not.toContain("Original strict AC");
});

test("resnapshot emits a ticket_resnapshotted event with a before/after diff and the reason", async () => {
  h = createHarness();
  addRepo(h);
  const built = buildCliDeps(h);

  const original = await composeSnapshot(built, makeIssue("Strict: reject empty input."));
  insertTask(h.db, { taskId: "task-1", state: "pr-review" });
  seedSnapshot(built, "task-1", original);
  built.linear.setIssue(makeIssue("Relaxed: empty input is allowed."));

  const io = bufferIO();
  const result = await dispatch(
    ["task", "resnapshot", "task-1", "--reason", "widen accepted inputs"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);

  const event = latestEvent(h, "task-1");
  expect(event.event_type).toBe("ticket_resnapshotted");
  // No state transition — from/to mirror the task's current state.
  expect(event.from_state).toBe("pr-review");
  expect(event.to_state).toBe("pr-review");

  const data = JSON.parse(event.event_data!);
  expect(data.reason).toBe("widen accepted inputs");
  expect(data.external_ref).toBe(EXTERNAL_REF);
  expect(data.changed).toBe(true);
  expect(data.diff.linear_issue.body.before).toContain("Strict: reject empty input.");
  expect(data.diff.linear_issue.body.after).toContain("Relaxed: empty input is allowed.");
  expect(typeof data.before_snapshot_hash).toBe("string");
  expect(typeof data.after_snapshot_hash).toBe("string");
  expect(data.before_snapshot_hash).not.toBe(data.after_snapshot_hash);
  expect(data.after_snapshot_hash).toBe(sha256(latestSnapshot(h, "task-1")));
});

test("resnapshot updates the reviewer prompt context for the next review", async () => {
  h = createHarness();
  addRepo(h);
  const built = buildCliDeps(h);

  const original = await composeSnapshot(built, makeIssue("Original AC for review."));
  insertTask(h.db, { taskId: "task-1", state: "pr-open" });
  seedSnapshot(built, "task-1", original);
  seedTaskObjective(h, "task-1", "Original reviewer objective: stale AC.");
  built.linear.setIssue(makeIssue("Relaxed AC for review."));

  const io = bufferIO();
  const result = await dispatch(
    ["task", "resnapshot", "task-1", "--reason", "review should use latest ticket"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);

  built.github.setPrView(REPO_ID, 17, {
    number: 17,
    title: "Task PR",
    body: "Body",
    url: "https://github.example/repo/pull/17",
    headRefName: "quay/task-1",
    headSha: "head-review",
    baseRef: "main",
    isCrossRepository: false,
  });
  built.github.setPrSnapshotByNumber(REPO_ID, 17, {
    state: "open",
    headSha: "head-review",
    baseSha: "base-review",
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "head-review",
      items: [{ name: "ci", workflow: null, bucket: "pass", required: true }],
    },
  });

  const review = enterReview(
    {
      db: h.db,
      clock: h.clock,
      github: built.github,
      tmux: built.tmux,
      artifactStore: built.deps.artifactStore,
    },
    {
      repoId: REPO_ID,
      prNumber: 17,
      reviewerEnabled: true,
      gateQuayOwnedDone: true,
    },
  );
  expect(review.scheduled).toBe(true);
  expect(review.attempt_id).not.toBeNull();

  const promptPath = h.db
    .query<{ file_path: string }, [number]>(
      `SELECT file_path FROM artifacts
        WHERE attempt_id = ? AND kind = 'final_prompt'`,
    )
    .get(review.attempt_id!)!.file_path;
  const finalPrompt = readFileSync(promptPath, "utf8");
  expect(finalPrompt).toContain("Relaxed AC for review");
  expect(finalPrompt).not.toContain("stale AC");
});

test("resnapshot invalidates a stale changes_requested verdict so the next tick re-reviews", async () => {
  h = createHarness();
  addRepo(h);
  const built = buildCliDeps(h);

  const original = await composeSnapshot(built, makeIssue("Original AC."));
  insertTask(h.db, { taskId: "task-1", state: "waiting_external_changes" });
  seedSnapshot(built, "task-1", original);
  seedReviewOnlyAttempt(h, "task-1", "changes_requested");
  built.linear.setIssue(makeIssue("Relaxed AC."));

  const io = bufferIO();
  const result = await dispatch(
    ["task", "resnapshot", "task-1", "--reason", "unblock BRIX-1907 loop"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
  const payload = JSON.parse(io.out());
  expect(payload.changed).toBe(true);
  expect(payload.review_invalidated).toBe(1);

  // The terminal verdict is superseded, so enterReview's terminal_verdict_exists
  // gate no longer blocks a fresh review of the same head SHA.
  expect(reviewVerdict(h, "task-1")).toBe("superseded");
});

test("resnapshot preserves creation-time snapshot augmentations it does not recompute", async () => {
  h = createHarness();
  addRepo(h);
  const built = buildCliDeps(h);

  const core = await composeSnapshot(built, makeIssue("Original AC."));
  // Simulate an enqueue-linear snapshot that carries dependency/hierarchy
  // augmentation keys resnapshot must not recompute or drop.
  const augmented = JSON.parse(core) as Record<string, unknown>;
  augmented.linear_blocked_by_relations = [{ identifier: "BRIX-1900" }];
  augmented.linear_hierarchy = { parent: null, children: [] };
  insertTask(h.db, { taskId: "task-1" });
  seedSnapshot(built, "task-1", JSON.stringify(augmented, null, 2));

  built.linear.setIssue(makeIssue("Relaxed AC."));

  const io = bufferIO();
  const result = await dispatch(
    ["task", "resnapshot", "task-1", "--reason", "relax while keeping deps"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);

  const parsed = JSON.parse(latestSnapshot(h, "task-1"));
  expect(parsed.linear_issue.body).toContain("Relaxed AC");
  expect(parsed.linear_blocked_by_relations).toEqual([{ identifier: "BRIX-1900" }]);
  expect(parsed.linear_hierarchy).toEqual({ parent: null, children: [] });

  const data = JSON.parse(latestEvent(h, "task-1").event_data!);
  expect(data.after_snapshot_hash).toBe(sha256(latestSnapshot(h, "task-1")));
});

test("resnapshot is a safe, still-audited no-op when the ticket is unchanged", async () => {
  h = createHarness();
  addRepo(h);
  const built = buildCliDeps(h);

  const original = await composeSnapshot(built, makeIssue("Unchanged AC."));
  insertTask(h.db, { taskId: "task-1", state: "pr-review" });
  seedSnapshot(built, "task-1", original);
  seedReviewOnlyAttempt(h, "task-1", "changes_requested");
  // Ticket is NOT edited between creation and resnapshot.

  const io = bufferIO();
  const result = await dispatch(
    ["task", "resnapshot", "task-1", "--reason", "double-check no drift"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
  const payload = JSON.parse(io.out());
  expect(payload.changed).toBe(false);
  expect(payload.review_invalidated).toBe(0);
  expect(payload.snapshot_artifact_id).toBeNull();

  // No new artifact, and the review verdict is untouched.
  expect(snapshotCount(h, "task-1")).toBe(1);
  expect(reviewVerdict(h, "task-1")).toBe("changes_requested");

  // Still audited: the event is recorded with changed=false and an empty diff.
  const event = latestEvent(h, "task-1");
  expect(event.event_type).toBe("ticket_resnapshotted");
  const data = JSON.parse(event.event_data!);
  expect(data.changed).toBe(false);
  expect(data.reason).toBe("double-check no drift");
  expect(data.diff).toEqual({});
});

test("resnapshot no-op ignores creation-time augmentations when comparing", async () => {
  h = createHarness();
  addRepo(h);
  const built = buildCliDeps(h);

  const core = await composeSnapshot(built, makeIssue("Stable AC."));
  const augmented = JSON.parse(core) as Record<string, unknown>;
  augmented.linear_hierarchy = { parent: null, children: [] };
  insertTask(h.db, { taskId: "task-1" });
  seedSnapshot(built, "task-1", JSON.stringify(augmented, null, 2));
  // Ticket unchanged; only difference vs a fresh compose is the augmentation.

  const io = bufferIO();
  const result = await dispatch(
    ["task", "resnapshot", "task-1", "--reason", "verify stability"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(io.out()).changed).toBe(false);
  expect(snapshotCount(h, "task-1")).toBe(1);
  const data = JSON.parse(latestEvent(h, "task-1").event_data!);
  expect(data.before_snapshot_hash).toBe(data.after_snapshot_hash);
});

test("resnapshot rejects an unknown task", async () => {
  h = createHarness();
  addRepo(h);
  const built = buildCliDeps(h);

  const io = bufferIO();
  const result = await dispatch(
    ["task", "resnapshot", "nope", "--reason", "x"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(io.err())).toMatchObject({ error: "unknown_task" });
});

test("resnapshot rejects a task without an external_ref", async () => {
  h = createHarness();
  addRepo(h);
  const built = buildCliDeps(h);
  insertTask(h.db, { taskId: "task-1", externalRef: null });

  const io = bufferIO();
  const result = await dispatch(
    ["task", "resnapshot", "task-1", "--reason", "x"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(io.err())).toMatchObject({ error: "missing_external_ref" });
});

test("resnapshot requires --reason", async () => {
  h = createHarness();
  addRepo(h);
  const built = buildCliDeps(h);
  insertTask(h.db, { taskId: "task-1" });

  const io = bufferIO();
  const result = await dispatch(["task", "resnapshot", "task-1"], built.deps, io);
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(io.err())).toMatchObject({ error: "usage_error" });
});

test("resnapshot fails closed when the Linear adapter is disabled", async () => {
  h = createHarness();
  addRepo(h);
  const built = buildCliDeps(h, { linearEnabled: false });
  await composeSnapshot(built, makeIssue("Any AC."));
  insertTask(h.db, { taskId: "task-1" });

  const io = bufferIO();
  const result = await dispatch(
    ["task", "resnapshot", "task-1", "--reason", "x"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(io.err())).toMatchObject({ error: "adapter_not_enabled" });
});
