import { z } from "zod";
import type { DB } from "../../db/connection.ts";
import type { Clock } from "../../ports/clock.ts";
import { QuayError } from "../errors.ts";
import { repoIdSchema } from "../repos/schema.ts";

export interface TagServiceDeps {
  db: DB;
  clock: Clock;
}

export interface TagService {
  getValues(
    scope: "deployment" | "repo",
    repoId?: string,
  ): Record<string, string[]>;
  getRequired(
    scope: "deployment" | "repo",
    repoId?: string,
  ): Record<string, boolean>;
  setValue(
    scope: "deployment" | "repo",
    repoId: string | null,
    namespace: string,
    value: string,
  ): void;
  unsetValue(
    scope: "deployment" | "repo",
    repoId: string | null,
    namespace: string,
    value?: string,
  ): void;
  setRequired(
    scope: "deployment" | "repo",
    repoId: string | null,
    namespace: string,
    required: boolean,
  ): void;
  apply(
    scope: "deployment" | "repo",
    repoId: string | null,
    desired: Record<string, { values: string[]; required?: boolean }>,
  ): void;
}

const namespaceLabelSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9-]+$/, "must match [a-z0-9-]+");

const valueLabelSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9-]+$/, "must match [a-z0-9-]+");

function parseOrThrow<T>(
  schema: {
    safeParse: (
      v: unknown,
    ) =>
      | { success: true; data: T }
      | {
          success: false;
          error: { issues: { path: (string | number)[]; message: string }[] };
        };
  },
  raw: unknown,
  label: string,
): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const summary = result.error.issues
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
  throw new QuayError(
    "validation_error",
    `${label} input invalid: ${summary}`,
    { issues: result.error.issues },
  );
}

function validateInputs(
  scope: "deployment" | "repo",
  repoId: string | null | undefined,
  namespace: string,
  value?: string,
): void {
  if (scope === "repo") {
    parseOrThrow(repoIdSchema, repoId, "repo_id");
  }
  parseOrThrow(namespaceLabelSchema, namespace, "namespace");
  if (value !== undefined) {
    parseOrThrow(valueLabelSchema, value, "value");
  }
}

function checkRepoExists(db: DB, repoId: string): void {
  const row = db
    .query<{ repo_id: string }, [string]>(
      "SELECT repo_id FROM repos WHERE repo_id = ?",
    )
    .get(repoId);
  if (!row) {
    throw new QuayError("unknown_repo", `repo "${repoId}" not found`, {
      repo_id: repoId,
    });
  }
}

export function createTagService({ db, clock }: TagServiceDeps): TagService {
  function nowMs(): number {
    // Clock exposes ISO strings; parse to unix-ms for the INTEGER column.
    return Date.parse(clock.nowISO());
  }

  function getValues(
    scope: "deployment" | "repo",
    repoId?: string,
  ): Record<string, string[]> {
    const effectiveRepoId = scope === "repo" ? (repoId ?? null) : null;
    const rows = db
      .query<{ namespace: string; value: string }, [string, string | null]>(
        `SELECT namespace, value FROM tag_namespaces
          WHERE scope = ? AND repo_id IS ?
          ORDER BY namespace ASC, value ASC`,
      )
      .all(scope, effectiveRepoId);
    const result: Record<string, string[]> = {};
    for (const row of rows) {
      if (!result[row.namespace]) result[row.namespace] = [];
      result[row.namespace]!.push(row.value);
    }
    return result;
  }

  function getRequired(
    scope: "deployment" | "repo",
    repoId?: string,
  ): Record<string, boolean> {
    const effectiveRepoId = scope === "repo" ? (repoId ?? null) : null;
    const rows = db
      .query<
        { namespace: string; required: number },
        [string, string | null]
      >(
        `SELECT namespace, required FROM tag_namespace_meta
          WHERE scope = ? AND repo_id IS ?`,
      )
      .all(scope, effectiveRepoId);
    const result: Record<string, boolean> = {};
    for (const row of rows) {
      result[row.namespace] = row.required !== 0;
    }
    return result;
  }

  function setValue(
    scope: "deployment" | "repo",
    repoId: string | null,
    namespace: string,
    value: string,
  ): void {
    validateInputs(scope, repoId, namespace, value);
    if (scope === "repo" && repoId !== null) {
      checkRepoExists(db, repoId);
    }
    db.query(
      `INSERT OR IGNORE INTO tag_namespaces (scope, repo_id, namespace, value, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(scope, repoId, namespace, value, nowMs());
  }

  function unsetValue(
    scope: "deployment" | "repo",
    repoId: string | null,
    namespace: string,
    value?: string,
  ): void {
    validateInputs(scope, repoId, namespace, value);
    if (value !== undefined) {
      db.query(
        `DELETE FROM tag_namespaces
          WHERE scope = ? AND repo_id IS ? AND namespace = ? AND value = ?`,
      ).run(scope, repoId, namespace, value);
    } else {
      db.query(
        `DELETE FROM tag_namespaces
          WHERE scope = ? AND repo_id IS ? AND namespace = ?`,
      ).run(scope, repoId, namespace);
      db.query(
        `DELETE FROM tag_namespace_meta
          WHERE scope = ? AND repo_id IS ? AND namespace = ?`,
      ).run(scope, repoId, namespace);
    }
  }

  function setRequired(
    scope: "deployment" | "repo",
    repoId: string | null,
    namespace: string,
    required: boolean,
  ): void {
    validateInputs(scope, repoId, namespace);
    db.query(
      `INSERT INTO tag_namespace_meta (scope, repo_id, namespace, required, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (scope, repo_id, namespace) DO UPDATE SET required = excluded.required`,
    ).run(scope, repoId, namespace, required ? 1 : 0, nowMs());
  }

  function apply(
    scope: "deployment" | "repo",
    repoId: string | null,
    desired: Record<string, { values: string[]; required?: boolean }>,
  ): void {
    if (scope === "repo" && repoId !== null) {
      checkRepoExists(db, repoId);
    }
    // Validate all inputs before any writes.
    for (const [ns, spec] of Object.entries(desired)) {
      validateInputs(scope, repoId, ns);
      for (const v of spec.values) {
        parseOrThrow(valueLabelSchema, v, `value in namespace "${ns}"`);
      }
    }

    db.transaction(() => {
      // Clear everything for this scope/repo then re-insert desired state.
      db.query(
        `DELETE FROM tag_namespaces WHERE scope = ? AND repo_id IS ?`,
      ).run(scope, repoId);
      db.query(
        `DELETE FROM tag_namespace_meta WHERE scope = ? AND repo_id IS ?`,
      ).run(scope, repoId);

      const ts = nowMs();
      for (const [ns, spec] of Object.entries(desired)) {
        for (const v of spec.values) {
          db.query(
            `INSERT INTO tag_namespaces (scope, repo_id, namespace, value, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          ).run(scope, repoId, ns, v, ts);
        }
        if (spec.required !== undefined) {
          db.query(
            `INSERT INTO tag_namespace_meta (scope, repo_id, namespace, required, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          ).run(scope, repoId, ns, spec.required ? 1 : 0, ts);
        }
      }
    })();
  }

  return { getValues, getRequired, setValue, unsetValue, setRequired, apply };
}
