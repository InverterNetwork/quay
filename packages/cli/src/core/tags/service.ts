import { z } from "zod";
import type { DB } from "../../db/connection.ts";
import type { Clock } from "../../ports/clock.ts";
import { QuayError } from "../errors.ts";
import type { RepoService } from "../repos/service.ts";
import { repoIdSchema } from "../repos/schema.ts";
import { parseOrThrow } from "../zod_helpers.ts";

export type TagScope = "deployment" | "repo";

export interface TagNamespaceState {
  values: string[];
  required: boolean;
}

export type TagVocab = Record<string, TagNamespaceState>;
type TagApplyVocab = Record<string, { values: string[]; required?: boolean | undefined }>;

export interface TagServiceDeps {
  db: DB;
  clock: Clock;
  repoService: RepoService;
}

export interface TagService {
  getValues(scope: TagScope, repoId?: string): Record<string, string[]>;
  getRequired(scope: TagScope, repoId?: string): Record<string, boolean>;
  getVocab(scope: TagScope, repoId?: string): TagVocab;
  setValue(
    scope: TagScope,
    repoId: string | null,
    namespace: string,
    value: string,
  ): void;
  unsetValue(
    scope: TagScope,
    repoId: string | null,
    namespace: string,
    value?: string,
  ): void;
  setRequired(
    scope: TagScope,
    repoId: string | null,
    namespace: string,
    required: boolean,
  ): void;
  validateApply(
    scope: TagScope,
    repoId: string | null,
    desired: unknown,
  ): TagApplyVocab;
  apply(
    scope: TagScope,
    repoId: string | null,
    desired: unknown,
  ): TagVocab;
}

// Values may contain `-`, but namespaces may not — the validator parses tag
// tokens as `<namespace>-<value>` by splitting on the first `-`, so a dashed
// namespace would be unaddressable in any ticket tag.
const namespaceSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9]+$/, "must match [a-z0-9]+ (no dashes)");
const valueSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9-]+$/, "must match [a-z0-9-]+");

// A required namespace with zero values is an unsatisfiable state: every
// validate-ticket call would emit TAG_REQUIRED_MISSING with no possible tag
// able to clear it, bricking the repo until someone hand-edits the DB.
// Reject the shape at write time on every apply path.
const applySpecSchema = z
  .object({
    values: z.array(z.string()),
    required: z.boolean().optional(),
  })
  .strict()
  .refine(
    (s) => !(s.required === true && s.values.length === 0),
    { message: "namespace marked required must have at least one value" },
  );

const applyInputSchema = z.record(z.string(), applySpecSchema);

function validateInputs(
  scope: TagScope,
  repoId: string | null | undefined,
  namespace: string,
  value?: string,
): void {
  if (scope === "repo") {
    parseOrThrow(repoIdSchema, repoId, "repo_id");
  }
  parseOrThrow(namespaceSchema, namespace, "namespace");
  if (value !== undefined) {
    parseOrThrow(valueSchema, value, "value");
  }
}

export function createTagService({
  db,
  clock,
  repoService,
}: TagServiceDeps): TagService {
  function nowMs(): number {
    return clock.now().getTime();
  }

  function assertRepoExists(repoId: string): void {
    if (!repoService.get(repoId)) {
      throw new QuayError("unknown_repo", `repo "${repoId}" not found`, {
        repo_id: repoId,
      });
    }
  }

  function ensureRepoForScope(
    scope: TagScope,
    repoId: string | null | undefined,
  ): void {
    if (scope === "repo" && repoId !== null && repoId !== undefined) {
      assertRepoExists(repoId);
    }
  }

  function getValues(
    scope: TagScope,
    repoId?: string,
  ): Record<string, string[]> {
    ensureRepoForScope(scope, repoId);
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
    scope: TagScope,
    repoId?: string,
  ): Record<string, boolean> {
    ensureRepoForScope(scope, repoId);
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

  function getVocab(scope: TagScope, repoId?: string): TagVocab {
    const values = getValues(scope, repoId);
    const required = getRequired(scope, repoId);
    const namespaces = Array.from(
      new Set([...Object.keys(values), ...Object.keys(required)]),
    ).sort();
    const result: TagVocab = {};
    for (const ns of namespaces) {
      result[ns] = {
        values: values[ns] ?? [],
        required: required[ns] ?? false,
      };
    }
    return result;
  }

  function setValue(
    scope: TagScope,
    repoId: string | null,
    namespace: string,
    value: string,
  ): void {
    validateInputs(scope, repoId, namespace, value);
    ensureRepoForScope(scope, repoId);
    db.query(
      `INSERT OR IGNORE INTO tag_namespaces (scope, repo_id, namespace, value, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(scope, repoId, namespace, value, nowMs());
  }

  function unsetValue(
    scope: TagScope,
    repoId: string | null,
    namespace: string,
    value?: string,
  ): void {
    validateInputs(scope, repoId, namespace, value);
    ensureRepoForScope(scope, repoId);
    if (value !== undefined) {
      // Draining the last value of a required namespace would leave the meta
      // row stranded with `required=1` and no satisfying tag — a permanent
      // TAG_REQUIRED_MISSING. Cascade-clear the meta in the same transaction
      // so the namespace converges to "removed" rather than "bricked".
      const deleteValue = db.query(
        `DELETE FROM tag_namespaces
          WHERE scope = ? AND repo_id IS ? AND namespace = ? AND value = ?`,
      );
      const countRemaining = db.query<{ c: number }, [string, string | null, string]>(
        `SELECT COUNT(*) AS c FROM tag_namespaces
          WHERE scope = ? AND repo_id IS ? AND namespace = ?`,
      );
      const deleteMeta = db.query(
        `DELETE FROM tag_namespace_meta
          WHERE scope = ? AND repo_id IS ? AND namespace = ?`,
      );
      db.transaction(() => {
        deleteValue.run(scope, repoId, namespace, value);
        const remaining = countRemaining.get(scope, repoId, namespace)!.c;
        if (remaining === 0) deleteMeta.run(scope, repoId, namespace);
      })();
      return;
    }
    // Wrap the two DELETEs so a mid-flight failure can't leave the meta row
    // orphaned without its values (the apply path uses the same pattern).
    const deleteValues = db.query(
      `DELETE FROM tag_namespaces
        WHERE scope = ? AND repo_id IS ? AND namespace = ?`,
    );
    const deleteMeta = db.query(
      `DELETE FROM tag_namespace_meta
        WHERE scope = ? AND repo_id IS ? AND namespace = ?`,
    );
    db.transaction(() => {
      deleteValues.run(scope, repoId, namespace);
      deleteMeta.run(scope, repoId, namespace);
    })();
  }

  function setRequired(
    scope: TagScope,
    repoId: string | null,
    namespace: string,
    required: boolean,
  ): void {
    validateInputs(scope, repoId, namespace);
    ensureRepoForScope(scope, repoId);
    db.query(
      `INSERT INTO tag_namespace_meta (scope, repo_id, namespace, required, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (scope, IFNULL(repo_id, ''), namespace)
         DO UPDATE SET required = excluded.required`,
    ).run(scope, repoId, namespace, required ? 1 : 0, nowMs());
  }

  function validateApply(
    scope: TagScope,
    repoId: string | null,
    desiredRaw: unknown,
  ): TagApplyVocab {
    ensureRepoForScope(scope, repoId);
    const desired = parseOrThrow(applyInputSchema, desiredRaw, "apply");
    for (const [ns, spec] of Object.entries(desired)) {
      validateInputs(scope, repoId, ns);
      for (const v of spec.values) {
        parseOrThrow(valueSchema, v, `value in namespace "${ns}"`);
      }
    }
    return desired;
  }

  function apply(
    scope: TagScope,
    repoId: string | null,
    desiredRaw: unknown,
  ): TagVocab {
    const desired = validateApply(scope, repoId, desiredRaw);

    const insertValue = db.query(
      `INSERT OR IGNORE INTO tag_namespaces (scope, repo_id, namespace, value, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertMeta = db.query(
      `INSERT INTO tag_namespace_meta (scope, repo_id, namespace, required, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const deleteValues = db.query(
      `DELETE FROM tag_namespaces WHERE scope = ? AND repo_id IS ?`,
    );
    const deleteMeta = db.query(
      `DELETE FROM tag_namespace_meta WHERE scope = ? AND repo_id IS ?`,
    );

    db.transaction(() => {
      deleteValues.run(scope, repoId);
      deleteMeta.run(scope, repoId);
      const ts = nowMs();
      for (const [ns, spec] of Object.entries(desired)) {
        for (const v of spec.values) {
          insertValue.run(scope, repoId, ns, v, ts);
        }
        if (spec.required !== undefined) {
          insertMeta.run(scope, repoId, ns, spec.required ? 1 : 0, ts);
        }
      }
    })();

    return getVocab(scope, repoId === null ? undefined : repoId);
  }

  return {
    getValues,
    getRequired,
    getVocab,
    setValue,
    unsetValue,
    setRequired,
    validateApply,
    apply,
  };
}
