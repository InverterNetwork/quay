import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, afterEach } from "bun:test";
import { openDatabase } from "../../src/db/connection.ts";
import { loadMigrationsFromDir, runMigrations } from "../../src/db/migrate.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertRepo, insertTask } from "../support/fixtures.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIGRATIONS_DIR = join(REPO_ROOT, "migrations");

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

test("0023 backfills existing handoffs into linked workflow outbox items", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "quay-migration-"));
  const db = openDatabase(join(dataDir, "quay.db"));
  try {
    const migrations = loadMigrationsFromDir(MIGRATIONS_DIR);
    runMigrations(
      db,
      migrations.filter((m) => m.name < "0023_orchestrator_outbox.sql"),
    );
    const missingOutbox = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'outbox_items'`,
      )
      .get();
    expect(missingOutbox).toBeNull();

    const taskId = insertTask(db, {
      repoId: insertRepo(db, "repo-migration-outbox-backfill"),
      taskId: "task-migration-outbox-backfill",
      state: "awaiting-next-brief",
    });
    const event = db
      .query<{ event_id: number }, [string]>(
        `INSERT INTO events (
           task_id, event_type, from_state, to_state, occurred_at
         ) VALUES (?, 'blocker_ingested', 'running', 'awaiting-next-brief', '2026-01-01T00:00:00.000Z')
         RETURNING event_id`,
      )
      .get(taskId);
    if (!event) throw new Error("event insert returned no row");
    const handoff = db
      .query<{ handoff_id: number }, [string, number, string, string]>(
        `INSERT INTO orchestrator_handoffs (
           task_id, reason, state_event_id, idempotency_key, payload_json,
           created_at, updated_at
         ) VALUES (?, 'worker_blocker', ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
         RETURNING handoff_id`,
      )
      .get(
        taskId,
        event.event_id,
        `${taskId}:${event.event_id}:worker_blocker`,
        JSON.stringify({ artifact_id: 55 }),
      );
    if (!handoff) throw new Error("handoff insert returned no row");

    runMigrations(
      db,
      migrations.filter((m) => m.name === "0023_orchestrator_outbox.sql"),
    );

    const linked = db
      .query<
        {
          handoff_id: number;
          outbox_item_id: number | null;
          task_id: string;
          kind: string;
          handler_class: string;
          source_event_id: number | null;
          idempotency_key: string;
          payload_json: string | null;
          status: string;
        },
        [number]
      >(
        `SELECT h.handoff_id, h.outbox_item_id, o.task_id, o.kind,
                o.handler_class, o.source_event_id, o.idempotency_key,
                o.payload_json, o.status
           FROM orchestrator_handoffs h
           JOIN outbox_items o ON o.outbox_item_id = h.outbox_item_id
          WHERE h.handoff_id = ?`,
      )
      .get(handoff.handoff_id);
    expect(linked).toMatchObject({
      handoff_id: handoff.handoff_id,
      task_id: taskId,
      kind: "workflow_intervention.worker_blocker",
      handler_class: "workflow_intervention",
      source_event_id: event.event_id,
      idempotency_key: `${taskId}:${event.event_id}:worker_blocker`,
      status: "pending",
    });
    expect(linked?.outbox_item_id).toBeGreaterThan(0);
    expect(JSON.parse(linked!.payload_json!)).toEqual({ artifact_id: 55 });
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
