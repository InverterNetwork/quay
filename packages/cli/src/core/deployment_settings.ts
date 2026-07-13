import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";
import type { QuayConfig } from "../cli/config.ts";

export interface DeploymentSettings {
  worker_agent: string | null;
  worker_model: string | null;
  reviewer_agent: string | null;
  reviewer_model: string | null;
  // Global default for filing non-blocking review findings as Linear issues.
  // NULL means unset, which resolves to ON (the current intended behavior).
  review_finding_linear_enabled: boolean | null;
}

export interface DeploymentSettingsRow extends DeploymentSettings {
  singleton_id: 1;
  created_at: string;
  updated_at: string;
}

// SQLite stores the tri-state toggle as a nullable INTEGER (NULL/0/1); the
// service surface speaks `boolean | null` so callers never juggle 0/1.
interface DeploymentSettingsDbRow {
  singleton_id: 1;
  worker_agent: string | null;
  worker_model: string | null;
  reviewer_agent: string | null;
  reviewer_model: string | null;
  review_finding_linear_enabled: number | null;
  created_at: string;
  updated_at: string;
}

function intToBool(value: number | null): boolean | null {
  return value === null ? null : value !== 0;
}

function boolToInt(value: boolean | null): number | null {
  return value === null ? null : value ? 1 : 0;
}

export type DeploymentSettingsPatch = {
  [K in keyof DeploymentSettings]?: DeploymentSettings[K] | undefined;
};

export interface DeploymentSettingsService {
  get(): DeploymentSettings;
  getRow(): DeploymentSettingsRow | null;
  update(
    patch: DeploymentSettingsPatch,
    opts?: { defaultsWhenEmpty?: DeploymentSettings },
  ): DeploymentSettingsRow;
  replace(settings: DeploymentSettings): DeploymentSettingsRow;
  importFromConfig(config: QuayConfig, opts?: { onlyEmpty?: boolean }): DeploymentSettingsRow;
}

export function createDeploymentSettingsService(deps: {
  db: DB;
  clock?: Clock;
}): DeploymentSettingsService {
  const nowISO = () => deps.clock?.nowISO() ?? new Date().toISOString();

  function getRow(): DeploymentSettingsRow | null {
    const row = deps.db
      .query<DeploymentSettingsDbRow, []>(
        `SELECT singleton_id, worker_agent, worker_model, reviewer_agent,
                reviewer_model, review_finding_linear_enabled, created_at, updated_at
           FROM deployment_settings
          WHERE singleton_id = 1`,
      )
      .get();
    if (row === null || row === undefined) return null;
    return {
      singleton_id: row.singleton_id,
      worker_agent: row.worker_agent,
      worker_model: row.worker_model,
      reviewer_agent: row.reviewer_agent,
      reviewer_model: row.reviewer_model,
      review_finding_linear_enabled: intToBool(row.review_finding_linear_enabled),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  function get(): DeploymentSettings {
    const row = getRow();
    return {
      worker_agent: row?.worker_agent ?? null,
      worker_model: row?.worker_model ?? null,
      reviewer_agent: row?.reviewer_agent ?? null,
      reviewer_model: row?.reviewer_model ?? null,
      review_finding_linear_enabled: row?.review_finding_linear_enabled ?? null,
    };
  }

  function update(
    patch: DeploymentSettingsPatch,
    opts: { defaultsWhenEmpty?: DeploymentSettings } = {},
  ): DeploymentSettingsRow {
    const current = getRow();
    const base = current ?? opts.defaultsWhenEmpty ?? null;
    const next: DeploymentSettings = {
      worker_agent: valueOrCurrent(patch.worker_agent, base?.worker_agent ?? null),
      worker_model: valueOrCurrent(patch.worker_model, base?.worker_model ?? null),
      reviewer_agent: valueOrCurrent(patch.reviewer_agent, base?.reviewer_agent ?? null),
      reviewer_model: valueOrCurrent(patch.reviewer_model, base?.reviewer_model ?? null),
      review_finding_linear_enabled: valueOrCurrent(
        patch.review_finding_linear_enabled,
        base?.review_finding_linear_enabled ?? null,
      ),
    };
    return replace(next);
  }

  function replace(settings: DeploymentSettings): DeploymentSettingsRow {
    const current = getRow();
    const now = nowISO();
    deps.db
      .query(
        `INSERT INTO deployment_settings (
           singleton_id, worker_agent, worker_model, reviewer_agent,
           reviewer_model, review_finding_linear_enabled, created_at, updated_at
         ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(singleton_id) DO UPDATE SET
           worker_agent = excluded.worker_agent,
           worker_model = excluded.worker_model,
           reviewer_agent = excluded.reviewer_agent,
           reviewer_model = excluded.reviewer_model,
           review_finding_linear_enabled = excluded.review_finding_linear_enabled,
           updated_at = excluded.updated_at`,
      )
      .run(
        settings.worker_agent,
        settings.worker_model,
        settings.reviewer_agent,
        settings.reviewer_model,
        boolToInt(settings.review_finding_linear_enabled),
        current?.created_at ?? now,
        now,
      );
    const row = getRow();
    if (row === null) {
      throw new Error("failed to persist deployment settings");
    }
    return row;
  }

  function importFromConfig(
    config: QuayConfig,
    opts: { onlyEmpty?: boolean } = {},
  ): DeploymentSettingsRow {
    const patch: DeploymentSettingsPatch = {
      worker_agent: config.agents?.worker ?? null,
      worker_model: config.agents?.worker_model ?? null,
      reviewer_agent: config.agents?.reviewer ?? null,
      reviewer_model: config.agents?.reviewer_model ?? null,
      // No config-file source: leave the toggle unset so it resolves to ON.
      review_finding_linear_enabled: null,
    };
    if (opts.onlyEmpty !== true) return update(patch);

    const current = getRow();
    if (current !== null) return current;

    return replace({
      worker_agent: patch.worker_agent ?? null,
      worker_model: patch.worker_model ?? null,
      reviewer_agent: patch.reviewer_agent ?? null,
      reviewer_model: patch.reviewer_model ?? null,
      review_finding_linear_enabled: patch.review_finding_linear_enabled ?? null,
    });
  }

  return { get, getRow, update, replace, importFromConfig };
}

function valueOrCurrent<T>(value: T | undefined, current: T): T {
  return value === undefined ? current : value;
}
