import { test, expect, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createArtifactStore } from "../../src/artifacts/store.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertAttempt, insertPreamble, insertTask } from "../support/fixtures.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_artifact_store_writes_file_and_db_row", () => {
  h = createHarness();
  const taskId = insertTask(h.db);
  const preambleId = insertPreamble(h.db);
  const attemptId = insertAttempt(h.db, {
    taskId,
    attemptNumber: 1,
    preambleId,
    spawnedAt: "2026-01-01T00:00:01.000Z",
  });

  const store = createArtifactStore({
    db: h.db,
    artifactRoot: h.artifactRoot,
    clock: h.clock,
  });

  const content = "blocker text\n";
  const result = store.writeArtifact({
    taskId,
    attemptId,
    kind: "blocker",
    content,
    extension: "md",
  });

  // File written under artifactRoot at the documented layout.
  expect(existsSync(result.filePath)).toBe(true);
  expect(result.filePath.startsWith(h.artifactRoot)).toBe(true);
  expect(result.filePath).toContain(`/${taskId}/`);
  expect(result.filePath).toContain(`/${attemptId}/`);
  expect(result.filePath).toContain("/blocker/");

  expect(readFileSync(result.filePath, "utf8")).toBe(content);

  const expectedHash = createHash("sha256").update(content).digest("hex");
  expect(result.contentHash).toBe(expectedHash);
  expect(result.capturedAt).toBe(h.clock.nowISO());

  // DB row uses spec §9 column names.
  const row = h.db
    .query<
      {
        artifact_id: number;
        task_id: string;
        attempt_id: number | null;
        kind: string;
        file_path: string;
        content_hash: string | null;
        captured_at: string;
      },
      [number]
    >(
      `SELECT artifact_id, task_id, attempt_id, kind, file_path, content_hash, captured_at
       FROM artifacts WHERE artifact_id = ?`,
    )
    .get(result.artifactId);

  expect(row).not.toBeNull();
  expect(row!.task_id).toBe(taskId);
  expect(row!.attempt_id).toBe(attemptId);
  expect(row!.kind).toBe("blocker");
  expect(row!.file_path).toBe(result.filePath);
  expect(row!.content_hash).toBe(expectedHash);
  expect(row!.captured_at).toBe(h.clock.nowISO());
});
