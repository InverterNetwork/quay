import { test, expect, afterEach } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertTask } from "../support/fixtures.ts";
import { loadMigrationsFromDir, runMigrations } from "../../src/db/migrate.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIGRATIONS_DIR = join(REPO_ROOT, "migrations");

const NOW = "2026-01-01T00:00:00.000Z";

let h: Harness | null = null;
let tempMigrationsDir: string | null = null;

afterEach(() => {
  h?.cleanup();
  h = null;
  if (tempMigrationsDir) {
    rmSync(tempMigrationsDir, { recursive: true, force: true });
    tempMigrationsDir = null;
  }
});

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface ForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
}

interface IndexInfoRow {
  seqno: number;
  cid: number;
  name: string;
}

interface IndexListRow {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

test("test_schema_creates_task_tags_table", () => {
  h = createHarness();
  const cols = h.db
    .query<TableInfoRow, []>("PRAGMA table_info('task_tags')")
    .all();
  expect(cols.length).toBeGreaterThan(0);

  const byName = new Map(cols.map((c) => [c.name, c]));
  expect(byName.get("task_id")?.type.toUpperCase()).toBe("TEXT");
  expect(byName.get("task_id")?.notnull).toBe(1);
  expect(byName.get("tag")?.type.toUpperCase()).toBe("TEXT");
  expect(byName.get("tag")?.notnull).toBe(1);
  expect(byName.get("created_at")?.type.toUpperCase()).toBe("TEXT");
  expect(byName.get("created_at")?.notnull).toBe(1);

  // PRIMARY KEY (task_id, tag): both columns have pk > 0; created_at has pk = 0.
  expect(byName.get("task_id")?.pk).toBeGreaterThan(0);
  expect(byName.get("tag")?.pk).toBeGreaterThan(0);
  expect(byName.get("created_at")?.pk).toBe(0);

  // FOREIGN KEY task_id REFERENCES tasks(task_id).
  const fks = h.db
    .query<ForeignKeyRow, []>("PRAGMA foreign_key_list('task_tags')")
    .all();
  const taskFk = fks.find((f) => f.from === "task_id");
  expect(taskFk).toBeDefined();
  expect(taskFk?.table).toBe("tasks");
  expect(taskFk?.to).toBe("task_id");
});

test("test_schema_task_tags_index_by_tag_exists", () => {
  h = createHarness();
  const indexes = h.db
    .query<IndexListRow, []>("PRAGMA index_list('task_tags')")
    .all();
  const byTag = indexes.find((i) => i.name === "task_tags_by_tag");
  expect(byTag).toBeDefined();

  const cols = h.db
    .query<IndexInfoRow, []>("PRAGMA index_info('task_tags_by_tag')")
    .all();
  expect(cols.map((c) => c.name)).toEqual(["tag"]);

  const taskId = insertTask(h.db);
  h.db
    .query(
      `INSERT INTO task_tags (task_id, tag, created_at) VALUES (?, ?, ?)`,
    )
    .run(taskId, "auth-session", NOW);

  const rows = h.db
    .query<{ task_id: string }, [string]>(
      `SELECT task_id FROM task_tags WHERE tag = ?`,
    )
    .all("auth-session");
  expect(rows.map((r) => r.task_id)).toEqual([taskId]);
});

test("test_schema_task_tags_rejects_duplicate_pair", () => {
  h = createHarness();
  const taskId = insertTask(h.db);
  h.db
    .query(
      `INSERT INTO task_tags (task_id, tag, created_at) VALUES (?, ?, ?)`,
    )
    .run(taskId, "auth-session", NOW);

  expect(() =>
    h!.db
      .query(
        `INSERT INTO task_tags (task_id, tag, created_at) VALUES (?, ?, ?)`,
      )
      .run(taskId, "auth-session", NOW),
  ).toThrow();

  // Different tag for the same task is fine.
  h.db
    .query(
      `INSERT INTO task_tags (task_id, tag, created_at) VALUES (?, ?, ?)`,
    )
    .run(taskId, "cache", NOW);
});

test("test_schema_task_tags_rejects_orphan_task_id", () => {
  h = createHarness();
  expect(() =>
    h!.db
      .query(
        `INSERT INTO task_tags (task_id, tag, created_at) VALUES (?, ?, ?)`,
      )
      .run("ghost-task", "auth-session", NOW),
  ).toThrow();
});

test("test_schema_task_tags_cascades_or_rejects_on_task_delete", () => {
  // Migration chose RESTRICT (no ON DELETE clause). Deleting a task with
  // associated task_tags rows is rejected by the FK. Documented in
  // migrations/0002_deployment_adapters.sql.
  h = createHarness();
  const taskId = insertTask(h.db);
  h.db
    .query(
      `INSERT INTO task_tags (task_id, tag, created_at) VALUES (?, ?, ?)`,
    )
    .run(taskId, "auth-session", NOW);

  expect(() =>
    h!.db.query(`DELETE FROM tasks WHERE task_id = ?`).run(taskId),
  ).toThrow();

  // The row is still there.
  const remaining = h.db
    .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM task_tags`)
    .get();
  expect(remaining?.n).toBe(1);
});

test("test_schema_tasks_has_authors_json_column", () => {
  h = createHarness();
  const cols = h.db
    .query<TableInfoRow, []>("PRAGMA table_info('tasks')")
    .all();
  const authorsJson = cols.find((c) => c.name === "authors_json");
  expect(authorsJson).toBeDefined();
  expect(authorsJson?.type.toUpperCase()).toBe("TEXT");
  expect(authorsJson?.notnull).toBe(0);

  // Stores arbitrary JSON-serialized text.
  const taskId = insertTask(h.db);
  const payload = JSON.stringify([
    { name: "Alice", slack_id: "U06TDC56VJB" },
    { name: "Bob", slack_id: "U07XYZ12345" },
  ]);
  h.db
    .query(`UPDATE tasks SET authors_json = ? WHERE task_id = ?`)
    .run(payload, taskId);
  const row = h.db
    .query<{ authors_json: string | null }, [string]>(
      `SELECT authors_json FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(row?.authors_json).toBe(payload);
});

test("test_schema_tasks_authors_json_defaults_null_for_existing_rows", () => {
  // Apply only 0001 first, insert a task, then apply 0002 and confirm the
  // ALTER ADD COLUMN leaves the existing row at NULL with no backfill.
  tempMigrationsDir = mkdtempSync(join(tmpdir(), "quay-migrations-"));
  copyFileSync(
    join(MIGRATIONS_DIR, "0001_init.sql"),
    join(tempMigrationsDir, "0001_init.sql"),
  );

  h = createHarness({ migrationsDir: tempMigrationsDir });

  // Pre-migration: column does not exist yet.
  const colsBefore = h.db
    .query<TableInfoRow, []>("PRAGMA table_info('tasks')")
    .all();
  expect(colsBefore.find((c) => c.name === "authors_json")).toBeUndefined();

  const taskId = insertTask(h.db);

  runMigrations(h.db, loadMigrationsFromDir(MIGRATIONS_DIR));

  // Post-migration: column exists, existing row is NULL.
  const colsAfter = h.db
    .query<TableInfoRow, []>("PRAGMA table_info('tasks')")
    .all();
  expect(colsAfter.find((c) => c.name === "authors_json")).toBeDefined();

  const row = h.db
    .query<{ authors_json: string | null }, [string]>(
      `SELECT authors_json FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
  expect(row).toBeDefined();
  expect(row?.authors_json).toBeNull();
});

test("test_schema_migration_is_idempotent_on_rerun", () => {
  h = createHarness();

  // Sanity: 0002 is already applied by the harness.
  const appliedFirst = h.db
    .query<{ name: string }, []>(
      "SELECT name FROM schema_migrations ORDER BY name",
    )
    .all()
    .map((r) => r.name);
  expect(appliedFirst).toContain("0001_init.sql");
  expect(appliedFirst).toContain("0002_deployment_adapters.sql");

  // Rerun: returns no newly-applied files and does not throw on duplicate DDL.
  const newlyApplied = runMigrations(h.db, loadMigrationsFromDir(MIGRATIONS_DIR));
  expect(newlyApplied).toEqual([]);

  const appliedSecond = h.db
    .query<{ name: string }, []>(
      "SELECT name FROM schema_migrations ORDER BY name",
    )
    .all()
    .map((r) => r.name);
  expect(appliedSecond).toEqual(appliedFirst);

  // task_tags table still queryable; existing structure intact.
  const cols = h.db
    .query<TableInfoRow, []>("PRAGMA table_info('task_tags')")
    .all();
  expect(cols.length).toBeGreaterThan(0);
});
