import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";

export type IdentityMappingStatus = "mapped" | "verified" | "conflict";
export type IdentityMappingSource = "manual" | "csv" | "auto" | "task";

export interface IdentityMappingInput {
  slack_user_id: string;
  slack_display_name: string;
  slack_handle?: string | null | undefined;
  slack_email?: string | null | undefined;
  github_login: string;
  status?: IdentityMappingStatus | undefined;
  source?: IdentityMappingSource | undefined;
}

export interface IdentityMapping {
  slack_user_id: string;
  slack_display_name: string;
  slack_handle: string | null;
  slack_email: string | null;
  github_login: string;
  status: IdentityMappingStatus;
  source: IdentityMappingSource;
  last_used_at: string | null;
  last_used_task_id: string | null;
  last_used_pr_number: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface IdentityMappingService {
  list(): IdentityMapping[];
  findBySlackId(slackUserId: string): IdentityMapping | null;
  replaceAll(mappings: IdentityMappingInput[]): IdentityMapping[];
  markUsed(input: {
    slackUserId: string;
    taskId: string;
    prNumber: number;
  }): void;
  markConflict(input: {
    slackUserId: string;
    error: string;
  }): void;
}

export function createIdentityMappingService(deps: {
  db: DB;
  clock?: Clock;
}): IdentityMappingService {
  const nowISO = () => deps.clock?.nowISO() ?? new Date().toISOString();

  function list(): IdentityMapping[] {
    return deps.db
      .query<IdentityMapping, []>(
        `SELECT slack_user_id, slack_display_name, slack_handle, slack_email,
                github_login, status, source, last_used_at, last_used_task_id,
                last_used_pr_number, last_error, created_at, updated_at
           FROM identity_mappings
          ORDER BY lower(slack_display_name), slack_user_id`,
      )
      .all();
  }

  function findBySlackId(slackUserId: string): IdentityMapping | null {
    return deps.db
      .query<IdentityMapping, [string]>(
        `SELECT slack_user_id, slack_display_name, slack_handle, slack_email,
                github_login, status, source, last_used_at, last_used_task_id,
                last_used_pr_number, last_error, created_at, updated_at
           FROM identity_mappings
          WHERE slack_user_id = ?`,
      )
      .get(slackUserId) ?? null;
  }

  function replaceAll(mappings: IdentityMappingInput[]): IdentityMapping[] {
    const normalized = normalizeInputs(mappings);
    const existing = new Map(list().map((mapping) => [mapping.slack_user_id, mapping]));
    const now = nowISO();
    deps.db.transaction(() => {
      deps.db.query(`DELETE FROM identity_mappings`).run();
      const insert = deps.db.query(
        `INSERT INTO identity_mappings (
           slack_user_id, slack_display_name, slack_handle, slack_email,
           github_login, status, source, last_used_at, last_used_task_id,
           last_used_pr_number, last_error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const mapping of normalized) {
        const prev = existing.get(mapping.slack_user_id);
        const sameLogin = prev?.github_login.toLowerCase() === mapping.github_login.toLowerCase();
        insert.run(
          mapping.slack_user_id,
          mapping.slack_display_name,
          mapping.slack_handle ?? null,
          mapping.slack_email ?? null,
          mapping.github_login,
          mapping.status ?? "mapped",
          mapping.source ?? prev?.source ?? "manual",
          sameLogin ? prev?.last_used_at ?? null : null,
          sameLogin ? prev?.last_used_task_id ?? null : null,
          sameLogin ? prev?.last_used_pr_number ?? null : null,
          sameLogin ? prev?.last_error ?? null : null,
          prev?.created_at ?? now,
          now,
        );
      }
    })();
    return list();
  }

  function markUsed(input: {
    slackUserId: string;
    taskId: string;
    prNumber: number;
  }): void {
    const now = nowISO();
    deps.db
      .query(
        `UPDATE identity_mappings
            SET status = 'verified',
                last_used_at = ?,
                last_used_task_id = ?,
                last_used_pr_number = ?,
                last_error = NULL,
                updated_at = ?
          WHERE slack_user_id = ?`,
      )
      .run(now, input.taskId, input.prNumber, now, input.slackUserId);
  }

  function markConflict(input: {
    slackUserId: string;
    error: string;
  }): void {
    deps.db
      .query(
        `UPDATE identity_mappings
            SET status = 'conflict',
                last_error = ?,
                updated_at = ?
          WHERE slack_user_id = ?`,
      )
      .run(input.error, nowISO(), input.slackUserId);
  }

  return { list, findBySlackId, replaceAll, markUsed, markConflict };
}

export function normalizeIdentityMappingInput(
  mapping: IdentityMappingInput,
): IdentityMappingInput {
  return {
    slack_user_id: mapping.slack_user_id.trim(),
    slack_display_name: mapping.slack_display_name.trim(),
    slack_handle: normalizeNullable(mapping.slack_handle),
    slack_email: normalizeNullable(mapping.slack_email),
    github_login: mapping.github_login.trim(),
    status: mapping.status ?? "mapped",
    source: mapping.source ?? "manual",
  };
}

export function editableIdentityMapping(
  mapping: IdentityMapping,
): Required<IdentityMappingInput> {
  return {
    slack_user_id: mapping.slack_user_id,
    slack_display_name: mapping.slack_display_name,
    slack_handle: mapping.slack_handle,
    slack_email: mapping.slack_email,
    github_login: mapping.github_login,
    status: mapping.status,
    source: mapping.source,
  };
}

function normalizeInputs(mappings: IdentityMappingInput[]): IdentityMappingInput[] {
  return mappings
    .map(normalizeIdentityMappingInput)
    .filter((mapping) =>
      mapping.slack_user_id !== "" &&
      mapping.slack_display_name !== "" &&
      mapping.github_login !== ""
    )
    .sort((a, b) => a.slack_user_id.localeCompare(b.slack_user_id));
}

function normalizeNullable(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? null : trimmed;
}
