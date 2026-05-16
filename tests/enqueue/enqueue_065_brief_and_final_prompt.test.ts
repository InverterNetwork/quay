import { test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { createHarness, type Harness } from "../support/harness.ts";
import { createRepoService } from "../../src/core/repos/service.ts";
import { enqueue } from "../../src/core/enqueue.ts";
import { buildEnqueueDeps } from "../support/enqueue_deps.ts";
import { loadPreambleBody } from "../../src/core/preamble.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

const REPO = {
  repo_id: "repo-attempt1",
  repo_url: "git@example.com:owner/r.git",
  base_branch: "main",
  package_manager: "bun",
  install_cmd: "bun install",
} as const;

test("test_065_initial_attempt_has_brief_and_final_prompt", () => {
  h = createHarness();
  const repos = createRepoService({ db: h.db, clock: h.clock });
  repos.add({ ...REPO });

  const built = buildEnqueueDeps(h);
  built.git.seedBareClone(REPO.repo_id);
  h.ids.push("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

  const result = enqueue(built.deps, {
    repo_id: REPO.repo_id,
    external_ref: "ITRY-65",
    brief: "Do the thing",
    ticket_snapshot: "Ticket text 65",
  });

  // Exactly one brief artifact for attempt 1.
  const briefRows = h.db
    .query<
      { artifact_id: number; file_path: string; attempt_id: number | null },
      [string, number]
    >(
      `SELECT artifact_id, file_path, attempt_id FROM artifacts
         WHERE task_id = ? AND attempt_id = ? AND kind = 'brief'`,
    )
    .all(result.task_id, result.attempt_id);
  expect(briefRows).toHaveLength(1);

  // Exactly one final_prompt artifact for attempt 1.
  const finalRows = h.db
    .query<
      { artifact_id: number; file_path: string; attempt_id: number | null },
      [string, number]
    >(
      `SELECT artifact_id, file_path, attempt_id FROM artifacts
         WHERE task_id = ? AND attempt_id = ? AND kind = 'final_prompt'`,
    )
    .all(result.task_id, result.attempt_id);
  expect(finalRows).toHaveLength(1);

  // ticket_snapshot is task-level (attempt_id IS NULL).
  const ticketRow = h.db
    .query<
      { attempt_id: number | null },
      [string]
    >(
      `SELECT attempt_id FROM artifacts WHERE task_id = ? AND kind = 'ticket_snapshot'`,
    )
    .get(result.task_id);
  expect(ticketRow).not.toBeNull();
  expect(ticketRow!.attempt_id).toBeNull();

  // task_objective is task-level and contains the raw original brief.
  const objectiveRow = h.db
    .query<
      { attempt_id: number | null; file_path: string; artifact_id: number },
      [string]
    >(
      `SELECT attempt_id, file_path, artifact_id FROM artifacts
         WHERE task_id = ? AND kind = 'task_objective'`,
    )
    .get(result.task_id);
  expect(objectiveRow).not.toBeNull();
  expect(objectiveRow!.attempt_id).toBeNull();
  expect(readFileSync(objectiveRow!.file_path, "utf8")).toBe("Do the thing");

  // final_prompt starts with the preamble and embeds the structured body.
  const preambleId = h.db
    .query<{ preamble_id: number }, [number]>(
      `SELECT preamble_id FROM attempts WHERE attempt_id = ?`,
    )
    .get(result.attempt_id)!.preamble_id;
  const preambleBody = loadPreambleBody(h.db, preambleId);

  const finalContent = readFileSync(finalRows[0]!.file_path, "utf8");
  expect(finalContent.startsWith(`${preambleBody}\n\n`)).toBe(true);
  const briefContent = readFileSync(briefRows[0]!.file_path, "utf8");
  expect(finalContent).toBe(`${preambleBody}\n\n${briefContent}`);

  // Brief is the structured composed body. The original objective is wrapped
  // in a tagged section pointing at the task_objective artifact; the initial
  // attempt guidance is its own tagged section.
  expect(briefContent).toContain(
    `<quay-task-objective artifact-id="${objectiveRow!.artifact_id}"`,
  );
  expect(briefContent).toContain('truncated="false"');
  expect(briefContent).toContain("Do the thing");
  expect(briefContent).toContain(
    '<quay-current-attempt-guidance reason="initial">',
  );
});
