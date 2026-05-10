import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { createArtifactStore } from "../../src/artifacts/store.ts";
import { collectToolTraceArtifact } from "../../src/core/tool_trace.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import {
  insertAttempt,
  insertRepo,
  insertTask,
} from "../support/fixtures.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

function setupAttempt(): { taskId: string; attemptId: number } {
  const repoId = insertRepo(h!.db, "repo-trace");
  const taskId = insertTask(h!.db, { taskId: "task-trace", repoId });
  const attemptId = insertAttempt(h!.db, {
    taskId,
    attemptNumber: 1,
    reason: "initial",
    consumedBudget: 1,
  });
  return { taskId, attemptId };
}

function deps() {
  return {
    db: h!.db,
    artifactStore: createArtifactStore({
      db: h!.db,
      artifactRoot: h!.artifactRoot,
      clock: h!.clock,
    }),
  };
}

test("writes a tool_trace artifact when the debug file is present", () => {
  h = createHarness();
  h.clock.set("2026-05-10T14:00:00.000Z");
  const { taskId, attemptId } = setupAttempt();

  const trace =
    "[2026-05-10T14:00:00Z] tool_dispatch_start tool=Bash\n" +
    "[2026-05-10T14:00:01Z] tool_dispatch_end tool=Bash outcome=ok\n";
  writeFileSync(join(h.dataDir, ".quay-tool-trace.log"), trace);

  collectToolTraceArtifact(deps(), taskId, attemptId, h.dataDir);

  const rows = h.db
    .query<
      { artifact_id: number; content_hash: string | null; file_path: string },
      [string, number]
    >(
      `SELECT artifact_id, content_hash, file_path
         FROM artifacts WHERE task_id = ? AND attempt_id = ? AND kind = 'tool_trace'`,
    )
    .all(taskId, attemptId);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.content_hash).not.toBeNull();
});

test("re-reading the same trace is idempotent", () => {
  h = createHarness();
  h.clock.set("2026-05-10T14:01:00.000Z");
  const { taskId, attemptId } = setupAttempt();

  writeFileSync(
    join(h.dataDir, ".quay-tool-trace.log"),
    "[boot] starting\n",
  );

  // Two calls — the partial unique index on
  // (task_id, attempt_id, kind, content_hash) collapses the second.
  collectToolTraceArtifact(deps(), taskId, attemptId, h.dataDir);
  collectToolTraceArtifact(deps(), taskId, attemptId, h.dataDir);

  const count = h.db
    .query<{ n: number }, [string, number]>(
      `SELECT COUNT(*) AS n FROM artifacts
         WHERE task_id = ? AND attempt_id = ? AND kind = 'tool_trace'`,
    )
    .get(taskId, attemptId);
  expect(count!.n).toBe(1);
});

test("skips when the file is absent or empty", () => {
  h = createHarness();
  const { taskId, attemptId } = setupAttempt();

  // Absent.
  collectToolTraceArtifact(deps(), taskId, attemptId, h.dataDir);

  // Empty.
  writeFileSync(join(h.dataDir, ".quay-tool-trace.log"), "");
  collectToolTraceArtifact(deps(), taskId, attemptId, h.dataDir);

  const count = h.db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'tool_trace'`,
    )
    .get();
  expect(count!.n).toBe(0);
});

test("tail-reads when the trace exceeds the cap, biasing toward the end", async () => {
  h = createHarness();
  h.clock.set("2026-05-10T14:02:00.000Z");
  const { taskId, attemptId } = setupAttempt();

  // Build a 5 MiB file (cap is 4 MiB) with a uniquely-marked tail so
  // we can prove the artifact captured the last bytes, not the first.
  const headChunk = "X".repeat(1024 * 1024);
  const padChunk = "Y".repeat(1024 * 1024);
  const tailMarker = "[tail-marker] last event before exit\n";
  const padded =
    headChunk + padChunk + padChunk + padChunk + padChunk + tailMarker;
  writeFileSync(join(h.dataDir, ".quay-tool-trace.log"), padded);

  collectToolTraceArtifact(deps(), taskId, attemptId, h.dataDir);

  const row = h.db
    .query<{ file_path: string }, [string, number]>(
      `SELECT file_path FROM artifacts
         WHERE task_id = ? AND attempt_id = ? AND kind = 'tool_trace'`,
    )
    .get(taskId, attemptId);
  expect(row).not.toBeNull();

  const captured = await Bun.file(row!.file_path).text();
  expect(captured.length).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(captured.endsWith(tailMarker)).toBe(true);
});
