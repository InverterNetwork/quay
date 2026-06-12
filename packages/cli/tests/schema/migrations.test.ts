import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, afterEach } from "bun:test";
import { openDatabase } from "../../src/db/connection.ts";
import { loadMigrationsFromDir, runMigrations } from "../../src/db/migrate.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { insertRepo, insertTask } from "../support/fixtures.ts";
import { TASK_TERMINAL_STATES } from "../../src/core/task_state.ts";

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
    "work_items",
    "attempts",
    "artifacts",
    "events",
    "task_dependencies",
    "orchestrator_handoffs",
    "outbox_items",
    "review_requests",
    "umbrella_workflows",
    "umbrella_expected_tasks",
    "umbrella_tasks",
    "deployment_settings",
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

test("work item run schema captures run identity and active-run invariant", () => {
  h = createHarness();

  const taskCols = h.db
    .query<{ name: string }, []>(`PRAGMA table_info(tasks)`)
    .all()
    .map((r) => r.name);
  expect(taskCols).toContain("work_item_id");
  expect(taskCols).toContain("run_number");
  expect(taskCols).toContain("supersedes_task_id");

  const workItemCols = h.db
    .query<{ name: string }, []>(`PRAGMA table_info(work_items)`)
    .all()
    .map((r) => r.name);
  expect(workItemCols).toEqual([
    "work_item_id",
    "source",
    "repo_id",
    "external_ref",
    "created_at",
    "updated_at",
  ]);

  const indexes = h.db
    .query<{ name: string; sql: string }, []>(
      `SELECT name, sql
         FROM sqlite_master
        WHERE type = 'index'
          AND name IN (
            'tasks_work_item_run_number_unique',
            'one_active_run_per_work_item'
          )
        ORDER BY name`,
    )
    .all();
  expect(indexes.map((r) => r.name)).toEqual([
    "one_active_run_per_work_item",
    "tasks_work_item_run_number_unique",
  ]);
  const activeRunSql = indexes.find((r) => r.name === "one_active_run_per_work_item")!.sql;
  for (const state of TASK_TERMINAL_STATES) {
    expect(activeRunSql).toContain(`'${state}'`);
  }
});

test("work item migration backfills runs without orphaning child rows", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "quay-work-items-migration-"));
  const db = openDatabase(join(dataDir, "quay.db"));
  try {
    const migrations = loadMigrationsFromDir(MIGRATIONS_DIR);
    runMigrations(
      db,
      migrations.filter((m) => m.name < "0035_work_items_runs.sql"),
    );

    const repoId = insertRepo(db, "repo-work-item-backfill");
    const activeTask = insertTask(db, {
      repoId,
      taskId: "task-active-backfill",
      state: "queued",
    });
    db.query(`UPDATE tasks SET external_ref = 'BRIX-1703' WHERE task_id = ?`).run(
      activeTask,
    );
    const terminalTask = insertTask(db, {
      repoId,
      taskId: "task-terminal-backfill",
      state: "closed_unmerged",
    });
    db.query(`UPDATE tasks SET external_ref = 'BRIX-1704' WHERE task_id = ?`).run(
      terminalTask,
    );
    const nullRefTask = insertTask(db, {
      repoId,
      taskId: "task-null-ref-backfill",
      state: "merged",
    });

    const preamble = db
      .query<{ preamble_id: number }, []>(
        `INSERT INTO preambles (body, kind, created_at)
         VALUES ('body', 'code', '2026-01-01T00:00:00.000Z')
         RETURNING preamble_id`,
      )
      .get();
    if (!preamble) throw new Error("preamble insert returned no row");
    const attempt = db
      .query<{ attempt_id: number }, [string, number]>(
        `INSERT INTO attempts (
           task_id, attempt_number, preamble_id, reason, consumed_budget
         ) VALUES (?, 1, ?, 'initial', 1)
         RETURNING attempt_id`,
      )
      .get(activeTask, preamble.preamble_id);
    if (!attempt) throw new Error("attempt insert returned no row");
    db.query(
      `INSERT INTO artifacts (
         task_id, attempt_id, kind, file_path, captured_at
       ) VALUES (?, ?, 'brief', '/tmp/brief.md', '2026-01-01T00:00:00.000Z')`,
    ).run(activeTask, attempt.attempt_id);
    db.query(
      `INSERT INTO events (
         task_id, attempt_id, event_type, to_state, occurred_at
       ) VALUES (?, ?, 'spawned', 'running', '2026-01-01T00:00:00.000Z')`,
    ).run(activeTask, attempt.attempt_id);

    const before = db
      .query<{ tasks: number; attempts: number; artifacts: number; events: number }, []>(
        `SELECT
           (SELECT COUNT(*) FROM tasks) AS tasks,
           (SELECT COUNT(*) FROM attempts) AS attempts,
           (SELECT COUNT(*) FROM artifacts) AS artifacts,
           (SELECT COUNT(*) FROM events) AS events`,
      )
      .get();

    runMigrations(
      db,
      migrations.filter((m) => m.name === "0035_work_items_runs.sql"),
    );

    const after = db
      .query<{ tasks: number; attempts: number; artifacts: number; events: number }, []>(
        `SELECT
           (SELECT COUNT(*) FROM tasks) AS tasks,
           (SELECT COUNT(*) FROM attempts) AS attempts,
           (SELECT COUNT(*) FROM artifacts) AS artifacts,
           (SELECT COUNT(*) FROM events) AS events`,
      )
      .get();
    expect(after).toEqual(before);

    const rows = db
      .query<
        { task_id: string; work_item_id: string | null; run_number: number | null },
        []
      >(
        `SELECT task_id, work_item_id, run_number
           FROM tasks
          ORDER BY task_id`,
      )
      .all();
    expect(rows).toEqual([
      { task_id: activeTask, work_item_id: expect.any(String), run_number: 1 },
      { task_id: nullRefTask, work_item_id: `wi:${nullRefTask}`, run_number: 1 },
      { task_id: terminalTask, work_item_id: expect.any(String), run_number: 1 },
    ]);

    expect(db.query(`PRAGMA foreign_key_check`).all()).toEqual([]);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("work item migration keeps retarget work items repo scoped", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "quay-work-items-retarget-migration-"));
  const db = openDatabase(join(dataDir, "quay.db"));
  try {
    const migrations = loadMigrationsFromDir(MIGRATIONS_DIR);
    runMigrations(
      db,
      migrations.filter((m) => m.name < "0035_work_items_runs.sql"),
    );

    const sourceRepoId = insertRepo(db, "repo-retarget-source");
    const targetRepoId = insertRepo(db, "repo-retarget-target");
    const sourceTask = insertTask(db, {
      repoId: sourceRepoId,
      taskId: "task-retarget-source",
      state: "cancelled",
    });
    const targetTask = insertTask(db, {
      repoId: targetRepoId,
      taskId: "task-retarget-target",
      state: "queued",
    });
    db.query(
      `UPDATE tasks
          SET external_ref = 'BRIX-1703',
              created_at = '2026-01-01T00:00:00.000Z',
              updated_at = '2026-01-01T00:00:00.000Z',
              cancel_requested_at = '2026-01-01T00:01:00.000Z'
        WHERE task_id = ?`,
    ).run(sourceTask);
    db.query(
      `UPDATE tasks
          SET external_ref = 'BRIX-1703',
              retargeted_from_task_id = ?,
              created_at = '2026-01-01T00:02:00.000Z',
              updated_at = '2026-01-01T00:02:00.000Z'
        WHERE task_id = ?`,
    ).run(sourceTask, targetTask);

    runMigrations(
      db,
      migrations.filter((m) => m.name === "0035_work_items_runs.sql"),
    );

    const rows = db
      .query<
        {
          task_id: string;
          repo_id: string;
          work_item_id: string | null;
          run_number: number | null;
          supersedes_task_id: string | null;
          work_item_repo_id: string | null;
        },
        []
      >(
        `SELECT
           t.task_id,
           t.repo_id,
           t.work_item_id,
           t.run_number,
           t.supersedes_task_id,
           wi.repo_id AS work_item_repo_id
           FROM tasks t
           JOIN work_items wi ON wi.work_item_id = t.work_item_id
          WHERE t.external_ref = 'BRIX-1703'
          ORDER BY t.repo_id`,
      )
      .all();
    expect(rows).toEqual([
      {
        task_id: sourceTask,
        repo_id: sourceRepoId,
        work_item_id: expect.any(String),
        run_number: 1,
        supersedes_task_id: null,
        work_item_repo_id: sourceRepoId,
      },
      {
        task_id: targetTask,
        repo_id: targetRepoId,
        work_item_id: expect.any(String),
        run_number: 1,
        supersedes_task_id: null,
        work_item_repo_id: targetRepoId,
      },
    ]);
    expect(rows[0]?.work_item_id).not.toBe(rows[1]?.work_item_id);
    expect(db.query(`PRAGMA foreign_key_check`).all()).toEqual([]);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("deployment_settings table stores mutable agent defaults", () => {
  h = createHarness();
  const cols = h.db
    .query<{ name: string }, []>(`PRAGMA table_info(deployment_settings)`)
    .all()
    .map((r) => r.name);
  expect(cols).toEqual([
    "singleton_id",
    "worker_agent",
    "worker_model",
    "reviewer_agent",
    "reviewer_model",
    "created_at",
    "updated_at",
  ]);
});

test("umbrella workflow tables capture workflow and task links", () => {
  h = createHarness();
  const workflowCols = h.db
    .query<{ name: string }, []>(`PRAGMA table_info(umbrella_workflows)`)
    .all()
    .map((r) => r.name);
  expect(workflowCols).toEqual([
    "umbrella_workflow_id",
    "external_ref",
    "repo_id",
    "base_branch",
    "feature_branch",
    "state",
    "final_pr_task_id",
    "final_pr_number",
    "final_pr_url",
    "created_at",
    "updated_at",
    "linear_issue_title",
    "linear_issue_url",
  ]);

  const taskCols = h.db
    .query<{ name: string }, []>(`PRAGMA table_info(umbrella_tasks)`)
    .all()
    .map((r) => r.name);
  expect(taskCols).toEqual([
    "umbrella_task_id",
    "umbrella_workflow_id",
    "task_id",
    "external_ref",
    "created_at",
  ]);
});

test("umbrella expected tasks table captures persisted membership", () => {
  h = createHarness();
  const cols = h.db
    .query<{ name: string }, []>(`PRAGMA table_info(umbrella_expected_tasks)`)
    .all()
    .map((r) => r.name);
  expect(cols).toEqual([
    "umbrella_expected_task_id",
    "umbrella_workflow_id",
    "external_ref",
    "title",
    "linear_issue_id",
    "linear_issue_url",
    "state",
    "completion_source",
    "completion_reason",
    "completed_at",
    "created_at",
    "updated_at",
  ]);

  const repoId = insertRepo(h.db, "repo-umbrella-expected");
  const workflow = h.db
    .query<{ umbrella_workflow_id: number }, [string, string, string, string, string, string]>(
      `INSERT INTO umbrella_workflows (
         external_ref, repo_id, base_branch, feature_branch, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       RETURNING umbrella_workflow_id`,
    )
    .get("BRIX-2000", repoId, "main", "quay/umbrella-BRIX-2000", "now", "now");
  expect(workflow).toBeDefined();

  h.db
    .query(
      `INSERT INTO umbrella_expected_tasks (
         umbrella_workflow_id, external_ref, title, linear_issue_url,
         state, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'expected', ?, ?)`,
    )
    .run(
      workflow!.umbrella_workflow_id,
      "BRIX-2001",
      "First child",
      "https://linear.app/inverter/issue/BRIX-2001",
      "now",
      "now",
    );

  expect(() =>
    h!.db
      .query(
        `INSERT INTO umbrella_expected_tasks (
           umbrella_workflow_id, external_ref, created_at, updated_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(workflow!.umbrella_workflow_id, "BRIX-2001", "now", "now"),
  ).toThrow();
  expect(() =>
    h!.db
      .query(
        `INSERT INTO umbrella_expected_tasks (
           umbrella_workflow_id, external_ref, created_at, updated_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(999999, "BRIX-9999", "now", "now"),
  ).toThrow();
});

test("task_dependencies table has generic dependency fields", () => {
  h = createHarness();
  const cols = h.db
    .query<{ name: string }, []>(`PRAGMA table_info(task_dependencies)`)
    .all()
    .map((r) => r.name);
  expect(cols).toEqual([
    "dependency_id",
    "dependent_task_id",
    "dependency_task_id",
    "dependency_source",
    "dependency_external_ref",
    "dependency_repo_id",
    "kind",
    "scope",
    "required_state",
    "satisfied_at",
    "created_at",
    "updated_at",
    "umbrella_workflow_id",
  ]);
});

test("tasks table has effective base_branch column", () => {
  h = createHarness();
  const cols = h.db
    .query<{ name: string }, []>(`PRAGMA table_info(tasks)`)
    .all()
    .map((r) => r.name);
  expect(cols).toContain("base_branch");
});

test("tasks table has retarget source link column", () => {
  h = createHarness();
  const cols = h.db
    .query<{ name: string }, []>(`PRAGMA table_info(tasks)`)
    .all()
    .map((r) => r.name);
  expect(cols).toContain("retargeted_from_task_id");
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

test("tasks table tracks retained cancelled worktree cleanup", () => {
  h = createHarness();
  const cols = h.db
    .query<{ name: string }, []>(`PRAGMA table_info(tasks)`)
    .all()
    .map((r) => r.name);
  expect(cols).toContain("worktree_cleaned_at");
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

test("review findings can store external provider links", () => {
  h = createHarness();
  const cols = h.db
    .query<{ name: string }, []>(
      `PRAGMA table_info(review_finding_external_links)`,
    )
    .all()
    .map((r) => r.name);
  expect(cols).toContain("finding_id");
  expect(cols).toContain("provider");
  expect(cols).toContain("provider_external_id");
  expect(cols).toContain("provider_url");
  expect(cols).toContain("outbox_item_id");
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
