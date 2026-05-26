// §5 "CI status rules": when GitHub reports no check rows at all, Quay
// preserves the no-CI behavior and transitions `pr-open → done`.
import { afterEach, expect, test } from "bun:test";
import { tick_once } from "../../src/core/tick.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertRepo, insertTask } from "../support/fixtures.ts";
import { buildTickDeps } from "../support/tick_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_068_no_reported_checks_means_pass", async () => {
  h = createHarness();
  h.clock.set("2026-04-29T10:00:00.000Z");

  const repoId = insertRepo(h.db, "repo-no-required");
  const taskId = insertTask(h.db, {
    taskId: "task-no-required",
    repoId,
    state: "pr-open",
  });
  insertAttempt(h.db, { taskId, attemptNumber: 1, spawnedAt: "2026-04-29T09:30:00.000Z" });

  const built = buildTickDeps(h);
  // No rows at all: this is the only pass-through no-CI shape.
  built.github.setPrSnapshot(repoId, `quay/${taskId}`, {
    state: "open",
    headSha: "abc1234",
    baseSha: "def5678",
    mergeable: "mergeable",
    latestReview: { decision: "NONE", latestReviewId: null, comments: "" },
    checks: {
      checkSha: "abc1234",
      items: [],
    },
  });

  const results = await tick_once(built.deps);
  expect(results).toEqual([{ task_id: taskId, action: "ci_passed" }]);

  const state = h.db
    .query<{ state: string }, [string]>(`SELECT state FROM tasks WHERE task_id = ?`)
    .get(taskId);
  expect(state?.state).toBe("done");
});
