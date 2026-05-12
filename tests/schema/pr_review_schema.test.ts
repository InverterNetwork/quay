import { afterEach, expect, test } from "bun:test";
import { createHarness, type Harness } from "../support/harness.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("preambles have kind with code default and tasks track review infra failures", () => {
  h = createHarness();
  const preambleCols = h.db
    .query<{ name: string }, []>(`PRAGMA table_info(preambles)`)
    .all()
    .map((c) => c.name);
  expect(preambleCols).toContain("kind");

  const taskCols = h.db
    .query<{ name: string }, []>(`PRAGMA table_info(tasks)`)
    .all()
    .map((c) => c.name);
  expect(taskCols).toContain("review_infra_failures_consecutive");
  expect(taskCols).toContain("review_infra_failure_head_sha");

  h.db
    .query(
      `INSERT INTO preambles (body, created_at)
       VALUES ('body', '2026-01-01T00:00:00.000Z')`,
    )
    .run();
  const row = h.db
    .query<{ kind: string }, []>(`SELECT kind FROM preambles LIMIT 1`)
    .get();
  expect(row?.kind).toBe("code");
});
