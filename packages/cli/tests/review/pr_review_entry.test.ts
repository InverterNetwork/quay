import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";
import { createAgentResolver } from "../../src/core/agents.ts";
import type { SupervisorLock } from "../../src/core/supervisor_lock.ts";
import { WORKER_GH_TOKEN_ENV, tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { buildCliDeps } from "../support/cli_deps.ts";
import { insertRepo, insertTask } from "../support/fixtures.ts";

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
