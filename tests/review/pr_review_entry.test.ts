import { afterEach, expect, test } from "bun:test";
import { dispatch } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";
import { createAgentResolver } from "../../src/core/agents.ts";
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
