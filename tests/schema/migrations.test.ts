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
    "outbox_items",
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

test("tasks table has PR screenshot request flag with default off", () => {
  h = createHarness();
  const cols = h.db
    .query<{ name: string; dflt_value: string | null }, []>(
      `PRAGMA table_info(tasks)`,
    )
    .all();
  const col = cols.find((r) => r.name === "pr_screenshots_requested");
  expect(col).toBeDefined();
  expect(col?.dflt_value).toBe("0");
});

test("tasks table has PR screenshot requirement flag with default off", () => {
  h = createHarness();
  const cols = h.db
    .query<{ name: string; dflt_value: string | null }, []>(
      `PRAGMA table_info(tasks)`,
    )
    .all();
  const col = cols.find((r) => r.name === "pr_screenshots_required");
  expect(col).toBeDefined();
  expect(col?.dflt_value).toBe("0");
});

test("orchestrator handoffs carry next eligibility timestamp", () => {
  h = createHarness();
  const cols = h.db
    .query<{ name: string }, []>(`PRAGMA table_info(orchestrator_handoffs)`)
    .all()
    .map((r) => r.name);
  expect(cols).toContain("next_eligible_at");
});

test("outbox items support delivery and workflow metadata", () => {
  h = createHarness();
  const cols = h.db
    .query<{ name: string }, []>(`PRAGMA table_info(outbox_items)`)
    .all()
    .map((r) => r.name);
  expect(cols).toContain("handler_class");
  expect(cols).toContain("route_hint_json");
  expect(cols).toContain("delivered_at");
  expect(cols).toContain("last_error");
});
