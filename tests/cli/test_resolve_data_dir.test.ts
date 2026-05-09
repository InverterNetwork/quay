// AST-89: QUAY_DATA_DIR is a hard pin. When the operator names a data dir
// explicitly via the env var, quay must use it and only it — no silent
// fallback to `~/.quay/` on top of an explicit signal. The bug that
// motivated this contract was a silent re-creation of the legacy
// `~/.quay/` data dir under `sudo -u hermes ...` (cwd `/root` unreadable
// to hermes), which defeated the operator-side reconciler that had just
// deleted that directory.
//
// Empty string is treated as unset, matching the config-loader's
// QUAY_DATA_DIR handling (`src/cli/config.ts`). This prevents a stray
// `QUAY_DATA_DIR=` line in a systemd unit from collapsing the dir to `""`
// and writing `quay.db` cwd-relative.

import { expect, test } from "bun:test";
import { resolveDataDir } from "../../src/cli/data_dir.ts";

test("QUAY_DATA_DIR wins over config.data_dir and home fallback", () => {
  const env = { QUAY_DATA_DIR: "/canonical/data" };
  expect(resolveDataDir(env, "/from/config", "/home/user")).toBe(
    "/canonical/data",
  );
});

test("QUAY_DATA_DIR empty string is treated as unset (config wins)", () => {
  const env = { QUAY_DATA_DIR: "" };
  expect(resolveDataDir(env, "/from/config", "/home/user")).toBe(
    "/from/config",
  );
});

test("QUAY_DATA_DIR empty string with no config falls back to <home>/.quay", () => {
  // Belt-and-braces: an empty env var must never resolve to "" and write
  // `quay.db` cwd-relative.
  const env = { QUAY_DATA_DIR: "" };
  expect(resolveDataDir(env, undefined, "/home/user")).toBe("/home/user/.quay");
});

test("config.data_dir wins over home fallback when QUAY_DATA_DIR is unset", () => {
  expect(resolveDataDir({}, "/from/config", "/home/user")).toBe("/from/config");
});

test("falls back to <home>/.quay when nothing is set", () => {
  expect(resolveDataDir({}, undefined, "/home/user")).toBe("/home/user/.quay");
});

test("config.data_dir empty string is treated as unset", () => {
  // The config schema enforces min_length=1, but the resolver guards
  // defensively so a future relaxation can't silently produce "".
  expect(resolveDataDir({}, "", "/home/user")).toBe("/home/user/.quay");
});
