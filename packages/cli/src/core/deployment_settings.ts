import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";
import type { QuayConfig } from "../cli/config.ts";

export interface DeploymentSettings {
  worker_agent: string | null;
  worker_model: string | null;
  reviewer_agent: string | null;
  reviewer_model: string | null;
}

export interface DeploymentSettingsRow extends DeploymentSettings {
  singleton_id: 1;
  created_at: string;
  updated_at: string;
}

export type DeploymentSettingsPatch = {
  [K in keyof DeploymentSettings]?: DeploymentSettings[K] | undefined;
};

export interface DeploymentSettingsService {
  get(): DeploymentSettings;
  getRow(): DeploymentSettingsRow | null;
  update(patch: DeploymentSettingsPatch): DeploymentSettingsRow;
  replace(settings: DeploymentSettings): DeploymentSettingsRow;
  importFromConfig(config: QuayConfig, opts?: { onlyEmpty?: boolean }): DeploymentSettingsRow;
}

export function createDeploymentSettingsService(deps: {
  db: DB;
  clock?: Clock;
}): DeploymentSettingsService {
  const nowISO = () => deps.clock?.nowISO() ?? new Date().toISOString();

  function getRow(): DeploymentSettingsRow | null {
    return deps.db
      .query<DeploymentSettingsRow, []>(
        `SELECT singleton_id, worker_agent, worker_model, reviewer_agent,
                reviewer_model, created_at, updated_at
           FROM deployment_settings
          WHERE singleton_id = 1`,
      )
      .get() ?? null;
  }

  function get(): DeploymentSettings {
    const row = getRow();
    return {
      worker_agent: row?.worker_agent ?? null,
      worker_model: row?.worker_model ?? null,
      reviewer_agent: row?.reviewer_agent ?? null,
      reviewer_model: row?.reviewer_model ?? null,
    };
  }

  function update(patch: DeploymentSettingsPatch): DeploymentSettingsRow {
    const current = getRow();
    const next: DeploymentSettings = {
      worker_agent: valueOrCurrent(patch.worker_agent, current?.worker_agent ?? null),
      worker_model: valueOrCurrent(patch.worker_model, current?.worker_model ?? null),
      reviewer_agent: valueOrCurrent(patch.reviewer_agent, current?.reviewer_agent ?? null),
      reviewer_model: valueOrCurrent(patch.reviewer_model, current?.reviewer_model ?? null),
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
           reviewer_model, created_at, updated_at
         ) VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(singleton_id) DO UPDATE SET
           worker_agent = excluded.worker_agent,
           worker_model = excluded.worker_model,
           reviewer_agent = excluded.reviewer_agent,
           reviewer_model = excluded.reviewer_model,
           updated_at = excluded.updated_at`,
      )
      .run(
        settings.worker_agent,
        settings.worker_model,
        settings.reviewer_agent,
        settings.reviewer_model,
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
    };
    if (opts.onlyEmpty !== true) return update(patch);

    const current = get();
    return replace({
      worker_agent: current.worker_agent ?? patch.worker_agent ?? null,
      worker_model: current.worker_model ?? patch.worker_model ?? null,
      reviewer_agent: current.reviewer_agent ?? patch.reviewer_agent ?? null,
      reviewer_model: current.reviewer_model ?? patch.reviewer_model ?? null,
    });
  }

  return { get, getRow, update, replace, importFromConfig };
}

function valueOrCurrent<T>(value: T | undefined, current: T): T {
  return value === undefined ? current : value;
}
