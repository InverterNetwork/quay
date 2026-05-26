import { accessSync, constants } from "node:fs";

const CONFIG_ENV_KEYS = [
  "QUAY_CONFIG_FILE",
  "QUAY_CONFIG_DIR",
  "QUAY_DATA_DIR",
] as const;

export interface StartupEnvHazardOptions {
  env: NodeJS.ProcessEnv;
  invocationCwd: string | undefined;
  canReadDir?: (path: string) => boolean;
}

function defaultCanReadDir(path: string): boolean {
  try {
    accessSync(path, constants.R_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function hasVisibleConfigEnv(env: NodeJS.ProcessEnv): boolean {
  return CONFIG_ENV_KEYS.some((key) => {
    const value = env[key];
    return value !== undefined && value !== "";
  });
}

export function detectStartupEnvHazard(
  opts: StartupEnvHazardOptions,
): string | null {
  if (hasVisibleConfigEnv(opts.env)) return null;

  if (opts.invocationCwd === undefined) {
    return [
      "startup environment is unsafe: inherited cwd could not be resolved",
      "and no QUAY_CONFIG_FILE, QUAY_CONFIG_DIR, or QUAY_DATA_DIR value",
      "is visible in process.env; refusing to use the ~/.quay fallback",
    ].join(" ");
  }

  const canReadDir = opts.canReadDir ?? defaultCanReadDir;
  if (!canReadDir(opts.invocationCwd)) {
    return [
      `startup environment is unsafe: inherited cwd "${opts.invocationCwd}"`,
      "is not readable/searchable and no QUAY_CONFIG_FILE, QUAY_CONFIG_DIR,",
      "or QUAY_DATA_DIR value is visible in process.env; refusing to use",
      "the ~/.quay fallback",
    ].join(" ");
  }

  return null;
}
