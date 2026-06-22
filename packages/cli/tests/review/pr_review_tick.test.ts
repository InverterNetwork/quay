import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import {
  persistStructuredReviewFindingsInOpenTxn,
  REVIEWER_GH_TOKEN_ENV,
  tick_once,
  type TickOptions,
} from "../../src/core/tick.ts";
import { createArtifactStore } from "../../src/artifacts/store.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { buildTickDeps } from "../support/tick_deps.ts";
import {
  insertAttempt,
  insertFinalPromptArtifact,
  insertRepo,
  insertTask,
  seedTaskObjective,
} from "../support/fixtures.ts";

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

function seedRunningReviewAttempt(
  h: Harness,
  opts: {
    repoId: string;
    taskId: string;
    prNumber: number;
    headSha: string;
    sessionName: string;
    spawnedAt?: string;
  },
): { attemptId: number } {
  const worktreePath = `${h.dataDir}/worktrees/${opts.taskId}`;
  mkdirSync(worktreePath, { recursive: true });
  const taskId = insertTask(h.db, {
    repoId: opts.repoId,
    taskId: opts.taskId,
    state: "pr-review",
  });
  h.db
    .query(
      `UPDATE tasks
          SET pr_number = ?,
              head_sha = ?,
              worktree_path = ?
        WHERE task_id = ?`,
    )
    .run(opts.prNumber, opts.headSha, worktreePath, taskId);
  seedTaskObjective(h, taskId);
  const attemptId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: opts.spawnedAt ?? h.clock.nowISO(),
  });
  h.db
    .query(
      `UPDATE attempts
          SET head_sha = ?,
              tmux_session = ?
        WHERE attempt_id = ?`,
    )
    .run(opts.headSha, opts.sessionName, attemptId);
  const store = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });
  store.writeArtifact({
    taskId,
    attemptId,
    kind: "brief",
    content: "review brief",
    extension: "md",
  });
  store.writeArtifact({
    taskId,
    attemptId,
    kind: "final_prompt",
    content: "review prompt",
    extension: "md",
  });
  return { attemptId };
}

function writeReviewResult(
  worktreePath: string,
  input: {
    verdict: "approved" | "changes_requested";
    body: string;
    findings?: unknown[];
  },
): void {
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(
    join(worktreePath, ".quay-review-result.json"),
    JSON.stringify({ ...input, findings: input.findings ?? [] }),
  );
}

function quayReviewBody(
  body: string,
  taskId: string,
  attemptId: number,
  headSha: string,
): string {
  return `${body.trimEnd()}\n\n<!-- quay-review-result task_id=${taskId} attempt_id=${attemptId} head_sha=${headSha} -->`;
}

test("CI-green pr-open task enters pr-review when reviewer gate is enabled", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-gated");
  const taskId = insertTask(h.db, { repoId, taskId: "task-gated", state: "pr-open" });
  seedTaskObjective(h, taskId);
  const attemptId = insertAttempt(h.db, {
    taskId,
    spawnedAt: "2026-01-01T00:00:00.000Z",
  });
  const store = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });
  store.writeArtifact({
    taskId,
    attemptId,
    kind: "brief",
    content: "original task brief",
    extension: "md",
  });
  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    prNumber: 99,
    state: "open",
    headSha: "head-99",
    baseSha: "base-1",
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "head-99",
      items: [{ name: "build", workflow: null, bucket: "pass", required: true }],
    },
  });
  built.github.setPrView(repoId, 99, {
    number: 99,
    title: "Quay-owned PR",
    body: "",
    url: "https://example.test/pr/99",
    headRefName: `quay/${taskId}`,
    headSha: "head-99",
  });

  const results = await tick_once(
    built.deps,
    reviewerTickOptions({ gateQuayOwnedDone: true }),
  );

  expect(results).toContainEqual({ task_id: taskId, action: "review_requested" });
  const task = h.db
    .query<{ state: string; pr_number: number | null }, [string]>(
      `SELECT state, pr_number FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toEqual({ state: "pr-review", pr_number: 99 });
  const reviewAttempt = h.db
    .query<{ reason: string; head_sha: string | null }, [string]>(
      `SELECT reason, head_sha FROM attempts
        WHERE task_id = ? ORDER BY attempt_id DESC LIMIT 1`,
    )
    .get(taskId);
  expect(reviewAttempt).toEqual({ reason: "review_only", head_sha: "head-99" });
});

test("review prompt omits stale generated PR target after task base branch repair", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-base-repair-review");
  const taskId = insertTask(h.db, {
    repoId,
    taskId: "task-base-repair-review",
    state: "pr-open",
  });
  seedTaskObjective(h, taskId, "Implement the repaired-base task.");
  h.db
    .query(`UPDATE tasks SET base_branch = 'main' WHERE task_id = ?`)
    .run(taskId);
  h.db
    .query(`UPDATE tasks SET base_branch = 'dev' WHERE task_id = ?`)
    .run(taskId);
  const attemptId = insertAttempt(h.db, {
    taskId,
    spawnedAt: "2026-01-01T00:00:00.000Z",
  });
  const store = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });
  store.writeArtifact({
    taskId,
    attemptId,
    kind: "brief",
    content: [
      "<quay-task-objective>",
      "Implement the repaired-base task.",
      "</quay-task-objective>",
      "",
      '<quay-pr-target base-branch="main">',
      "Open or update the pull request against base branch main.",
      "</quay-pr-target>",
    ].join("\n"),
    extension: "md",
  });
  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    prNumber: 100,
    state: "open",
    headSha: "head-100",
    baseSha: "base-dev",
    baseRef: "dev",
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "head-100",
      items: [{ name: "build", workflow: null, bucket: "pass", required: true }],
    },
  });
  built.github.setPrView(repoId, 100, {
    number: 100,
    title: "Base repair PR",
    body: "",
    url: "https://example.test/pr/100",
    headRefName: `quay/${taskId}`,
    headSha: "head-100",
  });

  const results = await tick_once(
    built.deps,
    reviewerTickOptions({ gateQuayOwnedDone: true }),
  );

  expect(results).toContainEqual({ task_id: taskId, action: "review_requested" });
  const reviewerAttempt = h.db
    .query<{ attempt_id: number }, [string]>(
      `SELECT attempt_id FROM attempts
        WHERE task_id = ? AND reason = 'review_only' AND head_sha = 'head-100'
        ORDER BY attempt_id DESC LIMIT 1`,
    )
    .get(taskId);
  expect(reviewerAttempt).not.toBeNull();
  const promptRow = h.db
    .query<{ file_path: string }, [string, number]>(
      `SELECT file_path FROM artifacts
        WHERE task_id = ? AND attempt_id = ? AND kind = 'final_prompt'
        ORDER BY artifact_id DESC LIMIT 1`,
    )
    .get(taskId, reviewerAttempt!.attempt_id);
  expect(promptRow).not.toBeNull();
  const prompt = readFileSync(promptRow!.file_path, "utf8");
  expect(prompt).toContain("Base branch: dev");
  expect(prompt).not.toContain('base-branch="main"');
  expect(prompt).not.toContain("Open or update the pull request against base branch main.");
  expect(prompt).toContain("Review target and Required action above are authoritative");
  expect(prompt).toContain("Implement the repaired-base task.");
});

test("tick spawns pending review attempts without moving task to running", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-spawn-review");
  const taskId = insertTask(h.db, {
    repoId,
    taskId: "task-review-spawn",
    state: "pr-review",
  });
  seedTaskObjective(h, taskId);
  h.db
    .query(`UPDATE tasks SET pr_number = 10, head_sha = 'review-sha' WHERE task_id = ?`)
    .run(taskId);
  const attemptId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
  });
  h.db
    .query(`UPDATE attempts SET head_sha = 'review-sha' WHERE attempt_id = ?`)
    .run(attemptId);
  insertFinalPromptArtifact(h.db, h.artifactRoot, h.clock, taskId, attemptId, "review prompt");

  const results = await tick_once(built.deps, reviewerTickOptions());

  expect(results).toContainEqual({ task_id: taskId, action: "spawned" });
  expect(built.tmux.spawnCalls).toHaveLength(1);
  expect(built.tmux.spawnCalls[0]!.sessionName).toContain("quay-review-");
  const row = h.db
    .query<{ state: string; spawned_at: string | null; tmux_session: string | null }, [number]>(
      `SELECT t.state, a.spawned_at, a.tmux_session
         FROM attempts a JOIN tasks t ON t.task_id = a.task_id
        WHERE a.attempt_id = ?`,
    )
    .get(attemptId);
  expect(row?.state).toBe("pr-review");
  expect(row?.spawned_at).not.toBeNull();
  expect(row?.tmux_session).toContain("quay-review-");
});

test("dead synthetic reviewer approval stores review artifact and marks task done", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-review-done");
  const taskId = "pr-review-repo-review-done-7";
  const worktreePath = `${h.dataDir}/worktrees/review-7`;
  mkdirSync(worktreePath, { recursive: true });
  const reviewerTrace = [
    JSON.stringify({ type: "session_configured", model: "gpt-5.5-codex" }),
    JSON.stringify({
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 21,
          output_tokens: 13,
          reasoning_output_tokens: 5,
          total_tokens: 34,
        },
      },
    }),
  ].join("\n");
  writeFileSync(
    join(worktreePath, ".quay-tool-trace.log"),
    `${reviewerTrace}\n`,
  );
  h.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, state, branch_name, tmux_id, worktree_path,
         pr_number, head_sha, retry_budget, created_at, updated_at
       ) VALUES (?, ?, 'pr-review', 'quay-review/7', 'quay-review-repo-review-done-7',
                 ?, 7, 'sha-7', 1, ?, ?)`,
    )
    .run(taskId, repoId, worktreePath, h.clock.nowISO(), h.clock.nowISO());
  seedTaskObjective(h, taskId);
  const attemptId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: h.clock.nowISO(),
  });
  h.db
    .query(
      `UPDATE attempts
          SET head_sha = 'sha-7', tmux_session = 'quay-review-session'
        WHERE attempt_id = ?`,
    )
    .run(attemptId);
  writeReviewResult(worktreePath, { verdict: "approved", body: "Looks good." });

  const results = await tick_once(built.deps, reviewerTickOptions());

  expect(results).toContainEqual({ task_id: taskId, action: "review_approved" });
  expect(built.github.submitPullRequestReviewCalls).toHaveLength(1);
  expect(built.github.submitPullRequestReviewCalls[0]).toMatchObject({
    repoId,
    prNumber: 7,
    headSha: "sha-7",
    verdict: "APPROVED",
    body: quayReviewBody("Looks good.", taskId, attemptId, "sha-7"),
    token: "ghs_reviewer_runtime_test",
  });
  const task = h.db
    .query<{ state: string }, [string]>(`SELECT state FROM tasks WHERE task_id = ?`)
    .get(taskId);
  expect(task?.state).toBe("done");
  const attempt = h.db
    .query<{ review_verdict: string | null; review_id: string | null }, [number]>(
      `SELECT review_verdict, review_id FROM attempts WHERE attempt_id = ?`,
    )
    .get(attemptId);
  expect(attempt).toEqual({
    review_verdict: "approved",
    review_id: "R_submitted_1",
  });
  const artifact = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM artifacts
        WHERE task_id = ? AND kind = 'review_comments'`,
    )
    .get(taskId);
  expect(artifact?.n).toBe(1);
  const rawResultArtifact = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM artifacts
        WHERE task_id = ? AND kind = 'review_result'`,
    )
    .get(taskId);
  expect(rawResultArtifact?.n).toBe(1);
  expect(existsSync(join(worktreePath, ".quay-review-result.json"))).toBe(false);
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
  const usage = h.db
    .query<{ file_path: string }, [string, number]>(
      `SELECT file_path FROM artifacts
        WHERE task_id = ? AND attempt_id = ? AND kind = 'usage'`,
    )
    .get(taskId, attemptId);
  expect(JSON.parse(readFileSync(usage!.file_path, "utf8"))).toEqual({
    source: "codex_jsonl",
    model: "gpt-5.5-codex",
    input_tokens: 21,
    output_tokens: 13,
    reasoning_tokens: 5,
    total_tokens: 34,
  });
});

test("posted review keeps result file when durable finalization fails", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-review-result-finalize-fails");
  const taskId = "pr-review-repo-review-result-finalize-fails-7";
  const worktreePath = `${h.dataDir}/worktrees/review-finalize-fails-7`;
  mkdirSync(worktreePath, { recursive: true });
  h.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, state, authoring_mode, branch_name, tmux_id, worktree_path,
         pr_number, head_sha, retry_budget, created_at, updated_at
       ) VALUES (?, ?, 'pr-review', 'synthetic_review', 'quay-review/finalize-fails',
                 'quay-review-result-finalize-fails-7', ?, 7, 'sha-finalize-fails', 1, ?, ?)`,
    )
    .run(taskId, repoId, worktreePath, h.clock.nowISO(), h.clock.nowISO());
  seedTaskObjective(h, taskId);
  const attemptId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: h.clock.nowISO(),
  });
  h.db
    .query(
      `UPDATE attempts
          SET head_sha = 'sha-finalize-fails',
              tmux_session = 'quay-review-session-finalize-fails'
        WHERE attempt_id = ?`,
    )
    .run(attemptId);
  writeReviewResult(worktreePath, { verdict: "approved", body: "Looks good." });

  const originalArtifactStore = built.deps.artifactStore;
  built.deps.artifactStore = {
    writeArtifact(input) {
      if (input.kind === "review_result") {
        throw new Error("simulated review result persistence failure");
      }
      return originalArtifactStore.writeArtifact(input);
    },
  };

  const results = await tick_once(built.deps, reviewerTickOptions());

  expect(built.github.submitPullRequestReviewCalls).toHaveLength(1);
  expect(results).toContainEqual({
    task_id: taskId,
    action: "tick_error",
    error: "simulated review result persistence failure",
  });
  expect(existsSync(join(worktreePath, ".quay-review-result.json"))).toBe(true);
  const attempt = h.db
    .query<{ review_id: string | null }, [number]>(
      `SELECT review_id FROM attempts WHERE attempt_id = ?`,
    )
    .get(attemptId);
  expect(attempt?.review_id).toBeNull();

  built.deps.artifactStore = originalArtifactStore;
  const retryResults = await tick_once(built.deps, reviewerTickOptions());

  expect(retryResults).toContainEqual({
    task_id: taskId,
    action: "review_approved",
  });
  expect(built.github.submitPullRequestReviewCalls).toHaveLength(1);
  expect(built.github.fetchPostedReviewCalls.at(-1)).toMatchObject({
    repoId,
    prNumber: 7,
    headSha: "sha-finalize-fails",
    token: "ghs_reviewer_runtime_test",
  });
  expect(existsSync(join(worktreePath, ".quay-review-result.json"))).toBe(false);
  const retriedAttempt = h.db
    .query<{ review_id: string | null }, [number]>(
      `SELECT review_id FROM attempts WHERE attempt_id = ?`,
    )
    .get(attemptId);
  expect(retriedAttempt?.review_id).toBe("R_submitted_1");
});

test("token-only retry ignores matching human review without Quay marker", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-review-token-only-human-collision");
  const taskId = "pr-review-repo-review-token-only-human-collision-7";
  const worktreePath = `${h.dataDir}/worktrees/review-token-only-human-collision-7`;
  mkdirSync(worktreePath, { recursive: true });
  h.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, state, authoring_mode, branch_name, tmux_id, worktree_path,
         pr_number, head_sha, retry_budget, created_at, updated_at
       ) VALUES (?, ?, 'pr-review', 'synthetic_review', 'quay-review/human-collision',
                 'quay-review-token-only-human-collision-7', ?, 7, 'sha-human-collision', 1, ?, ?)`,
    )
    .run(taskId, repoId, worktreePath, h.clock.nowISO(), h.clock.nowISO());
  seedTaskObjective(h, taskId);
  const attemptId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: h.clock.nowISO(),
  });
  h.db
    .query(
      `UPDATE attempts
          SET head_sha = 'sha-human-collision',
              tmux_session = 'quay-review-session-human-collision'
        WHERE attempt_id = ?`,
    )
    .run(attemptId);
  built.github.setPostedReview(repoId, 7, "sha-human-collision", {
    reviewId: "R_human_lgtm",
    decision: "APPROVED",
    body: "lgtm!",
    comments: "lgtm!",
  });
  writeReviewResult(worktreePath, { verdict: "approved", body: "lgtm!" });

  const results = await tick_once(built.deps, reviewerTickOptions());

  expect(results).toContainEqual({
    task_id: taskId,
    action: "review_approved",
  });
  const reconcileCall = built.github.fetchPostedReviewCalls.find(
    (call) =>
      call.expectedBody ===
      quayReviewBody("lgtm!", taskId, attemptId, "sha-human-collision"),
  );
  expect(reconcileCall).toMatchObject({
    repoId,
    prNumber: 7,
    headSha: "sha-human-collision",
    token: "ghs_reviewer_runtime_test",
    expectedDecision: "APPROVED",
    expectedBody: quayReviewBody("lgtm!", taskId, attemptId, "sha-human-collision"),
  });
  expect(built.github.submitPullRequestReviewCalls).toHaveLength(1);
  expect(built.github.submitPullRequestReviewCalls[0]).toMatchObject({
    body: quayReviewBody("lgtm!", taskId, attemptId, "sha-human-collision"),
  });
  const attempt = h.db
    .query<{ review_id: string | null }, [number]>(
      `SELECT review_id FROM attempts WHERE attempt_id = ?`,
    )
    .get(attemptId);
  expect(attempt?.review_id).toBe("R_submitted_1");
});

test("dead synthetic reviewer persists structured findings and locations", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-review-findings");
  const taskId = "pr-review-repo-review-findings-17";
  const worktreePath = `${h.dataDir}/worktrees/review-17`;
  mkdirSync(worktreePath, { recursive: true });
  h.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, state, authoring_mode, branch_name, tmux_id, worktree_path,
         pr_number, head_sha, retry_budget, created_at, updated_at
       ) VALUES (?, ?, 'pr-review', 'synthetic_review', 'quay-review/17', 'quay-review-repo-review-findings-17',
                 ?, 17, 'sha-17', 1, ?, ?)`,
    )
    .run(taskId, repoId, worktreePath, h.clock.nowISO(), h.clock.nowISO());
  seedTaskObjective(h, taskId);
  const attemptId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: h.clock.nowISO(),
  });
  h.db
    .query(
      `UPDATE attempts
          SET head_sha = 'sha-17', tmux_session = 'quay-review-session-17'
        WHERE attempt_id = ?`,
    )
    .run(attemptId);
  built.github.setPostedReview(repoId, 17, "sha-17", {
    reviewId: "R_findings",
    decision: "CHANGES_REQUESTED",
    body: quayReviewBody("Please fix these.", taskId, attemptId, "sha-17"),
    comments: "Please fix these.",
  });
  writeReviewResult(worktreePath, {
    verdict: "changes_requested",
    body: "Please fix these.",
    findings: [
      {
        severity: "blocking",
        title: "Validate the request body",
        body: "The route trusts unchecked input.",
        principle_text: "Handlers must validate external input before use.",
        locations: [
          {
            path: "packages/app/src/routes.ts",
            start_line: 42,
            end_line: 45,
            url: "https://github.com/acme/repo/blob/sha-17/packages/app/src/routes.ts#L42-L45",
          },
          { path: "packages/app/src/schema.ts", line: 9 },
        ],
      },
      {
        severity: "non_blocking",
        title: "Tighten copy",
        body: "The label is ambiguous.",
        locations: [],
      },
      {
        severity: "non_blocking",
        title: "Tighten copy",
        body: "The label is ambiguous.",
        locations: [],
      },
    ],
  });

  const results = await tick_once(built.deps, reviewerTickOptions());

  expect(results).toContainEqual({
    task_id: taskId,
    action: "review_changes_requested",
  });
  const findings = h.db
    .query<
      {
        ordinal: number;
        severity: string;
        title: string;
        body_markdown: string;
        principle_text: string | null;
        review_id: string;
        head_sha: string;
        fingerprint: string;
      },
      [number]
    >(
      `SELECT ordinal, severity, title, body_markdown, principle_text,
              review_id, head_sha, fingerprint
         FROM review_findings
        WHERE attempt_id = ?
        ORDER BY ordinal`,
    )
    .all(attemptId);
  expect(findings).toHaveLength(2);
  expect(findings[0]).toMatchObject({
    ordinal: 1,
    severity: "blocking",
    title: "Validate the request body",
    body_markdown: "The route trusts unchecked input.",
    principle_text: "Handlers must validate external input before use.",
    review_id: "R_findings",
    head_sha: "sha-17",
  });
  expect(findings[0]?.fingerprint).toHaveLength(64);
  expect(findings[1]).toMatchObject({
    ordinal: 2,
    severity: "non_blocking",
    title: "Tighten copy",
    principle_text: null,
  });
  const locations = h.db
    .query<
      {
        finding_ordinal: number;
        ordinal: number;
        path: string | null;
        start_line: number | null;
        end_line: number | null;
        url: string | null;
      },
      [number]
    >(
      `SELECT rf.ordinal AS finding_ordinal, rfl.ordinal, rfl.path,
              rfl.start_line, rfl.end_line, rfl.url
         FROM review_finding_locations rfl
         JOIN review_findings rf ON rf.finding_id = rfl.finding_id
        WHERE rf.attempt_id = ?
        ORDER BY rf.ordinal, rfl.ordinal`,
    )
    .all(attemptId);
  expect(locations).toEqual([
    {
      finding_ordinal: 1,
      ordinal: 1,
      path: "packages/app/src/routes.ts",
      start_line: 42,
      end_line: 45,
      url: "https://github.com/acme/repo/blob/sha-17/packages/app/src/routes.ts#L42-L45",
    },
    {
      finding_ordinal: 1,
      ordinal: 2,
      path: "packages/app/src/schema.ts",
      start_line: 9,
      end_line: 9,
      url: null,
    },
  ]);
});

test("spawning a fresh reviewer clears stale result files from prior attempts", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-review-clear-stale-result");
  const taskId = "pr-review-repo-review-clear-stale-result-19";
  const worktreePath = `${h.dataDir}/worktrees/review-clear-stale-result-19`;
  mkdirSync(worktreePath, { recursive: true });
  writeReviewResult(worktreePath, {
    verdict: "approved",
    body: "Stale approval.",
  });
  h.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, state, branch_name, tmux_id, worktree_path,
         pr_number, head_sha, retry_budget, created_at, updated_at
       ) VALUES (?, ?, 'pr-review', 'quay-review/19',
                 'quay-review-clear-stale-result-19', ?, 19, 'sha-19', 1, ?, ?)`,
    )
    .run(taskId, repoId, worktreePath, h.clock.nowISO(), h.clock.nowISO());
  seedTaskObjective(h, taskId);
  const attemptId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: null,
  });
  h.db
    .query(`UPDATE attempts SET head_sha = 'sha-19' WHERE attempt_id = ?`)
    .run(attemptId);
  insertFinalPromptArtifact(h.db, h.artifactRoot, h.clock, taskId, attemptId, "review prompt");

  const results = await tick_once(built.deps, reviewerTickOptions());

  expect(results).toContainEqual({
    task_id: taskId,
    action: "spawned",
  });
  expect(existsSync(join(worktreePath, ".quay-review-result.json"))).toBe(false);
});

test("structured review finding ingestion handles zero findings and re-ingest idempotently", () => {
  h = createHarness();
  const repoId = insertRepo(h.db, "repo-review-findings-idempotent");
  const taskId = insertTask(h.db, {
    repoId,
    taskId: "task-review-findings-idempotent",
    state: "pr-review",
  });
  const attemptId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: h.clock.nowISO(),
  });
  const raw = JSON.stringify({
    verdict: "changes_requested",
    body: "Please fix this.",
    findings: [
      {
        severity: "blocking",
        title: "Use the stable key",
        body: "The dedupe key changes between retries.",
        "quay-principle": "Dedupe keys must be stable across repeated ingestion.",
      },
    ],
  });

  h.db.exec("BEGIN IMMEDIATE");
  persistStructuredReviewFindingsInOpenTxn(h, {
    taskId,
    attemptId,
    reviewId: "R_idempotent",
    headSha: "sha-idempotent",
    now: h.clock.nowISO(),
    rawReviewResult: raw,
  });
  persistStructuredReviewFindingsInOpenTxn(h, {
    taskId,
    attemptId,
    reviewId: "R_idempotent",
    headSha: "sha-idempotent",
    now: h.clock.nowISO(),
    rawReviewResult: raw,
  });
  h.db.exec("COMMIT");

  const count = h.db
    .query<{ n: number }, [number]>(
      `SELECT COUNT(*) AS n FROM review_findings WHERE attempt_id = ?`,
    )
    .get(attemptId);
  expect(count?.n).toBe(1);

  h.db.exec("BEGIN IMMEDIATE");
  persistStructuredReviewFindingsInOpenTxn(h, {
    taskId,
    attemptId,
    reviewId: "R_idempotent",
    headSha: "sha-idempotent",
    now: h.clock.nowISO(),
    rawReviewResult: JSON.stringify({
      verdict: "approved",
      body: "lgtm!",
      findings: [],
    }),
  });
  h.db.exec("COMMIT");

  const afterZero = h.db
    .query<{ n: number }, [number]>(
      `SELECT COUNT(*) AS n FROM review_findings WHERE attempt_id = ?`,
    )
    .get(attemptId);
  expect(afterZero?.n).toBe(0);
});

test("dead synthetic reviewer changes_requested waits for external changes", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-review-wait");
  const taskId = "pr-review-repo-review-wait-8";
  const worktreePath = `${h.dataDir}/worktrees/review-8`;
  mkdirSync(worktreePath, { recursive: true });
  h.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, state, branch_name, tmux_id, worktree_path,
         pr_number, head_sha, retry_budget, created_at, updated_at
       ) VALUES (?, ?, 'pr-review', 'quay-review/8', 'quay-review-repo-review-wait-8',
                 ?, 8, 'sha-8', 1, ?, ?)`,
    )
    .run(taskId, repoId, worktreePath, h.clock.nowISO(), h.clock.nowISO());
  seedTaskObjective(h, taskId);
  const attemptId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: h.clock.nowISO(),
  });
  h.db
    .query(
      `UPDATE attempts
          SET head_sha = 'sha-8', tmux_session = 'quay-review-session-8'
        WHERE attempt_id = ?`,
    )
    .run(attemptId);
  built.github.setPostedReview(repoId, 8, "sha-8", {
    reviewId: "R_changes",
    decision: "CHANGES_REQUESTED",
    body: quayReviewBody("Please fix this.", taskId, attemptId, "sha-8"),
    comments: "Inline review comments (1):\n- src/a.ts:1 - fix this",
  });
  writeReviewResult(worktreePath, {
    verdict: "changes_requested",
    body: "Please fix this.",
  });

  const results = await tick_once(built.deps, reviewerTickOptions());

  expect(results).toContainEqual({
    task_id: taskId,
    action: "review_changes_requested",
  });
  const task = h.db
    .query<{ state: string }, [string]>(`SELECT state FROM tasks WHERE task_id = ?`)
    .get(taskId);
  expect(task?.state).toBe("waiting_external_changes");
});

test("adopted synthetic reviewer changes_requested schedules code respawn", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-review-adopted");
  const taskId = "pr-review-repo-review-adopted-9";
  const worktreePath = `${h.dataDir}/worktrees/review-adopted-9`;
  mkdirSync(worktreePath, { recursive: true });
  h.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, state, authoring_mode, branch_name, tmux_id,
         worktree_path, pr_number, head_sha, retry_budget, created_at, updated_at
       ) VALUES (?, ?, 'pr-review', 'adopted_external_pr', 'feature/human',
                 'quay-review-repo-review-adopted-9', ?, 9, 'sha-9', 1, ?, ?)`,
    )
    .run(taskId, repoId, worktreePath, h.clock.nowISO(), h.clock.nowISO());
  seedTaskObjective(h, taskId, "Adopt and finish PR #9.");
  const codeAttemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "adopt_pr",
    consumedBudget: 1,
    spawnedAt: "2026-01-01T00:00:00.000Z",
  });
  const store = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });
  store.writeArtifact({
    taskId,
    attemptId: codeAttemptId,
    kind: "brief",
    content: "adopted worker brief",
    extension: "md",
  });
  const reviewAttemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 2,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: h.clock.nowISO(),
  });
  h.db
    .query(
      `UPDATE attempts
          SET head_sha = 'sha-9', tmux_session = 'quay-review-session-9'
        WHERE attempt_id = ?`,
    )
    .run(reviewAttemptId);
  built.github.setPostedReview(repoId, 9, "sha-9", {
    reviewId: "R_adopted_changes",
    decision: "CHANGES_REQUESTED",
    body: quayReviewBody(
      "Please address this.",
      taskId,
      reviewAttemptId,
      "sha-9",
    ),
    comments: "Inline review comments (1):\n- src/a.ts:1 - fix this",
  });
  writeReviewResult(worktreePath, {
    verdict: "changes_requested",
    body: "Please address this.",
  });
  built.github.setPrSnapshot(repoId, "feature/human", {
    prNumber: 9,
    state: "open",
    headSha: "sha-9",
    baseSha: "base-main",
    baseRef: "main",
    mergeable: "mergeable",
    latestReview: {
      decision: "CHANGES_REQUESTED",
      latestReviewId: "R_adopted_changes",
      comments: "Inline review comments (1):\n- src/a.ts:1 - fix this",
    },
    checks: {
      checkSha: "sha-9",
      items: [{ name: "build", workflow: null, bucket: "pass", required: true }],
    },
  });

  const results = await tick_once(built.deps, reviewerTickOptions());

  expect(results).toContainEqual({
    task_id: taskId,
    action: "review_respawn_scheduled",
  });
  const task = h.db
    .query<{ state: string; non_budget_respawns_consumed: number }, [string]>(
      `SELECT state, non_budget_respawns_consumed FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toEqual({ state: "queued", non_budget_respawns_consumed: 1 });
  const latest = h.db
    .query<{ reason: string; consumed_budget: number }, [string]>(
      `SELECT reason, consumed_budget FROM attempts
        WHERE task_id = ? ORDER BY attempt_id DESC LIMIT 1`,
    )
    .get(taskId);
  expect(latest).toEqual({ reason: "review", consumed_budget: 0 });
});

test("Quay-owned reviewer changes_requested schedules non-budget code respawn", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-review-respawn");
  const taskId = insertTask(h.db, {
    repoId,
    taskId: "task-review-respawn",
    state: "pr-review",
  });
  seedTaskObjective(h, taskId);
  h.db
    .query(`UPDATE tasks SET pr_number = 11, head_sha = 'sha-11' WHERE task_id = ?`)
    .run(taskId);
  const codeAttemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
    spawnedAt: "2026-01-01T00:00:00.000Z",
  });
  const store = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });
  store.writeArtifact({
    taskId,
    attemptId: codeAttemptId,
    kind: "brief",
    content: "original code brief",
    extension: "md",
  });
  const reviewAttemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 2,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: h.clock.nowISO(),
  });
  h.db
    .query(
      `UPDATE attempts
          SET head_sha = 'sha-11', tmux_session = 'quay-review-session-11'
        WHERE attempt_id = ?`,
    )
    .run(reviewAttemptId);
  built.github.setPostedReview(repoId, 11, "sha-11", {
    reviewId: "R_quay_changes",
    decision: "CHANGES_REQUESTED",
    body: quayReviewBody("Blocking issue.", taskId, reviewAttemptId, "sha-11"),
    comments: "Blocking issue.",
  });
  writeReviewResult(`/tmp/${taskId}`, {
    verdict: "changes_requested",
    body: "Blocking issue.",
  });
  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    prNumber: 11,
    state: "open",
    headSha: "sha-11",
    baseSha: "base-main",
    baseRef: "main",
    mergeable: "mergeable",
    latestReview: {
      decision: "CHANGES_REQUESTED",
      latestReviewId: "R_quay_changes",
      comments: "Blocking issue.",
    },
    checks: {
      checkSha: "sha-11",
      items: [{ name: "build", workflow: null, bucket: "pass", required: true }],
    },
  });

  const results = await tick_once(built.deps, reviewerTickOptions());

  expect(results).toContainEqual({
    task_id: taskId,
    action: "review_respawn_scheduled",
  });
  const task = h.db
    .query<{ state: string; non_budget_respawns_consumed: number }, [string]>(
      `SELECT state, non_budget_respawns_consumed FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toEqual({ state: "queued", non_budget_respawns_consumed: 1 });
  const latest = h.db
    .query<{ reason: string; consumed_budget: number }, [string]>(
      `SELECT reason, consumed_budget FROM attempts
        WHERE task_id = ? ORDER BY attempt_id DESC LIMIT 1`,
    )
    .get(taskId);
  expect(latest).toEqual({ reason: "review", consumed_budget: 0 });
});

test("review changes_requested respawn refreshes human-retargeted PR base", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-review-retargeted-base");
  const taskId = insertTask(h.db, {
    repoId,
    taskId: "task-review-retargeted-base",
    state: "pr-review",
  });
  seedTaskObjective(h, taskId, "Preserve the live PR base.");
  h.db
    .query(
      `UPDATE tasks
          SET pr_number = 12,
              head_sha = 'sha-12',
              base_branch = 'main'
        WHERE task_id = ?`,
    )
    .run(taskId);
  const codeAttemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
    spawnedAt: "2026-01-01T00:00:00.000Z",
  });
  const store = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });
  store.writeArtifact({
    taskId,
    attemptId: codeAttemptId,
    kind: "brief",
    content: "original code brief",
    extension: "md",
  });
  const reviewAttemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 2,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: h.clock.nowISO(),
  });
  h.db
    .query(
      `UPDATE attempts
          SET head_sha = 'sha-12', tmux_session = 'quay-review-session-12'
        WHERE attempt_id = ?`,
    )
    .run(reviewAttemptId);
  built.github.setPostedReview(repoId, 12, "sha-12", {
    reviewId: "R_retargeted_changes",
    decision: "CHANGES_REQUESTED",
    body: quayReviewBody(
      "Retargeted PR needs fixes.",
      taskId,
      reviewAttemptId,
      "sha-12",
    ),
    comments: "Retargeted PR needs fixes.",
  });
  writeReviewResult(`/tmp/${taskId}`, {
    verdict: "changes_requested",
    body: "Retargeted PR needs fixes.",
  });
  built.github.setPrLightweightSnapshotByNumber(repoId, 12, {
    prNumber: 12,
    state: "open",
    headSha: "sha-12",
    baseSha: "base-dev",
    baseRef: "dev",
    mergeable: "mergeable",
    latestReview: {
      decision: "CHANGES_REQUESTED",
      latestReviewId: "R_retargeted_changes",
      comments: "Retargeted PR needs fixes.",
    },
    checks: {
      checkSha: "sha-12",
      items: [{ name: "build", workflow: null, bucket: "pass", required: true }],
    },
  });

  const results = await tick_once(built.deps, reviewerTickOptions());

  expect(results).toContainEqual({
    task_id: taskId,
    action: "review_respawn_scheduled",
  });
  expect(built.github.lightweightSnapshotByNumberCalls).toContainEqual({
    repoId,
    prNumber: 12,
  });
  const task = h.db
    .query<{ state: string; base_branch: string | null }, [string]>(
      `SELECT state, base_branch FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toEqual({ state: "queued", base_branch: "dev" });
  const latest = h.db
    .query<{ attempt_id: number; reason: string; consumed_budget: number }, [string]>(
      `SELECT attempt_id, reason, consumed_budget FROM attempts
        WHERE task_id = ? ORDER BY attempt_id DESC LIMIT 1`,
    )
    .get(taskId);
  expect(latest).toEqual({
    attempt_id: expect.any(Number),
    reason: "review",
    consumed_budget: 0,
  });
  const finalPromptRow = h.db
    .query<{ file_path: string }, [string, number]>(
      `SELECT file_path FROM artifacts
        WHERE task_id = ? AND attempt_id = ? AND kind = 'final_prompt'
        ORDER BY artifact_id DESC LIMIT 1`,
    )
    .get(taskId, latest!.attempt_id);
  expect(finalPromptRow).not.toBeNull();
  const finalPrompt = readFileSync(finalPromptRow!.file_path, "utf8");
  expect(finalPrompt).toContain('base-branch="dev"');
  expect(finalPrompt).toContain("The effective PR base branch is dev");
  expect(finalPrompt).not.toContain('base-branch="main"');
});

test("review after CHANGES_REQUESTED respawn gets reviewer-specific prompt", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-review-respawn-prompt");
  const taskId = insertTask(h.db, {
    repoId,
    taskId: "task-review-respawn-prompt",
    state: "pr-open",
  });
  seedTaskObjective(h, taskId, "original ticket context");
  const store = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });

  const initialAttemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
    spawnedAt: "2026-01-01T00:00:00.000Z",
  });
  store.writeArtifact({
    taskId,
    attemptId: initialAttemptId,
    kind: "brief",
    content: "original ticket context",
    extension: "md",
  });

  const reviewAttemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 2,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: "2026-01-01T00:05:00.000Z",
  });
  h.db
    .query(
      `UPDATE attempts
          SET head_sha = 'old-head',
              ended_at = '2026-01-01T00:06:00.000Z',
              review_verdict = 'changes_requested',
              review_id = 'R_changes'
        WHERE attempt_id = ?`,
    )
    .run(reviewAttemptId);
  const reviewCommentsArtifact = store.writeArtifact({
    taskId,
    attemptId: reviewAttemptId,
    kind: "review_comments",
    content: JSON.stringify({
      review_id: "R_changes",
      decision: "CHANGES_REQUESTED",
      head_sha: "old-head",
      body: "Blocking issue.",
      comments: "Blocking issue in src/fix.ts.",
    }),
    extension: "json",
  });

  const respawnAttemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 3,
    reason: "review",
    consumedBudget: 0,
    spawnedAt: "2026-01-01T00:07:00.000Z",
  });
  h.db
    .query(
      `UPDATE attempts
          SET remote_sha_at_spawn = 'old-head',
              remote_sha_at_exit = 'new-head',
              ended_at = '2026-01-01T00:08:00.000Z',
              exit_kind = 'pr_opened',
              diff_summary = ?
        WHERE attempt_id = ?`,
    )
    .run(
      JSON.stringify({
        files_changed: 1,
        insertions: 4,
        deletions: 1,
        files: [{ path: "src/fix.ts", status: "M", ins: 4, del: 1 }],
      }),
      respawnAttemptId,
    );
  store.writeArtifact({
    taskId,
    attemptId: respawnAttemptId,
    kind: "brief",
    content:
      "The pull request has new review feedback marked CHANGES_REQUESTED. Read the snapshotted comments, address each one, push the branch, and update the existing PR.",
    extension: "md",
  });
  h.db
    .query(
      `INSERT INTO events (
         task_id, attempt_id, event_type, from_state, to_state,
         payload_artifact_id, occurred_at
       ) VALUES (?, ?, 'changes_requested', 'pr-review', 'queued', ?, ?)`,
    )
    .run(taskId, respawnAttemptId, reviewCommentsArtifact.artifactId, h.clock.nowISO());

  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    prNumber: 11,
    prUrl: "https://example.test/pr/11",
    state: "open",
    headSha: "new-head",
    baseSha: "base-1",
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "new-head",
      items: [{ name: "build", workflow: null, bucket: "pass", required: true }],
    },
  });
  built.github.setPrView(repoId, 11, {
    number: 11,
    title: "Quay-owned respawn PR",
    body: "",
    url: "https://example.test/pr/11",
    headRefName: `quay/${taskId}`,
    headSha: "new-head",
  });

  const results = await tick_once(
    built.deps,
    reviewerTickOptions({ gateQuayOwnedDone: true }),
  );

  expect(results).toContainEqual({ task_id: taskId, action: "review_requested" });
  const reviewerAttempt = h.db
    .query<{ attempt_id: number }, [string]>(
      `SELECT attempt_id FROM attempts
        WHERE task_id = ? AND reason = 'review_only' AND head_sha = 'new-head'
        ORDER BY attempt_id DESC LIMIT 1`,
    )
    .get(taskId);
  expect(reviewerAttempt).not.toBeNull();
  const promptRow = h.db
    .query<{ file_path: string }, [string, number]>(
      `SELECT file_path FROM artifacts
        WHERE task_id = ? AND attempt_id = ? AND kind = 'final_prompt'
        ORDER BY artifact_id DESC LIMIT 1`,
    )
    .get(taskId, reviewerAttempt!.attempt_id);
  expect(promptRow).not.toBeNull();
  const prompt = readFileSync(promptRow!.file_path, "utf8");
  expect(prompt).toContain("# Quay reviewer respawn: review");
  expect(prompt).toContain(".quay-review-result.json");
  expect(prompt).not.toContain("gh pr review 11");
  expect(prompt).toContain("Blocking issue in src/fix.ts.");
  expect(prompt).toContain("Files changed: 1");
  expect(prompt).toContain("- M src/fix.ts (+4/-1)");
  expect(prompt).toContain("original ticket context");
  expect(prompt).not.toContain("address each one, push the branch");
});

test("review after conflict respawn does not reuse the worker conflict brief", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-conflict-review-prompt");
  const taskId = insertTask(h.db, {
    repoId,
    taskId: "task-conflict-review-prompt",
    state: "pr-open",
  });
  seedTaskObjective(h, taskId, "original ticket context for conflict repair");
  const store = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });

  const initialAttemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
    spawnedAt: "2026-01-01T00:00:00.000Z",
  });
  store.writeArtifact({
    taskId,
    attemptId: initialAttemptId,
    kind: "brief",
    content: "original ticket context for conflict repair",
    extension: "md",
  });

  const conflictAttemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 2,
    reason: "conflict",
    consumedBudget: 0,
    spawnedAt: "2026-01-01T00:05:00.000Z",
  });
  h.db
    .query(
      `UPDATE attempts
          SET remote_sha_at_spawn = 'conflicted-head',
              remote_sha_at_exit = 'conflict-fixed-head',
              ended_at = '2026-01-01T00:06:00.000Z',
              exit_kind = 'pr_opened',
              diff_summary = ?
        WHERE attempt_id = ?`,
    )
    .run(
      JSON.stringify({
        files_changed: 1,
        insertions: 5,
        deletions: 2,
        files: [{ path: "src/conflict.ts", status: "M", ins: 5, del: 2 }],
      }),
      conflictAttemptId,
    );
  store.writeArtifact({
    taskId,
    attemptId: conflictAttemptId,
    kind: "brief",
    content: [
      "# Quay non-budget respawn: conflict",
      "",
      "Pull the base, resolve the conflict, push the branch, and update the existing PR.",
      "Do not post a GitHub review.",
      "This is a worker fix attempt, not a reviewer attempt.",
    ].join("\n"),
    extension: "md",
  });

  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    prNumber: 12,
    prUrl: "https://example.test/pr/12",
    state: "open",
    headSha: "conflict-fixed-head",
    baseSha: "base-c2",
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "conflict-fixed-head",
      items: [{ name: "build", workflow: null, bucket: "pass", required: true }],
    },
  });
  built.github.setPrView(repoId, 12, {
    number: 12,
    title: "Quay-owned conflict repair PR",
    body: "",
    url: "https://example.test/pr/12",
    headRefName: `quay/${taskId}`,
    headSha: "conflict-fixed-head",
  });

  const results = await tick_once(
    built.deps,
    reviewerTickOptions({ gateQuayOwnedDone: true }),
  );

  expect(results).toContainEqual({ task_id: taskId, action: "review_requested" });
  const reviewerAttempt = h.db
    .query<{ attempt_id: number }, [string]>(
      `SELECT attempt_id FROM attempts
        WHERE task_id = ? AND reason = 'review_only' AND head_sha = 'conflict-fixed-head'
        ORDER BY attempt_id DESC LIMIT 1`,
    )
    .get(taskId);
  expect(reviewerAttempt).not.toBeNull();
  const promptRow = h.db
    .query<{ file_path: string }, [string, number]>(
      `SELECT file_path FROM artifacts
        WHERE task_id = ? AND attempt_id = ? AND kind = 'final_prompt'
        ORDER BY artifact_id DESC LIMIT 1`,
    )
    .get(taskId, reviewerAttempt!.attempt_id);
  expect(promptRow).not.toBeNull();
  const prompt = readFileSync(promptRow!.file_path, "utf8");
  expect(prompt).toContain("# Quay reviewer: review");
  expect(prompt).toContain(".quay-review-result.json");
  expect(prompt).not.toContain("gh pr review 12");
  expect(prompt).toContain("Head SHA: conflict-fixed-head");
  expect(prompt).toContain("Base SHA: base-c2");
  expect(prompt).toContain("Files changed: 1");
  expect(prompt).toContain("- M src/conflict.ts (+5/-2)");
  expect(prompt).toContain("original ticket context for conflict repair");

  const forbidden = [
    "push the branch",
    "update the existing PR",
    "This is a worker fix attempt",
  ];
  for (const phrase of forbidden) {
    expect(prompt).not.toContain(phrase);
  }

  const spawnResults = await tick_once(
    built.deps,
    reviewerTickOptions({ gateQuayOwnedDone: true }),
  );
  expect(spawnResults).toContainEqual({ task_id: taskId, action: "spawned" });
  const session = built.tmux.spawnCalls.at(-1)!.sessionName;
  built.tmux.markDead(session);

  const retryResults = await tick_once(
    built.deps,
    reviewerTickOptions({ gateQuayOwnedDone: true }),
  );
  expect(retryResults).toContainEqual({
    task_id: taskId,
    action: "review_retry_scheduled",
  });
  const retryAttempt = h.db
    .query<{ attempt_id: number }, [string]>(
      `SELECT attempt_id FROM attempts
        WHERE task_id = ? AND reason = 'review_only' AND spawned_at IS NULL
        ORDER BY attempt_id DESC LIMIT 1`,
    )
    .get(taskId);
  expect(retryAttempt).not.toBeNull();
  const retryPromptRow = h.db
    .query<{ file_path: string }, [string, number]>(
      `SELECT file_path FROM artifacts
        WHERE task_id = ? AND attempt_id = ? AND kind = 'final_prompt'
        ORDER BY artifact_id DESC LIMIT 1`,
    )
    .get(taskId, retryAttempt!.attempt_id);
  expect(retryPromptRow).not.toBeNull();
  const retryPrompt = readFileSync(retryPromptRow!.file_path, "utf8");
  expect(retryPrompt).toContain(".quay-review-result.json");
  expect(retryPrompt).not.toContain("gh pr review 12");
  for (const phrase of forbidden) {
    expect(retryPrompt).not.toContain(phrase);
  }
});

test("reviewer infrastructure failures retry twice then park at same SHA", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-review-fail");
  const taskId = "pr-review-repo-review-fail-9";
  const worktreePath = `${h.dataDir}/worktrees/review-9`;
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(
    join(worktreePath, ".quay-usage.json"),
    JSON.stringify({ model: "claude-test", usage: { output_tokens: 7 } }),
  );
  writeFileSync(
    join(worktreePath, ".quay-tool-trace.log"),
    "reviewer failure trace\n",
  );
  h.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, state, branch_name, tmux_id, worktree_path,
         pr_number, head_sha, retry_budget, review_infra_failures_consecutive,
         review_infra_failure_head_sha, created_at, updated_at
       ) VALUES (?, ?, 'pr-review', 'quay-review/9', 'quay-review-repo-review-fail-9',
                 ?, 9, 'sha-9', 1, 2, 'sha-9', ?, ?)`,
    )
    .run(taskId, repoId, worktreePath, h.clock.nowISO(), h.clock.nowISO());
  seedTaskObjective(h, taskId);
  const attemptId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: h.clock.nowISO(),
  });
  h.db
    .query(
      `UPDATE attempts
          SET head_sha = 'sha-9', tmux_session = 'quay-review-session-9'
        WHERE attempt_id = ?`,
    )
    .run(attemptId);
  const store = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });
  store.writeArtifact({
    taskId,
    attemptId,
    kind: "brief",
    content: "review brief",
    extension: "md",
  });
  store.writeArtifact({
    taskId,
    attemptId,
    kind: "final_prompt",
    content: "review prompt",
    extension: "md",
  });

  const results = await tick_once(built.deps, reviewerTickOptions());

  expect(results).toContainEqual({
    task_id: taskId,
    action: "non_budget_loop_parked",
  });
  const task = h.db
    .query<
      { state: string; review_infra_failures_consecutive: number; tick_error: string | null },
      [string]
    >(
      `SELECT state, review_infra_failures_consecutive, tick_error
         FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task?.state).toBe("non_budget_loop");
  expect(task?.review_infra_failures_consecutive).toBe(3);
  expect(task?.tick_error).toContain("reviewer did not write .quay-review-result.json");
  const pending = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM attempts
        WHERE task_id = ? AND reason = 'review_only' AND ended_at IS NULL`,
    )
    .get(taskId);
  expect(pending?.n).toBe(0);
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
});

test("reviewer blocker with stale task PR and worktree heads records review context drift", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-review-context-drift");
  const taskId = "pr-review-repo-review-context-drift-1048";
  const worktreePath = `${h.dataDir}/worktrees/review-context-drift-1048`;
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(
    join(worktreePath, ".quay-blocked.md"),
    [
      "Cannot review because stored task head, GitHub PR head, and local worktree HEAD disagree.",
      "Stored task head: stored-head",
      "GitHub PR head: live-pr-head",
      "Local worktree HEAD: local-worktree-head",
    ].join("\n"),
  );
  h.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, state, branch_name, tmux_id, worktree_path,
         pr_number, head_sha, retry_budget, review_infra_failures_consecutive,
         review_infra_failure_head_sha, created_at, updated_at
       ) VALUES (?, ?, 'pr-review', 'quay-review/1048',
                 'quay-review-repo-review-context-drift-1048',
                 ?, 1048, 'stored-head', 1, 2, 'stored-head', ?, ?)`,
    )
    .run(taskId, repoId, worktreePath, h.clock.nowISO(), h.clock.nowISO());
  seedTaskObjective(h, taskId);
  const attemptId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: h.clock.nowISO(),
  });
  h.db
    .query(
      `UPDATE attempts
          SET head_sha = 'stored-head',
              tmux_session = 'quay-review-context-drift-session'
        WHERE attempt_id = ?`,
    )
    .run(attemptId);
  const store = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });
  store.writeArtifact({
    taskId,
    attemptId,
    kind: "brief",
    content: "review brief",
    extension: "md",
  });
  store.writeArtifact({
    taskId,
    attemptId,
    kind: "final_prompt",
    content: "review prompt",
    extension: "md",
  });
  built.github.setPrLightweightSnapshotByNumber(repoId, 1048, {
    state: "open",
    headSha: "live-pr-head",
    baseSha: "base-head",
    mergeable: "unknown",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: { checkSha: null, items: [] },
  });
  built.git.setWorktreeHeadSha(worktreePath, "local-worktree-head");

  const results = await tick_once(built.deps, reviewerTickOptions());

  expect(results).toContainEqual({
    task_id: taskId,
    action: "review_context_drift",
  });
  const task = h.db
    .query<
      {
        state: string;
        review_infra_failures_consecutive: number;
        review_infra_failure_head_sha: string | null;
        tick_error: string | null;
      },
      [string]
    >(
      `SELECT state, review_infra_failures_consecutive,
              review_infra_failure_head_sha, tick_error
         FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toMatchObject({
    state: "pr-review",
    review_infra_failures_consecutive: 2,
    review_infra_failure_head_sha: "stored-head",
  });
  expect(task?.tick_error).toContain("Review context drift detected");
  expect(task?.tick_error).toContain("Stored task head: stored-head");
  expect(task?.tick_error).toContain("Live PR head: live-pr-head");
  expect(task?.tick_error).toContain("Local review worktree HEAD: local-worktree-head");

  const attempts = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM attempts
        WHERE task_id = ? AND reason = 'review_only'`,
    )
    .get(taskId);
  expect(attempts?.n).toBe(1);
  const event = h.db
    .query<{ event_type: string; to_state: string; payload_artifact_id: number | null }, [string]>(
      `SELECT event_type, to_state, payload_artifact_id
         FROM events
        WHERE task_id = ? AND event_type = 'review_context_drift'
        ORDER BY event_id DESC LIMIT 1`,
    )
    .get(taskId);
  expect(event).toEqual({
    event_type: "review_context_drift",
    to_state: "pr-review",
    payload_artifact_id: expect.any(Number),
  });
  const attempt = h.db
    .query<{ exit_kind: string | null; review_verdict: string | null }, [number]>(
      `SELECT exit_kind, review_verdict FROM attempts WHERE attempt_id = ?`,
    )
    .get(attemptId);
  expect(attempt).toEqual({
    exit_kind: "review_context_drift",
    review_verdict: "errored",
  });
});

test("reviewer blocker is preserved when drift probe fails before classification", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-review-context-drift-probe-fails");
  const taskId = "pr-review-repo-review-context-drift-probe-fails-1048";
  const worktreePath = `${h.dataDir}/worktrees/review-context-drift-probe-fails-1048`;
  mkdirSync(worktreePath, { recursive: true });
  const blockerPath = join(worktreePath, ".quay-blocked.md");
  writeFileSync(
    blockerPath,
    [
      "Cannot review because stored task head, GitHub PR head, and local worktree HEAD disagree.",
      "Stored task head: stored-head",
      "GitHub PR head: live-pr-head",
      "Local worktree HEAD: local-worktree-head",
    ].join("\n"),
  );
  h.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, state, branch_name, tmux_id, worktree_path,
         pr_number, head_sha, retry_budget, review_infra_failures_consecutive,
         review_infra_failure_head_sha, created_at, updated_at
       ) VALUES (?, ?, 'pr-review', 'quay-review/1048',
                 'quay-review-repo-review-context-drift-probe-fails-1048',
                 ?, 1048, 'stored-head', 1, 2, 'stored-head', ?, ?)`,
    )
    .run(taskId, repoId, worktreePath, h.clock.nowISO(), h.clock.nowISO());
  seedTaskObjective(h, taskId);
  const attemptId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: h.clock.nowISO(),
  });
  h.db
    .query(
      `UPDATE attempts
          SET head_sha = 'stored-head',
              tmux_session = 'quay-review-context-drift-probe-fails-session'
        WHERE attempt_id = ?`,
    )
    .run(attemptId);
  const store = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });
  store.writeArtifact({
    taskId,
    attemptId,
    kind: "brief",
    content: "review brief",
    extension: "md",
  });
  store.writeArtifact({
    taskId,
    attemptId,
    kind: "final_prompt",
    content: "review prompt",
    extension: "md",
  });
  built.github.setPrLightweightSnapshotByNumber(repoId, 1048, {
    state: "open",
    headSha: "live-pr-head",
    baseSha: "base-head",
    mergeable: "unknown",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: { checkSha: null, items: [] },
  });
  built.git.fail.worktreeHeadSha = (path) => path === worktreePath;

  const failedProbe = await tick_once(built.deps, reviewerTickOptions());

  expect(failedProbe).toContainEqual(
    expect.objectContaining({
      task_id: taskId,
      action: "tick_error",
      error: expect.stringContaining("worktreeHeadSha failed"),
    }),
  );
  expect(existsSync(blockerPath)).toBe(true);
  let task = h.db
    .query<
      {
        state: string;
        review_infra_failures_consecutive: number;
        review_infra_failure_head_sha: string | null;
      },
      [string]
    >(
      `SELECT state, review_infra_failures_consecutive,
              review_infra_failure_head_sha
         FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toEqual({
    state: "pr-review",
    review_infra_failures_consecutive: 2,
    review_infra_failure_head_sha: "stored-head",
  });

  delete built.git.fail.worktreeHeadSha;
  built.git.setWorktreeHeadSha(worktreePath, "local-worktree-head");

  const retriedProbe = await tick_once(built.deps, reviewerTickOptions());

  expect(retriedProbe).toContainEqual({
    task_id: taskId,
    action: "review_context_drift",
  });
  expect(existsSync(blockerPath)).toBe(false);
  task = h.db
    .query<
      {
        state: string;
        review_infra_failures_consecutive: number;
        review_infra_failure_head_sha: string | null;
      },
      [string]
    >(
      `SELECT state, review_infra_failures_consecutive,
              review_infra_failure_head_sha
         FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toEqual({
    state: "pr-review",
    review_infra_failures_consecutive: 2,
    review_infra_failure_head_sha: "stored-head",
  });
});

test("malformed reviewer result parks as reviewer infrastructure failure", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-review-malformed-result");
  const taskId = "pr-review-repo-review-malformed-result-9";
  const worktreePath = `${h.dataDir}/worktrees/review-malformed-result-9`;
  mkdirSync(worktreePath, { recursive: true });
  writeFileSync(
    join(worktreePath, ".quay-review-result.json"),
    JSON.stringify({ verdict: "commented", body: "", findings: "nope" }),
  );
  h.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, state, branch_name, tmux_id, worktree_path,
         pr_number, head_sha, retry_budget, review_infra_failures_consecutive,
         review_infra_failure_head_sha, created_at, updated_at
       ) VALUES (?, ?, 'pr-review', 'quay-review/9', 'quay-review-repo-review-malformed-result-9',
                 ?, 9, 'sha-9', 1, 2, 'sha-9', ?, ?)`,
    )
    .run(taskId, repoId, worktreePath, h.clock.nowISO(), h.clock.nowISO());
  seedTaskObjective(h, taskId);
  const attemptId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: h.clock.nowISO(),
  });
  h.db
    .query(
      `UPDATE attempts
          SET head_sha = 'sha-9', tmux_session = 'quay-review-session-9'
        WHERE attempt_id = ?`,
    )
    .run(attemptId);
  const store = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });
  store.writeArtifact({
    taskId,
    attemptId,
    kind: "brief",
    content: "review brief",
    extension: "md",
  });
  store.writeArtifact({
    taskId,
    attemptId,
    kind: "final_prompt",
    content: "review prompt",
    extension: "md",
  });

  const results = await tick_once(built.deps, reviewerTickOptions());

  expect(results).toContainEqual({
    task_id: taskId,
    action: "non_budget_loop_parked",
  });
  const task = h.db
    .query<{ state: string; tick_error: string | null }, [string]>(
      `SELECT state, tick_error FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task?.state).toBe("non_budget_loop");
  expect(task?.tick_error).toContain(".quay-review-result.json is malformed");
  const rawResultArtifacts = h.db
    .query<{ n: number }, [string, number]>(
      `SELECT COUNT(*) AS n FROM artifacts
        WHERE task_id = ? AND attempt_id = ? AND kind = 'review_result'`,
    )
    .get(taskId, attemptId);
  expect(rawResultArtifacts?.n).toBe(1);
});

test("live stale reviewer is killed then retried on the same head", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-review-stale-live");
  const taskId = "pr-review-repo-review-stale-live-14";
  const sessionName = "quay-review-stale-live";
  const { attemptId } = seedRunningReviewAttempt(h, {
    repoId,
    taskId,
    prNumber: 14,
    headSha: "sha-stale-live",
    sessionName,
    spawnedAt: "2026-01-01T00:00:00.000Z",
  });
  built.tmux.liveSessions.add(sessionName);
  built.tmux.setLogFreshness(sessionName, "2026-01-01T00:00:00.000Z");
  h.clock.set("2026-01-01T00:11:00.000Z");

  const killResults = await tick_once(
    built.deps,
    reviewerTickOptions({ stalenessThresholdSeconds: 600 }),
  );

  expect(killResults).toContainEqual({
    task_id: taskId,
    action: "kill_intent_set",
  });
  expect(built.tmux.killCalls).toContain(sessionName);
  const killedAttempt = h.db
    .query<
      { kill_intent: string | null; ended_at: string | null },
      [number]
    >(
      `SELECT kill_intent, ended_at FROM attempts WHERE attempt_id = ?`,
    )
    .get(attemptId);
  expect(killedAttempt).toEqual({ kill_intent: "stale", ended_at: null });

  const retryResults = await tick_once(
    built.deps,
    reviewerTickOptions({ stalenessThresholdSeconds: 600 }),
  );

  expect(retryResults).toContainEqual({
    task_id: taskId,
    action: "review_retry_scheduled",
  });
  const prior = h.db
    .query<
      {
        ended_at: string | null;
        exit_kind: string | null;
        review_verdict: string | null;
        kill_intent: string | null;
      },
      [number]
    >(
      `SELECT ended_at, exit_kind, review_verdict, kill_intent
         FROM attempts WHERE attempt_id = ?`,
    )
    .get(attemptId);
  expect(prior?.ended_at).not.toBeNull();
  expect(prior).toMatchObject({
    exit_kind: "review_errored",
    review_verdict: "errored",
    kill_intent: "stale",
  });
  const retry = h.db
    .query<
      { head_sha: string | null; spawned_at: string | null; ended_at: string | null },
      [string]
    >(
      `SELECT head_sha, spawned_at, ended_at
         FROM attempts
        WHERE task_id = ? AND reason = 'review_only'
        ORDER BY attempt_id DESC
        LIMIT 1`,
    )
    .get(taskId);
  expect(retry).toEqual({
    head_sha: "sha-stale-live",
    spawned_at: null,
    ended_at: null,
  });
  const runningReviewers = h.db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM attempts
        WHERE reason = 'review_only'
          AND spawned_at IS NOT NULL
          AND ended_at IS NULL`,
    )
    .get();
  expect(runningReviewers?.n).toBe(0);
});

test("live reviewer over wall-clock limit gets a kill intent", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-review-wall-clock-live");
  const taskId = "pr-review-repo-review-wall-clock-live-15";
  const sessionName = "quay-review-wall-clock-live";
  const { attemptId } = seedRunningReviewAttempt(h, {
    repoId,
    taskId,
    prNumber: 15,
    headSha: "sha-wall-clock-live",
    sessionName,
    spawnedAt: "2026-01-01T00:00:00.000Z",
  });
  built.tmux.liveSessions.add(sessionName);
  built.tmux.setLogFreshness(sessionName, "2026-01-01T00:01:30.000Z");
  h.clock.set("2026-01-01T00:02:01.000Z");

  const results = await tick_once(
    built.deps,
    reviewerTickOptions({
      maxAttemptDurationSeconds: 120,
      stalenessThresholdSeconds: 600,
    }),
  );

  expect(results).toContainEqual({
    task_id: taskId,
    action: "kill_intent_set",
  });
  expect(built.tmux.killCalls).toContain(sessionName);
  const attempt = h.db
    .query<{ kill_intent: string | null; ended_at: string | null }, [number]>(
      `SELECT kill_intent, ended_at FROM attempts WHERE attempt_id = ?`,
    )
    .get(attemptId);
  expect(attempt).toEqual({ kill_intent: "wall_clock", ended_at: null });
});

test("dead reviewer leaving .quay-blocked.md retries once and records a single review_blocker artifact", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-review-blocker");
  const taskId = "pr-review-repo-review-blocker-12";
  const worktreePath = `${h.dataDir}/worktrees/review-12`;
  mkdirSync(worktreePath, { recursive: true });
  const blockerContent =
    "Reviewer cannot post a verdict: spec is ambiguous on retry semantics.";
  writeFileSync(join(worktreePath, ".quay-blocked.md"), blockerContent);
  h.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, state, branch_name, tmux_id, worktree_path,
         pr_number, head_sha, retry_budget, created_at, updated_at
       ) VALUES (?, ?, 'pr-review', 'quay-review/12', 'quay-review-repo-review-blocker-12',
                 ?, 12, 'sha-12', 1, ?, ?)`,
    )
    .run(taskId, repoId, worktreePath, h.clock.nowISO(), h.clock.nowISO());
  seedTaskObjective(h, taskId);
  const attemptId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: h.clock.nowISO(),
  });
  h.db
    .query(
      `UPDATE attempts
          SET head_sha = 'sha-12', tmux_session = 'quay-review-session-12'
        WHERE attempt_id = ?`,
    )
    .run(attemptId);
  // Reviewer tmux is dead: deliberately not added to FakeTmux.liveSessions.

  const results = await tick_once(built.deps, reviewerTickOptions());

  expect(results).toContainEqual({
    task_id: taskId,
    action: "review_retry_scheduled",
  });
  expect(existsSync(join(worktreePath, ".quay-blocked.md"))).toBe(false);

  const blockerArtifacts = h.db
    .query<{ kind: string; file_path: string }, [string, number]>(
      `SELECT kind, file_path FROM artifacts
        WHERE task_id = ? AND attempt_id = ? AND kind = 'review_blocker'`,
    )
    .all(taskId, attemptId);
  expect(blockerArtifacts).toHaveLength(1);

  const tickErrors = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM events
        WHERE task_id = ? AND event_type = 'tick_error'`,
    )
    .get(taskId);
  expect(tickErrors?.n).toBe(0);

  const task = h.db
    .query<{ state: string; tick_error: string | null }, [string]>(
      `SELECT state, tick_error FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toEqual({ state: "pr-review", tick_error: null });
});

test("tick reaps a superseded reviewer whose tmux outlived enterReview's commit", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-reap");
  const taskId = insertTask(h.db, {
    repoId,
    taskId: "pr-review-repo-reap-7",
    state: "pr-review",
  });
  seedTaskObjective(h, taskId);
  h.db
    .query(`UPDATE tasks SET pr_number = 7, head_sha = 'new-sha' WHERE task_id = ?`)
    .run(taskId);

  // Fake the state enterReview leaves behind after COMMIT but before its
  // own tmux.kill: attempt is ended + kill_intent='superseded', yet the
  // tmux session is still alive in the substrate.
  const supersededId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: "2026-01-01T00:00:00.000Z",
  });
  h.db
    .query(
      `UPDATE attempts
         SET head_sha = 'old-sha',
             tmux_session = 'quay-review-orphan',
             ended_at = '2026-01-01T00:00:01.000Z',
             review_verdict = 'superseded',
             kill_intent = 'superseded'
       WHERE attempt_id = ?`,
    )
    .run(supersededId);
  built.tmux.liveSessions.add("quay-review-orphan");

  await tick_once(built.deps, reviewerTickOptions());

  expect(built.tmux.killCalls).toContain("quay-review-orphan");
  expect(built.tmux.liveSessions.has("quay-review-orphan")).toBe(false);
});

test("tick reaper skips a dead session and does not call kill twice", async () => {
  h = createHarness();
  const built = buildTickDeps(h);
  const repoId = insertRepo(h.db, "repo-reap-idem");
  const taskId = insertTask(h.db, {
    repoId,
    taskId: "pr-review-repo-reap-idem-8",
    state: "pr-review",
  });
  seedTaskObjective(h, taskId);
  h.db
    .query(`UPDATE tasks SET pr_number = 8, head_sha = 'new-sha' WHERE task_id = ?`)
    .run(taskId);
  const supersededId = insertAttempt(h.db, {
    taskId,
    reason: "review_only",
    consumedBudget: 0,
    spawnedAt: "2026-01-01T00:00:00.000Z",
  });
  h.db
    .query(
      `UPDATE attempts
         SET head_sha = 'old-sha',
             tmux_session = 'quay-review-already-dead',
             ended_at = '2026-01-01T00:00:01.000Z',
             review_verdict = 'superseded',
             kill_intent = 'superseded'
       WHERE attempt_id = ?`,
    )
    .run(supersededId);
  // Session intentionally NOT added to liveSessions.

  await tick_once(built.deps, reviewerTickOptions());
  expect(built.tmux.killCalls).not.toContain("quay-review-already-dead");
});
