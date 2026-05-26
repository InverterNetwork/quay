import { afterEach, expect, test } from "bun:test";
import { createHarness, type Harness } from "../support/harness.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("agent/model selection columns exist after migration", () => {
  h = createHarness();
  const repoColumns = columnNames("repos");
  expect(repoColumns.has("model_worker")).toBe(true);
  expect(repoColumns.has("model_reviewer")).toBe(true);
  expect(repoColumns.has("preamble_worker")).toBe(true);
  expect(repoColumns.has("preamble_reviewer")).toBe(true);

  const taskColumns = columnNames("tasks");
  expect(taskColumns.has("worker_agent")).toBe(true);
  expect(taskColumns.has("worker_model")).toBe(true);
  expect(taskColumns.has("reviewer_agent")).toBe(true);
  expect(taskColumns.has("reviewer_model")).toBe(true);

  const attemptColumns = columnNames("attempts");
  expect(attemptColumns.has("agent_model")).toBe(true);
});

function columnNames(table: string): Set<string> {
  if (h === null) throw new Error("missing harness");
  return new Set(
    h.db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((r) => r.name),
  );
}
