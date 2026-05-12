import { afterEach, expect, test } from "bun:test";
import { dispatch } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";
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
