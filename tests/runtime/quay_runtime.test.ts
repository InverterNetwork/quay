import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "bun:test";
import {
  createQuayRuntime,
  QuayRuntimeStartupError,
} from "../../src/runtime/quay_runtime.ts";
import { loadMigrationsFromDir } from "../../src/db/migrate.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIGRATIONS = loadMigrationsFromDir(join(REPO_ROOT, "migrations"));

let scratchDirs: string[] = [];
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "quay-runtime-"));
  scratchDirs.push(dir);
  return dir;
}

test("createQuayRuntime uses CLI data-dir assumptions and wires repo service", () => {
  const dataDir = join(tempDir(), "data");
  const runtime = createQuayRuntime({
    env: { QUAY_DATA_DIR: dataDir },
    homeDir: tempDir(),
    migrations: MIGRATIONS,
    version: "runtime-test",
  });

  try {
    expect(runtime.version).toBe("runtime-test");
    expect(runtime.dataDir).toBe(dataDir);
    expect(runtime.paths.reposRoot).toBe(join(dataDir, "repos"));
    expect(runtime.paths.worktreesRoot).toBe(join(dataDir, "worktrees"));
    expect(existsSync(runtime.paths.reposRoot)).toBe(true);
    expect(existsSync(runtime.paths.worktreesRoot)).toBe(true);
    expect(existsSync(runtime.paths.artifactsRoot)).toBe(true);

    runtime.repoService.add({
      repo_id: "repo-a",
      repo_url: "git@example.com:owner/repo-a.git",
      base_branch: "main",
      package_manager: "bun",
      install_cmd: "bun install",
    });
    expect(runtime.repoService.list().map((row) => row.repo_id)).toEqual([
      "repo-a",
    ]);
  } finally {
    runtime.close();
  }
});

test("createQuayRuntime rejects missing operator-configured repos_root", () => {
  const root = tempDir();
  const dataDir = join(root, "data");
  const missingReposRoot = join(root, "missing-repos-root");
  const configPath = join(root, "config.toml");
  writeFileSync(
    configPath,
    `data_dir = "${dataDir}"\nrepos_root = "${missingReposRoot}"\n`,
  );

  expect(() =>
    createQuayRuntime({
      env: { QUAY_CONFIG_FILE: configPath },
      homeDir: root,
      migrations: MIGRATIONS,
    }),
  ).toThrow(QuayRuntimeStartupError);
});
