// Spec §13: `data_dir` is operator-pinned via QUAY_DATA_DIR. When that env
// var is set to a non-empty value it MUST be the data dir — we never
// silently fall back to `~/.quay/` after the operator has named one
// explicitly (AST-89). Empty string is treated as unset, matching the
// config-loader's QUAY_DATA_DIR handling, so a `QUAY_DATA_DIR=` line in
// a systemd unit doesn't accidentally collapse the dir to the cwd-relative
// `quay.db`.

import { join } from "node:path";

export function resolveDataDir(
  env: NodeJS.ProcessEnv,
  configDataDir: string | undefined,
  home: string,
): string {
  const fromEnv = env.QUAY_DATA_DIR;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  if (configDataDir !== undefined && configDataDir !== "") {
    return configDataDir;
  }
  return join(home, ".quay");
}
