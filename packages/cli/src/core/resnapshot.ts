import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";
import type { LinearPort } from "../ports/linear.ts";
import type { SlackPort } from "../ports/slack.ts";
import type { SupervisorLock } from "./supervisor_lock.ts";
import { fetchTicketContextWithIssue } from "./ticket_context.ts";

// The top-level keys `composeTicketSnapshot` emits (ticket_context.ts). Any
// other key in a stored snapshot — `linear_blocked_by_relations`,
// `linear_hierarchy`, `linear_umbrella_membership_override` — is a
// creation-time augmentation the enqueue-linear path bolts on and that
// resnapshot does NOT recompute. Those keys are preserved verbatim so
// re-baselining the definition-of-done never drops dependency / hierarchy
// context.
const SNAPSHOT_CORE_KEYS = [
  "linear_issue",
  "quay_config_block",
  "slack_thread_ref",
  "slack_thread",
] as const;

export type ResnapshotErrorCode =
  | "unknown_task"
  | "missing_external_ref"
  | "missing_reason";

export interface ResnapshotError {
  code: ResnapshotErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type ResnapshotResult =
  | { ok: true; value: ResnapshotValue }
  | { ok: false; error: ResnapshotError };

export interface ResnapshotValue {
  task_id: string;
  external_ref: string;
  // Whether the definition-of-done (core snapshot keys) actually changed.
  // False means the run was a still-audited no-op: the event is recorded but
  // the artifact is not rewritten and no review verdict is invalidated.
  changed: boolean;
  // Count of terminal review verdicts (`approved` / `changes_requested`)
  // superseded so the next tick re-reviews against the new snapshot.
  review_invalidated: number;
  // New artifacts written on a changed resnapshot, or null on a no-op.
  snapshot_artifact_id: number | null;
  objective_artifact_id: number | null;
  event_id: number;
}

export interface ResnapshotDeps {
  db: DB;
  clock: Clock;
  artifactStore: ArtifactStore;
  supervisorLock: SupervisorLock;
  linear: LinearPort;
  slack: SlackPort;
  adaptersConfig: { linearEnabled: boolean; slackEnabled: boolean };
}

export interface ResnapshotInput {
  taskId: string;
  reason: string;
}

interface TaskRow {
  task_id: string;
  external_ref: string | null;
  state: string;
}

interface ArtifactRow {
  file_path: string;
}

export async function task_resnapshot(
  deps: ResnapshotDeps,
  input: ResnapshotInput,
): Promise<ResnapshotResult> {
  const reason = input.reason.trim();
  if (reason.length === 0) {
    return {
      ok: false,
      error: {
        code: "missing_reason",
        message: "task resnapshot requires a non-empty --reason",
      },
    };
  }

  const task = loadTask(deps.db, input.taskId);
  if (task === null) {
    return {
      ok: false,
      error: {
        code: "unknown_task",
        message: `task ${input.taskId} not found`,
        details: { task_id: input.taskId },
      },
    };
  }
  if (task.external_ref === null) {
    return {
      ok: false,
      error: {
        code: "missing_external_ref",
        message: `task ${input.taskId} has no external_ref; nothing to re-fetch`,
        details: { task_id: input.taskId },
      },
    };
  }

  // Re-fetch + re-parse + re-compose via the exact enqueue code path. This is
  // a pure read, so it runs before the supervisor lock. It throws QuayError
  // (adapter_not_enabled, ticket_not_found, ticket_block_invalid,
  // adapter_error) which the CLI maps to the stderr error contract.
  const fetched = await fetchTicketContextWithIssue(
    { linear: deps.linear, slack: deps.slack, config: deps.adaptersConfig },
    task.external_ref,
  );
  const freshSnapshot = fetched.ctx.ticket_snapshot;
  const freshBrief = fetched.ctx.brief;

  const externalRef = task.external_ref;
  return deps.supervisorLock.run(() =>
    resnapshotUnderLock(deps, task, externalRef, freshSnapshot, freshBrief, reason),
  );
}

function resnapshotUnderLock(
  deps: ResnapshotDeps,
  task: TaskRow,
  externalRef: string,
  freshSnapshot: string,
  freshBrief: string,
  reason: string,
): ResnapshotResult {
  const now = deps.clock.nowISO();
  const oldContent = loadArtifactContent(deps.db, task.task_id, "ticket_snapshot");
  const freshParsed = parseJsonObject(freshSnapshot);
  const oldParsed = oldContent === null ? null : parseJsonObject(oldContent);

  const freshCore = coreSubset(freshParsed);
  const oldCore = coreSubset(oldParsed);
  // "Unchanged" is measured on the definition-of-done (core keys) only, so a
  // task whose stored snapshot carries creation-time augmentations still
  // no-ops when the ticket body / config block are identical.
  const changed =
    oldContent === null ||
    JSON.stringify(freshCore) !== JSON.stringify(oldCore);

  let snapshotArtifactId: number | null = null;
  let objectiveArtifactId: number | null = null;
  let reviewInvalidated = 0;
  let eventId = -1;
  let snapshotContentAfter = oldContent;

  deps.db.exec("BEGIN");
  try {
    if (changed) {
      // Preserve non-core augmentation keys (and their original positions)
      // from the prior snapshot; overwrite only the core definition-of-done
      // keys with the freshly fetched values.
      const merged: Record<string, unknown> =
        oldParsed === null ? {} : { ...oldParsed };
      for (const key of SNAPSHOT_CORE_KEYS) {
        if (key in freshParsed) merged[key] = freshParsed[key];
        else delete merged[key];
      }
      const snapshotContent = JSON.stringify(merged, null, 2);
      const writtenSnapshot = deps.artifactStore.writeArtifact({
        taskId: task.task_id,
        attemptId: null,
        kind: "ticket_snapshot",
        content: snapshotContent,
        extension: "md",
      });
      snapshotArtifactId = writtenSnapshot.artifactId;
      snapshotContentAfter = snapshotContent;

      const writtenObjective = deps.artifactStore.writeArtifact({
        taskId: task.task_id,
        attemptId: null,
        kind: "task_objective",
        content: freshBrief,
        extension: "md",
      });
      objectiveArtifactId = writtenObjective.artifactId;

      deps.db
        .query(`UPDATE task_goals SET objective = ?, updated_at = ? WHERE task_id = ?`)
        .run(freshBrief, now, task.task_id);

      reviewInvalidated = invalidateLatestReview(deps.db, task.task_id);
    }

    const eventData: Record<string, unknown> = {
      reason,
      external_ref: externalRef,
      changed,
      review_invalidated: reviewInvalidated,
      snapshot_artifact_id: snapshotArtifactId,
      objective_artifact_id: objectiveArtifactId,
      before_snapshot_hash: oldContent === null ? null : sha256(oldContent),
      after_snapshot_hash:
        snapshotContentAfter === null ? null : sha256(snapshotContentAfter),
      diff: diffCore(oldCore, freshCore),
    };

    const eventRow = deps.db
      .query<{ event_id: number }, [string, string, string, string, string]>(
        `INSERT INTO events (
           task_id, event_type, from_state, to_state, occurred_at, event_data
         ) VALUES (?, 'ticket_resnapshotted', ?, ?, ?, ?)
         RETURNING event_id`,
      )
      .get(task.task_id, task.state, task.state, now, JSON.stringify(eventData));
    if (!eventRow) {
      throw new Error("ticket_resnapshotted event insert returned no row");
    }
    eventId = eventRow.event_id;
    deps.db.exec("COMMIT");
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }

  return {
    ok: true,
    value: {
      task_id: task.task_id,
      external_ref: externalRef,
      changed,
      review_invalidated: reviewInvalidated,
      snapshot_artifact_id: snapshotArtifactId,
      objective_artifact_id: objectiveArtifactId,
      event_id: eventId,
    },
  };
}

// Supersede every terminal reviewer verdict on the task's review-only
// attempts. The `enterReview` gate skips scheduling when a review-only attempt
// for the current head SHA already holds `approved` / `changes_requested`
// (`terminal_verdict_exists`); flipping those to `superseded` — the same
// marker enterReview and terminal cleanup already use — clears the gate so the
// next tick runs a fresh review against the re-baselined snapshot. Returns the
// number of verdicts invalidated.
function invalidateLatestReview(db: DB, taskId: string): number {
  const result = db
    .query(
      `UPDATE attempts
          SET review_verdict = 'superseded'
        WHERE task_id = ?
          AND reason = 'review_only'
          AND review_verdict IN ('approved', 'changes_requested')`,
    )
    .run(taskId);
  return Number(result.changes);
}

function loadTask(db: DB, taskId: string): TaskRow | null {
  return (
    db
      .query<TaskRow, [string]>(
        `SELECT task_id, external_ref, state FROM tasks WHERE task_id = ?`,
      )
      .get(taskId) ?? null
  );
}

function loadArtifactContent(
  db: DB,
  taskId: string,
  kind: string,
): string | null {
  const row =
    db
      .query<ArtifactRow, [string, string]>(
        `SELECT file_path
           FROM artifacts
          WHERE task_id = ? AND kind = ? AND attempt_id IS NULL
          ORDER BY artifact_id DESC
          LIMIT 1`,
      )
      .get(taskId, kind) ?? null;
  if (row === null) return null;
  return readFileSync(row.file_path, "utf8");
}

function coreSubset(
  obj: Record<string, unknown> | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (obj === null) return out;
  for (const key of SNAPSHOT_CORE_KEYS) {
    if (key in obj) out[key] = obj[key];
  }
  return out;
}

// Field-level before/after diff of the core snapshot keys. Object values are
// expanded one level so, e.g., a changed `linear_issue.body` is reported on
// its own without dumping every unchanged sibling field.
function diffCore(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, unknown> {
  const diff: Record<string, unknown> = {};
  for (const key of SNAPSHOT_CORE_KEYS) {
    const b = before[key];
    const a = after[key];
    if (JSON.stringify(b) === JSON.stringify(a)) continue;
    diff[key] = diffValue(b, a);
  }
  return diff;
}

function diffValue(before: unknown, after: unknown): unknown {
  if (isPlainObject(before) && isPlainObject(after)) {
    const sub: Record<string, unknown> = {};
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
      sub[key] = { before: before[key] ?? null, after: after[key] ?? null };
    }
    return sub;
  }
  return { before: before ?? null, after: after ?? null };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function parseJsonObject(s: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(s);
    if (isPlainObject(parsed)) return parsed;
  } catch {
    // Non-JSON stored snapshot (never produced by the enqueue path). Treat as
    // structureless so the fresh snapshot fully replaces it.
  }
  return {};
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
