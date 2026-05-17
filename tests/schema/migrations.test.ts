import { test, expect, afterEach } from "bun:test";
import { createHarness, type Harness } from "../support/harness.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("test_schema_creates_required_tables", () => {
  h = createHarness();
  const required = [
    "repos",
    "preambles",
    "retry_templates",
    "tasks",
    "attempts",
    "artifacts",
    "events",
    "orchestrator_handoffs",
    "review_requests",
  ];
  const rows = h.db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all();
  const names = new Set(rows.map((r) => r.name));
  for (const t of required) {
    expect(names.has(t)).toBe(true);
  }
});

test("tasks table has effective base_branch column", () => {
  h = createHarness();
  const cols = h.db
    .query<{ name: string }, []>(`PRAGMA table_info(tasks)`)
    .all()
    .map((r) => r.name);
  expect(cols).toContain("base_branch");
});
