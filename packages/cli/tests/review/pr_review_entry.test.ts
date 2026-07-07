import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";
import { createAgentResolver } from "../../src/core/agents.ts";
import { REVIEW_RESULT_PROTOCOL_MARKER } from "../../src/core/preamble.ts";
import type { SupervisorLock } from "../../src/core/supervisor_lock.ts";
import { WORKER_GH_TOKEN_ENV, tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { buildCliDeps } from "../support/cli_deps.ts";
import {
  insertAttempt,
  insertPreamble,
  insertRepo,
  insertTask,
} from "../support/fixtures.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("review-pr creates a synthetic pr-review task and deduped review attempt", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  built.deps.tickOptions = { reviewerEnabled: true };
  await dispatch(
    [
      "repo",
      "add",
      "--id",
      "quay",
      "--url",
      "git@github.com:acc/quay.git",
      "--base-branch",
      "main",
      "--package-manager",
      "bun",
      "--install-cmd",
      "true",
    ],
    built.deps,
    bufferIO(),
  );
  built.github.setPrView("quay", 47, {
    number: 47,
    title: "Human PR",
    body: "Please review",
    url: "https://github.com/acc/quay/pull/47",
    headRefName: "feature/human",
    headSha: "abc123",
  });

  const io = bufferIO();
  const result = await dispatch(
    ["review-pr", "--pr", "acc/quay:47", "--tag", "team-api", "--tag", "team-api"],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");
  const out = JSON.parse(io.out());
  expect(out.scheduled).toBe(true);
  expect(out.task_id).toBe("pr-review-quay-47");
  expect(out.state).toBe("pr-review");

  const attempt = h.db
    .query<{ reason: string; head_sha: string | null }, [number]>(
      `SELECT reason, head_sha FROM attempts WHERE attempt_id = ?`,
    )
    .get(out.attempt_id);
  expect(attempt).toEqual({ reason: "review_only", head_sha: "abc123" });
  const briefRow = h.db
    .query<{ file_path: string }, [number]>(
      `SELECT file_path FROM artifacts
        WHERE attempt_id = ? AND kind = 'brief'`,
    )
    .get(out.attempt_id);
  expect(briefRow).toBeDefined();
  const brief = readFileSync(briefRow!.file_path, "utf8");
  expect(brief).toContain("## Required action");
  expect(brief).toContain(".quay-review-result.json");
  expect(brief).toContain("Do not post a GitHub review");
  expect(brief).not.toContain("post the review directly");
  expect(brief).toContain("## Verdict policy");
  expect(brief).toContain("This is not a Quay-owned task.");
  expect(brief).toContain(
    "Non-blocking-only findings -> `approved` with the findings listed under `### Non-blocking`.",
  );
  expect(brief).not.toContain(
    "Non-blocking-only findings -> `changes_requested`",
  );
  const promptRow = h.db
    .query<{ file_path: string }, [number]>(
      `SELECT file_path FROM artifacts
        WHERE attempt_id = ? AND kind = 'final_prompt'`,
    )
    .get(out.attempt_id);
  expect(promptRow).toBeDefined();
  const finalPrompt = readFileSync(promptRow!.file_path, "utf8");
  expect(finalPrompt).toContain(".quay-review-result.json");
  expect(finalPrompt).toContain("Do not call `gh pr review`");
  expect(finalPrompt).toContain("Do not post a GitHub review");
  const tags = h.db
    .query<{ tag: string }, [string]>(
      `SELECT tag FROM task_tags WHERE task_id = ? ORDER BY tag`,
    )
    .all(out.task_id)
    .map((r) => r.tag);
  expect(tags).toEqual(["team-api"]);

  const io2 = bufferIO();
  const second = await dispatch(
    ["review-pr", "--pr", "acc/quay:47"],
    built.deps,
    io2,
  );
  expect(second.exitCode).toBe(0);
  const out2 = JSON.parse(io2.out());
  expect(out2.scheduled).toBe(false);
  expect(out2.skipped_reason).toBe("active_attempt_exists");
  expect(out2.attempt_id).toBe(out.attempt_id);
});

test("review-pr final prompt layers static protocol over repo reviewer guidance", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  built.deps.tickOptions = { reviewerEnabled: true };
  const repoId = insertRepo(h.db, "repo-review-guidance");
  const guidanceId = insertPreamble(
    h.db,
    "Custom reviewer guidance: focus on auth boundary changes.",
    "review",
  );
  h.db
    .query(`UPDATE repos SET preamble_reviewer = ? WHERE repo_id = ?`)
    .run(guidanceId, repoId);
  built.github.setPrView(repoId, 48, {
    number: 48,
    title: "Human PR",
    body: "Please review auth changes",
    url: "https://github.com/acc/repo-review-guidance/pull/48",
    headRefName: "feature/auth",
    headSha: "def456",
  });

  const io = bufferIO();
  const result = await dispatch(
    ["review-pr", "--pr", `${repoId}:48`],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  const out = JSON.parse(io.out());
  const promptRow = h.db
    .query<{ file_path: string }, [number]>(
      `SELECT file_path FROM artifacts
        WHERE attempt_id = ? AND kind = 'final_prompt'`,
    )
    .get(out.attempt_id);
  expect(promptRow).toBeDefined();
  const finalPrompt = readFileSync(promptRow!.file_path, "utf8");
  expect(finalPrompt).toContain(REVIEW_RESULT_PROTOCOL_MARKER);
  expect(finalPrompt).toContain(".quay-review-result.json");
  expect(finalPrompt).toContain("Do not call `gh pr review`");
  expect(finalPrompt).toContain("Custom reviewer guidance");
  expect(finalPrompt.indexOf(REVIEW_RESULT_PROTOCOL_MARKER)).toBeLessThan(
    finalPrompt.indexOf("Custom reviewer guidance"),
  );
});

test("review-pr rejects repo reviewer guidance with direct-post instructions", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  built.deps.tickOptions = { reviewerEnabled: true };
  const repoId = insertRepo(h.db, "repo-stale-review-guidance");
  const guidanceId = insertPreamble(
    h.db,
    "Post the review directly to GitHub via `gh pr review`.",
    "review",
  );
  h.db
    .query(`UPDATE repos SET preamble_reviewer = ? WHERE repo_id = ?`)
    .run(guidanceId, repoId);
  built.github.setPrView(repoId, 49, {
    number: 49,
    title: "Human PR",
    body: "Please review",
    url: "https://github.com/acc/repo-stale-review-guidance/pull/49",
    headRefName: "feature/stale-guidance",
    headSha: "stale456",
  });

  const io = bufferIO();
  const result = await dispatch(
    ["review-pr", "--pr", `${repoId}:49`],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(4);
  expect(JSON.parse(io.err()).message).toContain(
    "conflict with the static reviewer protocol",
  );
  expect(
    h.db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'final_prompt'`,
      )
      .get()!.n,
  ).toBe(0);
});

test("review-pr reconciles a stale caller head to the current PR head", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  built.deps.tickOptions = { reviewerEnabled: true };
  await dispatch(
    [
      "repo",
      "add",
      "--id",
      "quay",
      "--url",
      "git@github.com:acc/quay.git",
      "--base-branch",
      "main",
      "--package-manager",
      "bun",
      "--install-cmd",
      "true",
    ],
    built.deps,
    bufferIO(),
  );
  built.github.setPrView("quay", 48, {
    number: 48,
    title: "Moved PR",
    body: "Please review",
    url: "https://github.com/acc/quay/pull/48",
    headRefName: "feature/moved",
    headSha: "sha-current",
  });

  const io = bufferIO();
  const result = await dispatch(
    ["review-pr", "--pr", "acc/quay:48", "--head-sha", "sha-stale"],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  const out = JSON.parse(io.out());
  expect(out.scheduled).toBe(true);
  const task = h.db
    .query<{ head_sha: string | null }, [string]>(
      `SELECT head_sha FROM tasks WHERE task_id = ?`,
    )
    .get(out.task_id);
  expect(task?.head_sha).toBe("sha-current");
  const attempt = h.db
    .query<{ head_sha: string | null }, [number]>(
      `SELECT head_sha FROM attempts WHERE attempt_id = ?`,
    )
    .get(out.attempt_id);
  expect(attempt?.head_sha).toBe("sha-current");
});

test("review-pr does not schedule when CI evidence belongs to a newer PR head", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  built.deps.tickOptions = { reviewerEnabled: true };
  await dispatch(
    [
      "repo",
      "add",
      "--id",
      "quay",
      "--url",
      "git@github.com:acc/quay.git",
      "--base-branch",
      "main",
      "--package-manager",
      "bun",
      "--install-cmd",
      "true",
    ],
    built.deps,
    bufferIO(),
  );
  built.github.setPrView("quay", 49, {
    number: 49,
    title: "Raced PR",
    body: "Please review",
    url: "https://github.com/acc/quay/pull/49",
    headRefName: "feature/raced",
    headSha: "sha-selected",
  });
  built.github.setPrSnapshotByNumber("quay", 49, {
    prNumber: 49,
    state: "open",
    headSha: "sha-newer",
    baseSha: "base-49",
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "sha-newer",
      items: [{ name: "build", workflow: null, bucket: "pass", required: true }],
    },
  });

  const io = bufferIO();
  const result = await dispatch(
    ["review-pr", "--pr", "acc/quay:49"],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");
  const out = JSON.parse(io.out());
  expect(out.scheduled).toBe(false);
  expect(out.pending_ci).toBe(true);
  expect(out.attempt_id).toBeNull();
  const task = h.db
    .query<{ head_sha: string | null }, [string]>(
      `SELECT head_sha FROM tasks WHERE task_id = ?`,
    )
    .get(out.task_id);
  expect(task?.head_sha).toBe("sha-selected");
  const requests = h.db
    .query<{ head_sha: string; status: string }, [string]>(
      `SELECT head_sha, status FROM review_requests WHERE task_id = ?`,
    )
    .all(out.task_id);
  expect(requests).toEqual([{ head_sha: "sha-selected", status: "pending_ci" }]);
  const attemptCount = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM attempts WHERE task_id = ?`,
    )
    .get(out.task_id);
  expect(attemptCount?.n).toBe(0);
});

test("adopt-pr creates a mutable code-worker attempt for same-repo human PR", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await dispatch(
    [
      "repo",
      "add",
      "--id",
      "quay",
      "--url",
      "git@github.com:acc/quay.git",
      "--base-branch",
      "main",
      "--package-manager",
      "bun",
      "--install-cmd",
      "bun install",
    ],
    built.deps,
    bufferIO(),
  );
  built.git.seedBareClone("quay");
  built.github.setPrView("quay", 51, {
    number: 51,
    title: "Human PR to adopt",
    body: "Please let Quay finish this.",
    url: "https://github.com/acc/quay/pull/51",
    headRefName: "feature/human-adopt",
    headSha: "head-51",
    baseRef: "dev",
    isCrossRepository: false,
  });
  built.github.setPrSnapshotByNumber("quay", 51, {
    prNumber: 51,
    prUrl: "https://github.com/acc/quay/pull/51",
    state: "open",
    headSha: "head-51",
    baseSha: "base-51",
    baseRef: "dev",
    mergeable: "mergeable",
    latestReview: {
      decision: "CHANGES_REQUESTED",
      latestReviewId: "R_current",
      submittedHeadSha: "head-51",
      comments: "Please fix the current head.",
    },
    checks: { checkSha: "head-51", items: [] },
  });

  const originalLock = built.deps.supervisorLock;
  let lockRunCount = 0;
  const recordingLock: SupervisorLock = {
    async run(fn) {
      lockRunCount++;
      return await fn();
    },
    tryRun(fn) {
      return originalLock.tryRun(fn);
    },
  };
  built.deps.supervisorLock = recordingLock;

  const io = bufferIO();
  const result = await dispatch(["adopt-pr", "--pr", "acc/quay:51"], built.deps, io);

  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");
  expect(lockRunCount).toBe(1);
  built.deps.supervisorLock = originalLock;
  const out = JSON.parse(io.out());
  expect(out).toMatchObject({
    task_id: "pr-review-quay-51",
    state: "queued",
    adopted: true,
    scheduled: true,
  });

  const task = h.db
    .query<
      {
        state: string;
        authoring_mode: string;
        branch_name: string;
        base_branch: string | null;
        pr_number: number | null;
        head_sha: string | null;
      },
      [string]
    >(
      `SELECT state, authoring_mode, branch_name, base_branch, pr_number, head_sha
         FROM tasks WHERE task_id = ?`,
    )
    .get(out.task_id);
  expect(task).toEqual({
    state: "queued",
    authoring_mode: "adopted_external_pr",
    branch_name: "feature/human-adopt",
    base_branch: "dev",
    pr_number: 51,
    head_sha: "head-51",
  });
  const attempt = h.db
    .query<{ reason: string; consumed_budget: number; spawned_at: string | null }, [number]>(
      `SELECT reason, consumed_budget, spawned_at FROM attempts WHERE attempt_id = ?`,
    )
    .get(out.attempt_id);
  expect(attempt).toEqual({
    reason: "adopt_pr",
    consumed_budget: 1,
    spawned_at: null,
  });
  expect(
    built.git.calls.some(
      (c) =>
        c.op === "worktreeAddExistingBranch" &&
        c.args.branch === "feature/human-adopt" &&
        c.args.baseRef === "origin/feature/human-adopt",
    ),
  ).toBe(true);
  expect(built.commandRunner.calls).toEqual([
    {
      command: "bun install",
      cwd: `${built.worktreesRoot}/quay-review/quay/51`,
    },
  ]);

  const promptRow = h.db
    .query<{ file_path: string }, [number]>(
      `SELECT file_path FROM artifacts
        WHERE attempt_id = ? AND kind = 'final_prompt'`,
    )
    .get(out.attempt_id);
  expect(promptRow).toBeDefined();
  const prompt = readFileSync(promptRow!.file_path, "utf8");
  expect(prompt).toContain("Update the existing PR #51");
  expect(prompt).toContain("Do not create another pull request.");
  expect(prompt).toContain(".quay-ready-for-review.json");
  expect(prompt).toContain("rationale");
  expect(prompt).toContain("Head branch: feature/human-adopt");

  built.git.setRemoteHeadSha("quay", "feature/human-adopt", "head-51");
  built.github.setPrExists("quay", "feature/human-adopt", true);
  const tickResults = await tick_once(built.deps, {
    env: { [WORKER_GH_TOKEN_ENV]: "ghs_worker_runtime_test" },
  });

  expect(tickResults).toContainEqual({
    task_id: out.task_id,
    action: "spawned",
  });
  expect(built.git.countCalls("worktreeAdd")).toBe(0);
  expect(built.tmux.spawnCalls).toHaveLength(1);
  const spawnCall = built.tmux.spawnCalls[0];
  expect(spawnCall).toBeDefined();
  expect(spawnCall!.worktreePath).toBe(
    `${built.worktreesRoot}/quay-review/quay/51`,
  );
  expect(built.git.worktreeBranches.get(spawnCall!.worktreePath)).toEqual({
    repoId: "quay",
    branch: "feature/human-adopt",
  });
  const spawnedAttempt = h.db
    .query<
      {
        spawned_at: string | null;
        remote_sha_at_spawn: string | null;
        pr_existed_at_spawn: number;
      },
      [number]
    >(
      `SELECT spawned_at, remote_sha_at_spawn, pr_existed_at_spawn
         FROM attempts WHERE attempt_id = ?`,
    )
    .get(out.attempt_id);
  expect(spawnedAttempt?.spawned_at).not.toBeNull();
  expect(spawnedAttempt).toMatchObject({
    remote_sha_at_spawn: "head-51",
    pr_existed_at_spawn: 1,
  });
});

test("unadopt resolves adopted PR by repo PR reference and cancels without deleting remote branch", async () => {
  h = createHarness();
  h.clock.set("2026-06-10T15:00:00.000Z");
  const built = buildCliDeps(h);
  await dispatch(
    [
      "repo",
      "add",
      "--id",
      "quay",
      "--url",
      "git@github.com:acc/quay.git",
      "--base-branch",
      "main",
      "--package-manager",
      "bun",
      "--install-cmd",
      "true",
    ],
    built.deps,
    bufferIO(),
  );

  const taskId = "pr-review-quay-51";
  const branchName = "feature/human-adopt";
  const worktreePath = join(built.worktreesRoot, taskId);
  mkdirSync(worktreePath, { recursive: true });
  h.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, state, authoring_mode, branch_name, tmux_id,
         worktree_path, attempts_consumed, retry_budget, pr_number, head_sha,
         created_at, updated_at
       ) VALUES (?, 'quay', 'waiting_human', 'adopted_external_pr', ?, ?, ?, 2, 5, 51, 'head-51', ?, ?)`,
    )
    .run(
      taskId,
      branchName,
      "tmux-unadopt",
      worktreePath,
      "2026-06-10T14:00:00.000Z",
      "2026-06-10T14:30:00.000Z",
    );
  insertAttempt(h.db, {
    taskId,
    attemptNumber: 2,
    reason: "adopt_pr",
    spawnedAt: "2026-06-10T14:05:00.000Z",
  });
  built.git.setLocalBranches("quay", [branchName]);
  built.git.setWorktreeBranch("quay", worktreePath, branchName);
  built.git.setRemoteBranches("quay", [branchName]);

  const io = bufferIO();
  const result = await dispatch(["unadopt", "--pr", "acc/quay:51"], built.deps, io);

  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");
  const out = JSON.parse(io.out());
  expect(out).toMatchObject({
    ok: true,
    task_id: taskId,
    state: "cancelled",
    outcome: "unadopted",
    unadopted: true,
    pr: "quay:51",
    branch_name: branchName,
  });
  expect(out.message).toContain("stood down");

  const task = h.db
    .query<{ state: string; cancel_requested_at: string | null }, [string]>(
      `SELECT state, cancel_requested_at FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task?.state).toBe("cancelled");
  expect(task?.cancel_requested_at).toBe("2026-06-10T15:00:00.000Z");
  expect(built.git.localBranches.get("quay")?.has(branchName) ?? false).toBe(false);
  expect(built.git.remoteBranches.get("quay")?.has(branchName) ?? false).toBe(true);
  expect(built.git.calls.filter((c) => c.op === "deleteRemoteBranch")).toHaveLength(0);
});

test("unadopt rejects non-adopted task ids", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  const repoId = insertRepo(h.db, "repo-unadopt-reject");
  const taskId = insertTask(h.db, {
    repoId,
    taskId: "task-not-adopted",
    state: "queued",
  });

  const io = bufferIO();
  const result = await dispatch(["unadopt", taskId], built.deps, io);

  expect(result.exitCode).toBe(4);
  expect(io.out()).toBe("");
  expect(JSON.parse(io.err())).toMatchObject({
    error: "not_adopted",
    task_id: taskId,
    authoring_mode: "quay_owned",
  });
});

test("adopt-pr fails before scheduling worker when dependency install fails", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await dispatch(
    [
      "repo",
      "add",
      "--id",
      "quay",
      "--url",
      "git@github.com:acc/quay.git",
      "--base-branch",
      "main",
      "--package-manager",
      "bun",
      "--install-cmd",
      "TOKEN=super-secret bun install",
    ],
    built.deps,
    bufferIO(),
  );
  built.git.seedBareClone("quay");
  built.github.setPrView("quay", 54, {
    number: 54,
    title: "Human PR install fails",
    body: "Please let Quay finish this.",
    url: "https://github.com/acc/quay/pull/54",
    headRefName: "feature/human-install-fails",
    headSha: "head-54",
    baseRef: "dev",
    isCrossRepository: false,
  });
  built.github.setPrSnapshotByNumber("quay", 54, {
    prNumber: 54,
    prUrl: "https://github.com/acc/quay/pull/54",
    state: "open",
    headSha: "head-54",
    baseSha: "base-54",
    baseRef: "dev",
    mergeable: "mergeable",
    latestReview: {
      decision: "CHANGES_REQUESTED",
      latestReviewId: "R_current",
      submittedHeadSha: "head-54",
      comments: "Please fix the current head.",
    },
    checks: { checkSha: "head-54", items: [] },
  });
  built.commandRunner.failNext("install boom");

  const io = bufferIO();
  const result = await dispatch(["adopt-pr", "--pr", "acc/quay:54"], built.deps, io);

  expect(result.exitCode).toBe(4);
  expect(io.out()).toBe("");
  expect(io.err()).toContain("install_cmd failed");
  expect(io.err()).not.toContain("TOKEN=super-secret");
  const worktreePath = `${built.worktreesRoot}/quay-review/quay/54`;
  expect(built.commandRunner.calls).toEqual([
    {
      command: "TOKEN=super-secret bun install",
      cwd: worktreePath,
    },
  ]);
  expect(built.git.worktrees.has(worktreePath)).toBe(false);
  const attempts = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM attempts WHERE task_id = ? AND reason = 'adopt_pr'`,
    )
    .get("pr-review-quay-54");
  expect(attempts?.n).toBe(0);
});

test("adopt-pr does not schedule worker for stale requested changes on green current head", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await dispatch(
    [
      "repo",
      "add",
      "--id",
      "quay",
      "--url",
      "git@github.com:acc/quay.git",
      "--base-branch",
      "main",
      "--package-manager",
      "bun",
      "--install-cmd",
      "bun install",
    ],
    built.deps,
    bufferIO(),
  );
  built.git.seedBareClone("quay");
  built.github.setPrView("quay", 53, {
    number: 53,
    title: "Already fixed human PR",
    body: "Older feedback was already addressed.",
    url: "https://github.com/acc/quay/pull/53",
    headRefName: "feature/already-fixed",
    headSha: "head-new",
    baseRef: "dev",
    isCrossRepository: false,
  });
  built.github.setPrSnapshotByNumber("quay", 53, {
    prNumber: 53,
    prUrl: "https://github.com/acc/quay/pull/53",
    state: "open",
    headSha: "head-new",
    baseSha: "base-53",
    baseRef: "dev",
    mergeable: "mergeable",
    latestReview: {
      decision: "CHANGES_REQUESTED",
      latestReviewId: "R_stale",
      submittedHeadSha: "head-old",
      comments: "Old feedback that the new head addressed.",
    },
    checks: {
      checkSha: "head-new",
      items: [{ name: "build", workflow: null, bucket: "pass", required: true }],
    },
  });

  const io = bufferIO();
  const result = await dispatch(["adopt-pr", "--pr", "acc/quay:53"], built.deps, io);

  expect(result.exitCode).toBe(0);
  const out = JSON.parse(io.out());
  expect(out).toMatchObject({
    task_id: "pr-review-quay-53",
    state: "done",
    adopted: true,
    scheduled: false,
    skipped_reason: "ready",
  });
  expect(built.git.countCalls("worktreeAddExistingBranch")).toBe(0);
  const task = h.db
    .query<{ state: string; authoring_mode: string; branch_name: string }, [string]>(
      `SELECT state, authoring_mode, branch_name FROM tasks WHERE task_id = ?`,
    )
    .get(out.task_id);
  expect(task).toEqual({
    state: "done",
    authoring_mode: "adopted_external_pr",
    branch_name: "feature/already-fixed",
  });
  const attempts = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM attempts WHERE task_id = ? AND reason <> 'review_only'`,
    )
    .get(out.task_id);
  expect(attempts?.n).toBe(0);
});

test("adopt-pr rejects fork PRs", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await dispatch(
    [
      "repo",
      "add",
      "--id",
      "quay",
      "--url",
      "git@github.com:acc/quay.git",
      "--base-branch",
      "main",
      "--package-manager",
      "bun",
      "--install-cmd",
      "true",
    ],
    built.deps,
    bufferIO(),
  );
  built.git.seedBareClone("quay");
  built.github.setPrView("quay", 52, {
    number: 52,
    title: "Fork PR",
    body: "",
    url: "https://github.com/acc/quay/pull/52",
    headRefName: "feature/from-fork",
    headSha: "head-52",
    baseRef: "main",
    isCrossRepository: true,
  });

  const io = bufferIO();
  const result = await dispatch(["adopt-pr", "--pr", "acc/quay:52"], built.deps, io);

  expect(result.exitCode).toBe(4);
  expect(JSON.parse(io.err()).error).toBe("fork_pr_unsupported");
  const taskCount = h.db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM tasks`)
    .get();
  expect(taskCount?.n).toBe(0);
});

test("review-pr includes read-only reference repos context in reviewer prompt", async () => {
  h = createHarness();
  const root = mkdtempSync(join(tmpdir(), "quay-review-reference-repos-"));
  try {
    mkdirSync(join(root, "shared-api", ".git"), { recursive: true });
    const built = buildCliDeps(h);
    built.deps.tickOptions = {
      reviewerEnabled: true,
      referenceReposRoot: root,
    };
    await dispatch(
      [
        "repo",
        "add",
        "--id",
        "quay",
        "--url",
        "git@github.com:acc/quay.git",
        "--base-branch",
        "main",
        "--package-manager",
        "bun",
        "--install-cmd",
        "true",
      ],
      built.deps,
      bufferIO(),
    );
    built.github.setPrView("quay", 50, {
      number: 50,
      title: "Cross-repo PR",
      body: "Touches the shared-api contract",
      url: "https://github.com/acc/quay/pull/50",
      headRefName: "feature/cross-repo",
      headSha: "abc500",
    });

    const io = bufferIO();
    const result = await dispatch(["review-pr", "--pr", "acc/quay:50"], built.deps, io);

    expect(result.exitCode).toBe(0);
    const out = JSON.parse(io.out());
    const row = h.db
      .query<{ file_path: string }, [number]>(
        `SELECT file_path FROM artifacts
          WHERE attempt_id = ? AND kind = 'brief'`,
      )
      .get(out.attempt_id);
    expect(row).toBeDefined();
    const brief = readFileSync(row!.file_path, "utf8");
    expect(brief).toContain(`<quay-reference-repos root="${root}">`);
    expect(brief).toContain(`- shared-api: ${join(root, "shared-api")}`);
    expect(brief).toContain(
      "Do not modify code or git state in these directories.",
    );
    expect(brief).toContain(
      "Keep findings focused on the PR under review unless cross-repo context proves the PR breaks a contract.",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-pr records a pending request when CI is not green", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  built.deps.tickOptions = { reviewerEnabled: true };
  await dispatch(
    [
      "repo",
      "add",
      "--id",
      "quay",
      "--url",
      "git@github.com:acc/quay.git",
      "--base-branch",
      "main",
      "--package-manager",
      "bun",
      "--install-cmd",
      "true",
    ],
    built.deps,
    bufferIO(),
  );
  built.github.setPrView("quay", 77, {
    number: 77,
    title: "Human PR",
    body: "Please review",
    url: "https://github.com/acc/quay/pull/77",
    headRefName: "feature/human",
    headSha: "sha-pending",
  });
  built.github.setPrSnapshotByNumber("quay", 77, {
    prNumber: 77,
    state: "open",
    headSha: "sha-pending",
    baseSha: "base-1",
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "sha-pending",
      items: [{ name: "build", workflow: null, bucket: "pending", required: true }],
    },
  });

  const io = bufferIO();
  const result = await dispatch(
    ["review-pr", "--pr", "acc/quay:77"],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  const out = JSON.parse(io.out());
  expect(out.scheduled).toBe(false);
  expect(out.pending_ci).toBe(true);
  expect(out.attempt_id).toBeNull();
  const queued = h.db
    .query<{ status: string }, [string]>(
      `SELECT status FROM review_requests WHERE task_id = ? AND head_sha = 'sha-pending'`,
    )
    .get(out.task_id);
  expect(queued?.status).toBe("pending_ci");
});

test("review-pr revives a parked synthetic review task for a fresh PR head", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  built.deps.tickOptions = { reviewerEnabled: true };
  await dispatch(
    [
      "repo",
      "add",
      "--id",
      "quay",
      "--url",
      "git@github.com:acc/quay.git",
      "--base-branch",
      "main",
      "--package-manager",
      "bun",
      "--install-cmd",
      "true",
    ],
    built.deps,
    bufferIO(),
  );
  const taskId = "pr-review-quay-78";
  h.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, state, authoring_mode, branch_name, tmux_id,
         worktree_path, pr_number, pr_url, pr_title, head_sha, retry_budget,
         review_infra_failures_consecutive, review_infra_failure_head_sha,
         tick_error, created_at, updated_at
       ) VALUES (
         ?, 'quay', 'non_budget_loop', 'synthetic_review', 'quay-review/78',
         'quay-78', ?, 78, 'https://github.com/acc/quay/pull/78',
         'Parked review', 'sha-stale', 1, 3, 'sha-stale',
         'invalid task transition: non_budget_loop -> pr-review via review_requested',
         ?, ?
       )`,
    )
    .run(
      taskId,
      join(built.worktreesRoot, "quay-review", "quay", "78"),
      h.clock.nowISO(),
      h.clock.nowISO(),
    );
  built.github.setPrView("quay", 78, {
    number: 78,
    title: "Parked review",
    body: "Please review again",
    url: "https://github.com/acc/quay/pull/78",
    headRefName: "feature/parked-review",
    headSha: "sha-current",
  });

  const io = bufferIO();
  const result = await dispatch(
    ["review-pr", "--pr", "acc/quay:78"],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");
  const out = JSON.parse(io.out());
  expect(out).toMatchObject({
    task_id: taskId,
    state: "pr-review",
    scheduled: true,
    pending_ci: false,
  });
  expect(typeof out.attempt_id).toBe("number");

  const task = h.db
    .query<
      {
        state: string;
        head_sha: string | null;
        review_infra_failures_consecutive: number;
        review_infra_failure_head_sha: string | null;
        tick_error: string | null;
      },
      [string]
    >(
      `SELECT state, head_sha, review_infra_failures_consecutive,
              review_infra_failure_head_sha, tick_error
         FROM tasks
        WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toEqual({
    state: "pr-review",
    head_sha: "sha-current",
    review_infra_failures_consecutive: 0,
    review_infra_failure_head_sha: null,
    tick_error: null,
  });

  const event = h.db
    .query<
      { from_state: string | null; to_state: string | null; event_data: string | null },
      [string]
    >(
      `SELECT from_state, to_state, event_data
         FROM events
        WHERE task_id = ? AND event_type = 'review_requested'
        ORDER BY event_id DESC
        LIMIT 1`,
    )
    .get(taskId);
  expect(event?.from_state).toBe("non_budget_loop");
  expect(event?.to_state).toBe("pr-review");
  expect(JSON.parse(event?.event_data ?? "{}")).toEqual({
    recovery: "revived_parked_synthetic_review",
    pr_number: 78,
    head_sha: "sha-current",
    prior_review_infra_failures: 3,
    prior_review_infra_failure_head_sha: "sha-stale",
  });
});

test("review-pr revives parked synthetic task after result protocol failure on new head", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  built.deps.tickOptions = { reviewerEnabled: true };
  await dispatch(
    [
      "repo",
      "add",
      "--id",
      "quay",
      "--url",
      "git@github.com:acc/quay.git",
      "--base-branch",
      "main",
      "--package-manager",
      "bun",
      "--install-cmd",
      "true",
    ],
    built.deps,
    bufferIO(),
  );
  const taskId = "pr-review-quay-79";
  h.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, state, authoring_mode, branch_name, tmux_id,
         worktree_path, pr_number, pr_url, pr_title, head_sha, retry_budget,
         review_infra_failures_consecutive, review_infra_failure_head_sha,
         tick_error, created_at, updated_at
       ) VALUES (
         ?, 'quay', 'non_budget_loop', 'synthetic_review', 'quay-review/79',
         'quay-79', ?, 79, 'https://github.com/acc/quay/pull/79',
         'Parked protocol review', 'sha-stale', 1, 3, 'sha-stale',
         'reviewer did not write .quay-review-result.json',
         ?, ?
       )`,
    )
    .run(
      taskId,
      join(built.worktreesRoot, "quay-review", "quay", "79"),
      h.clock.nowISO(),
      h.clock.nowISO(),
    );
  built.github.setPrView("quay", 79, {
    number: 79,
    title: "Parked protocol review",
    body: "Please review again",
    url: "https://github.com/acc/quay/pull/79",
    headRefName: "feature/parked-protocol-review",
    headSha: "sha-current",
  });

  const io = bufferIO();
  const result = await dispatch(
    ["review-pr", "--pr", "acc/quay:79"],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  const out = JSON.parse(io.out());
  expect(out).toMatchObject({
    task_id: taskId,
    state: "pr-review",
    scheduled: true,
    pending_ci: false,
  });
  expect(typeof out.attempt_id).toBe("number");
  const task = h.db
    .query<
      {
        state: string;
        head_sha: string | null;
        review_infra_failures_consecutive: number;
        tick_error: string | null;
      },
      [string]
    >(
      `SELECT state, head_sha, review_infra_failures_consecutive, tick_error
         FROM tasks
        WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toEqual({
    state: "pr-review",
    head_sha: "sha-current",
    review_infra_failures_consecutive: 0,
    tick_error: null,
  });
});

test("review-pr keeps parked synthetic protocol failure parked on same head", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  built.deps.tickOptions = { reviewerEnabled: true };
  await dispatch(
    [
      "repo",
      "add",
      "--id",
      "quay",
      "--url",
      "git@github.com:acc/quay.git",
      "--base-branch",
      "main",
      "--package-manager",
      "bun",
      "--install-cmd",
      "true",
    ],
    built.deps,
    bufferIO(),
  );
  const taskId = "pr-review-quay-80";
  h.db
    .query(
      `INSERT INTO tasks (
         task_id, repo_id, state, authoring_mode, branch_name, tmux_id,
         worktree_path, pr_number, pr_url, pr_title, head_sha, retry_budget,
         review_infra_failures_consecutive, review_infra_failure_head_sha,
         tick_error, created_at, updated_at
       ) VALUES (
         ?, 'quay', 'non_budget_loop', 'synthetic_review', 'quay-review/80',
         'quay-80', ?, 80, 'https://github.com/acc/quay/pull/80',
         'Parked protocol review', 'sha-current', 1, 3, 'sha-current',
         'reviewer did not write .quay-review-result.json',
         ?, ?
       )`,
    )
    .run(
      taskId,
      join(built.worktreesRoot, "quay-review", "quay", "80"),
      h.clock.nowISO(),
      h.clock.nowISO(),
    );
  built.github.setPrView("quay", 80, {
    number: 80,
    title: "Parked protocol review",
    body: "Please review again",
    url: "https://github.com/acc/quay/pull/80",
    headRefName: "feature/parked-protocol-review",
    headSha: "sha-current",
  });

  const io = bufferIO();
  const result = await dispatch(
    ["review-pr", "--pr", "acc/quay:80"],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(io.out())).toMatchObject({
    task_id: taskId,
    attempt_id: null,
    state: "non_budget_loop",
    scheduled: false,
    skipped_reason: "parked_review_protocol_failure",
  });
});

test("review-pr does not revive a parked Quay-owned non-budget task", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  built.deps.tickOptions = { reviewerEnabled: true, gateQuayOwnedDone: true };
  const repoId = insertRepo(h.db, "repo-owned-parked");
  const taskId = insertTask(h.db, {
    repoId,
    taskId: "task-owned-parked",
    state: "non_budget_loop",
  });
  h.db
    .query(
      `UPDATE tasks
          SET pr_number = 79,
              pr_url = 'https://github.com/acc/repo-owned-parked/pull/79',
              pr_title = 'Parked owned task',
              head_sha = 'sha-owned-stale',
              review_infra_failures_consecutive = 3,
              review_infra_failure_head_sha = 'sha-owned-stale',
              tick_error = 'non-budget respawn parked'
        WHERE task_id = ?`,
    )
    .run(taskId);
  built.github.setPrView(repoId, 79, {
    number: 79,
    title: "Parked owned task",
    body: "",
    url: "https://github.com/acc/repo-owned-parked/pull/79",
    headRefName: `quay/${taskId}`,
    headSha: "sha-owned-current",
  });

  const io = bufferIO();
  const result = await dispatch(
    ["review-pr", "--pr", `${repoId}:79`],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");
  expect(JSON.parse(io.out())).toMatchObject({
    task_id: taskId,
    attempt_id: null,
    state: "non_budget_loop",
    scheduled: false,
    pending_ci: false,
    skipped_reason: "parked_non_synthetic_task",
  });

  const task = h.db
    .query<
      {
        state: string;
        head_sha: string | null;
        review_infra_failures_consecutive: number;
        review_infra_failure_head_sha: string | null;
        tick_error: string | null;
      },
      [string]
    >(
      `SELECT state, head_sha, review_infra_failures_consecutive,
              review_infra_failure_head_sha, tick_error
         FROM tasks
        WHERE task_id = ?`,
    )
    .get(taskId);
  expect(task).toEqual({
    state: "non_budget_loop",
    head_sha: "sha-owned-stale",
    review_infra_failures_consecutive: 3,
    review_infra_failure_head_sha: "sha-owned-stale",
    tick_error: "non-budget respawn parked",
  });
  const attempts = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM attempts WHERE task_id = ? AND reason = 'review_only'`,
    )
    .get(taskId);
  expect(attempts?.n).toBe(0);
  const events = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND event_type = 'review_requested'`,
    )
    .get(taskId);
  expect(events?.n).toBe(0);
});

test("review-pr snapshots reviewer override flags for synthetic tasks", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  built.deps.tickOptions = { reviewerEnabled: true };
  built.deps.agentResolver = createAgentResolver({
    db: h.db,
    config: {
      agents: {
        reviewer: "claude",
        reviewer_model: "global-review-model",
        invocations: {
          claude: { worker: "claude --w", reviewer: "claude --r" },
          codex: { worker: "codex exec", reviewer: "codex exec --review" },
        },
      },
    },
  });
  await dispatch(
    [
      "repo",
      "add",
      "--id",
      "quay",
      "--url",
      "git@github.com:acc/quay.git",
      "--base-branch",
      "main",
      "--package-manager",
      "bun",
      "--install-cmd",
      "true",
    ],
    built.deps,
    bufferIO(),
  );
  built.github.setPrView("quay", 48, {
    number: 48,
    title: "Human PR",
    body: "Please review",
    url: "https://github.com/acc/quay/pull/48",
    headRefName: "feature/human",
    headSha: "def456",
  });

  const io = bufferIO();
  const result = await dispatch(
    [
      "review-pr",
      "--pr",
      "acc/quay:48",
      "--reviewer-agent",
      "codex",
      "--reviewer-model",
      "gpt-5.5",
    ],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  const out = JSON.parse(io.out());
  const task = h.db
    .query<
      {
        reviewer_agent: string | null;
        reviewer_model: string | null;
        worker_agent: string | null;
        worker_model: string | null;
      },
      [string]
    >(
      `SELECT reviewer_agent, reviewer_model, worker_agent, worker_model
         FROM tasks
        WHERE task_id = ?`,
    )
    .get(out.task_id);
  expect(task).toEqual({
    reviewer_agent: "codex",
    reviewer_model: "gpt-5.5",
    worker_agent: "claude",
    worker_model: null,
  });
});

test("review-pr rejects an empty reviewer model override", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  built.deps.tickOptions = { reviewerEnabled: true };
  await dispatch(
    [
      "repo",
      "add",
      "--id",
      "quay",
      "--url",
      "git@github.com:acc/quay.git",
      "--base-branch",
      "main",
      "--package-manager",
      "bun",
      "--install-cmd",
      "true",
    ],
    built.deps,
    bufferIO(),
  );
  built.github.setPrView("quay", 49, {
    number: 49,
    title: "Human PR",
    body: "Please review",
    url: "https://github.com/acc/quay/pull/49",
    headRefName: "feature/human",
    headSha: "feed49",
  });

  const io = bufferIO();
  const result = await dispatch(
    ["review-pr", "--pr", "acc/quay:49", "--reviewer-model="],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(1);
  expect(JSON.parse(io.err()).error).toBe("usage_error");
  expect(io.err()).toContain("reviewer-model must not be empty");
  const attempts = h.db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM attempts`)
    .get();
  expect(attempts?.n).toBe(0);
});

test("review-pr supersedes an in-flight attempt on a new SHA and reaps its tmux session", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  built.deps.tickOptions = { reviewerEnabled: true };
  await dispatch(
    [
      "repo", "add", "--id", "acme",
      "--url", "git@github.com:acme/widgets.git",
      "--base-branch", "main",
      "--package-manager", "bun",
      "--install-cmd", "true",
    ],
    built.deps,
    bufferIO(),
  );
  built.github.setPrView("acme", 12, {
    number: 12,
    title: "Adversarial PR",
    body: "first body",
    url: "https://github.com/acme/widgets/pull/12",
    headRefName: "feature/x",
    headSha: "sha-aaa",
  });

  const io1 = bufferIO();
  await dispatch(["review-pr", "--pr", "acme/widgets:12"], built.deps, io1);
  const firstAttemptId = JSON.parse(io1.out()).attempt_id as number;

  // Simulate the worker having spawned: stamp tmux_session and pretend it's
  // alive in the fake. This is what gets reaped on supersede.
  h.db
    .query(
      `UPDATE attempts SET tmux_session = 'quay-review-stale', spawned_at = ? WHERE attempt_id = ?`,
    )
    .run(h.clock.nowISO(), firstAttemptId);
  built.tmux.liveSessions.add("quay-review-stale");

  // Same PR, new SHA → must supersede the prior attempt.
  built.github.setPrView("acme", 12, {
    number: 12,
    title: "Adversarial PR",
    body: "second body",
    url: "https://github.com/acme/widgets/pull/12",
    headRefName: "feature/x",
    headSha: "sha-bbb",
  });
  const io2 = bufferIO();
  const second = await dispatch(
    ["review-pr", "--pr", "acme/widgets:12"],
    built.deps,
    io2,
  );
  expect(second.exitCode).toBe(0);
  const out2 = JSON.parse(io2.out());
  expect(out2.scheduled).toBe(true);
  expect(out2.attempt_id).not.toBe(firstAttemptId);

  expect(built.tmux.killCalls).toContain("quay-review-stale");
  expect(built.tmux.liveSessions.has("quay-review-stale")).toBe(false);

  const prior = h.db
    .query<{ review_verdict: string | null; kill_intent: string | null }, [number]>(
      `SELECT review_verdict, kill_intent FROM attempts WHERE attempt_id = ?`,
    )
    .get(firstAttemptId);
  expect(prior?.review_verdict).toBe("superseded");
  expect(prior?.kill_intent).toBe("superseded");
});

test("review-pr pending-CI request supersedes stale in-flight reviewer on a new SHA", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  built.deps.tickOptions = { reviewerEnabled: true };
  await dispatch(
    [
      "repo", "add", "--id", "acme",
      "--url", "git@github.com:acme/widgets.git",
      "--base-branch", "main",
      "--package-manager", "bun",
      "--install-cmd", "true",
    ],
    built.deps,
    bufferIO(),
  );
  built.github.setPrView("acme", 13, {
    number: 13,
    title: "Adversarial PR",
    body: "first body",
    url: "https://github.com/acme/widgets/pull/13",
    headRefName: "feature/x",
    headSha: "sha-old",
  });

  const io1 = bufferIO();
  await dispatch(["review-pr", "--pr", "acme/widgets:13"], built.deps, io1);
  const firstAttemptId = JSON.parse(io1.out()).attempt_id as number;
  h.db
    .query(
      `UPDATE attempts SET tmux_session = 'quay-review-pending-stale', spawned_at = ? WHERE attempt_id = ?`,
    )
    .run(h.clock.nowISO(), firstAttemptId);
  built.tmux.liveSessions.add("quay-review-pending-stale");

  built.github.setPrView("acme", 13, {
    number: 13,
    title: "Adversarial PR",
    body: "second body",
    url: "https://github.com/acme/widgets/pull/13",
    headRefName: "feature/x",
    headSha: "sha-new",
  });
  built.github.setPrSnapshotByNumber("acme", 13, {
    prNumber: 13,
    state: "open",
    headSha: "sha-new",
    baseSha: "base-1",
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "sha-new",
      items: [{ name: "build", workflow: null, bucket: "pending", required: true }],
    },
  });

  const io2 = bufferIO();
  const second = await dispatch(
    ["review-pr", "--pr", "acme/widgets:13"],
    built.deps,
    io2,
  );

  expect(second.exitCode).toBe(0);
  const out2 = JSON.parse(io2.out());
  expect(out2.scheduled).toBe(false);
  expect(out2.pending_ci).toBe(true);
  expect(out2.attempt_id).toBeNull();
  expect(built.tmux.killCalls).toContain("quay-review-pending-stale");

  const prior = h.db
    .query<{ review_verdict: string | null; kill_intent: string | null }, [number]>(
      `SELECT review_verdict, kill_intent FROM attempts WHERE attempt_id = ?`,
    )
    .get(firstAttemptId);
  expect(prior?.review_verdict).toBe("superseded");
  expect(prior?.kill_intent).toBe("superseded");
});

test("review-pr without --pr exits 2 with usage_error", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  built.deps.tickOptions = { reviewerEnabled: true };
  const io = bufferIO();
  const result = await dispatch(["review-pr"], built.deps, io);
  expect(result.exitCode).toBe(2);
  expect(io.err()).toContain("usage_error");
});

test("review-pr against an unknown PR exits 3 with pr_not_found", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  built.deps.tickOptions = { reviewerEnabled: true };
  await dispatch(
    [
      "repo", "add", "--id", "acme",
      "--url", "git@github.com:acme/widgets.git",
      "--base-branch", "main",
      "--package-manager", "bun",
      "--install-cmd", "true",
    ],
    built.deps,
    bufferIO(),
  );
  // No setPrView → FakeGitHub.prView returns null, surfacing pr_not_found.
  const io = bufferIO();
  const result = await dispatch(
    ["review-pr", "--pr", "acme/widgets:999"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(3);
  expect(io.err()).toContain("pr_not_found");
});

test("review-pr exits 2 reviewer_disabled when the subsystem is off", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  // Note: reviewerEnabled left undefined.
  await dispatch(
    [
      "repo", "add", "--id", "acme",
      "--url", "git@github.com:acme/widgets.git",
      "--base-branch", "main",
      "--package-manager", "bun",
      "--install-cmd", "true",
    ],
    built.deps,
    bufferIO(),
  );
  built.github.setPrView("acme", 1, {
    number: 1, title: "x", body: "", url: null,
    headRefName: "f/x", headSha: "sha-1",
  });
  const io = bufferIO();
  const result = await dispatch(
    ["review-pr", "--pr", "acme/widgets:1"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(2);
  expect(io.err()).toContain("reviewer_disabled");
});

test("review-pr no-ops for Quay-owned PRs while done gate is disabled", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  built.deps.tickOptions = { reviewerEnabled: true, gateQuayOwnedDone: false };
  const repoId = insertRepo(h.db, "repo-owned");
  const taskId = insertTask(h.db, { repoId, taskId: "task-owned", state: "pr-open" });
  h.db.query(`UPDATE tasks SET pr_number = 12 WHERE task_id = ?`).run(taskId);
  built.github.setPrView(repoId, 12, {
    number: 12,
    title: "Quay PR",
    body: "",
    url: "https://example.test/pr/12",
    headRefName: `quay/${taskId}`,
    headSha: "sha-owned",
  });

  const io = bufferIO();
  const result = await dispatch(
    ["review-pr", "--pr", "repo-owned:12"],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  const out = JSON.parse(io.out());
  expect(out).toMatchObject({
    task_id: taskId,
    attempt_id: null,
    scheduled: false,
    skipped_reason: "quay_owned_gate_disabled",
  });
  const count = h.db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM attempts WHERE task_id = ? AND reason = 'review_only'`,
    )
    .get(taskId);
  expect(count?.n).toBe(0);
});

test("review-pr gives Quay-owned tasks a request-changes verdict policy for any finding", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  built.deps.tickOptions = { reviewerEnabled: true, gateQuayOwnedDone: true };
  const repoId = insertRepo(h.db, "repo-owned-policy");
  const taskId = insertTask(h.db, {
    repoId,
    taskId: "task-owned-policy",
    state: "pr-open",
  });
  h.db.query(`UPDATE tasks SET pr_number = 21 WHERE task_id = ?`).run(taskId);
  built.github.setPrView(repoId, 21, {
    number: 21,
    title: "Quay PR",
    body: "",
    url: "https://example.test/pr/21",
    headRefName: `quay/${taskId}`,
    headSha: "sha-owned-policy",
  });

  const io = bufferIO();
  const result = await dispatch(
    ["review-pr", "--pr", `${repoId}:21`],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  const out = JSON.parse(io.out());
  expect(out).toMatchObject({
    task_id: taskId,
    scheduled: true,
    skipped_reason: null,
  });
  const briefRow = h.db
    .query<{ file_path: string }, [number]>(
      `SELECT file_path FROM artifacts
        WHERE attempt_id = ? AND kind = 'brief'`,
    )
    .get(out.attempt_id);
  expect(briefRow).toBeDefined();
  const brief = readFileSync(briefRow!.file_path, "utf8");
  expect(brief).toContain("## Verdict policy");
  expect(brief).toContain("This is a Quay-owned task.");
  expect(brief).toContain(
    "Non-blocking-only findings -> `changes_requested` with the findings listed under `### Non-blocking`.",
  );
  expect(brief).not.toContain(
    "Non-blocking-only findings -> `approved`",
  );
  expect(brief).toContain("Choose the verdict according to the Verdict policy below.");
});

test("review-pr gives adopted external PRs the non-Quay-owned verdict policy", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  built.deps.tickOptions = { reviewerEnabled: true, gateQuayOwnedDone: true };
  const repoId = insertRepo(h.db, "repo-adopted-policy");
  const taskId = insertTask(h.db, {
    repoId,
    taskId: "task-adopted-policy",
    state: "pr-open",
  });
  h.db
    .query(
      `UPDATE tasks
          SET authoring_mode = 'adopted_external_pr',
              pr_number = 22,
              branch_name = 'feature/adopted-policy'
        WHERE task_id = ?`,
    )
    .run(taskId);
  built.github.setPrView(repoId, 22, {
    number: 22,
    title: "Adopted PR",
    body: "",
    url: "https://example.test/pr/22",
    headRefName: "feature/adopted-policy",
    headSha: "sha-adopted-policy",
  });

  const io = bufferIO();
  const result = await dispatch(
    ["review-pr", "--pr", `${repoId}:22`],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  const out = JSON.parse(io.out());
  expect(out).toMatchObject({
    task_id: taskId,
    scheduled: true,
    skipped_reason: null,
  });
  const briefRow = h.db
    .query<{ file_path: string }, [number]>(
      `SELECT file_path FROM artifacts
        WHERE attempt_id = ? AND kind = 'brief'`,
    )
    .get(out.attempt_id);
  expect(briefRow).toBeDefined();
  const brief = readFileSync(briefRow!.file_path, "utf8");
  expect(brief).toContain("## Verdict policy");
  expect(brief).toContain("This is not a Quay-owned task.");
  expect(brief).toContain(
    "Non-blocking-only findings -> `approved` with the findings listed under `### Non-blocking`.",
  );
  expect(brief).not.toContain(
    "Non-blocking-only findings -> `changes_requested`",
  );
  expect(brief).toContain("Choose the verdict according to the Verdict policy below.");
});
