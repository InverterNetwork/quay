// Spec §13: QUAY_DATA_DIR is a hard pin — when set non-empty it MUST be
// the data dir, never a silent `~/.quay/` fallback. Empty string is
// treated as unset (matches config.ts) so `QUAY_DATA_DIR=` in a systemd
// unit can't collapse the dir to "" and write `quay.db` cwd-relative.

import { join } from "node:path";

export function resolveDataDir(
  env: NodeJS.ProcessEnv,
  configDataDir: string | undefined,
  home: string,
): string {
  const fromEnv = env.QUAY_DATA_DIR;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  if (configDataDir !== undefined) return configDataDir;
  return join(home, ".quay");
}
