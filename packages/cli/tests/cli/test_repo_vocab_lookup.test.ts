// Lazy vocab lookup honors `data_dir` from config.toml the same way the
// dispatcher does. Without this, deployments that pin data_dir in config
// silently bypass tag-vocab enforcement.

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/db/connection.ts";
import { loadMigrationsFromDir, runMigrations } from "../../src/db/migrate.ts";
import { fileURLToPath } from "node:url";
import { SystemClock } from "../../src/ports/clock.ts";
import { createRepoService } from "../../src/core/repos/service.ts";
import { createTagService } from "../../src/core/tags/service.ts";
import { createLazyRepoVocabLookup } from "../../src/cli/repo_vocab_lookup.ts";
import { insertRepo } from "../support/fixtures.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MIGRATIONS_DIR = join(REPO_ROOT, "migrations");

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) {
    try { fn(); } catch {}
  }
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function seedDataDir(dataDir: string, repoId: string): void {
  const dbPath = join(dataDir, "quay.db");
  const db = openDatabase(dbPath);
  runMigrations(db, loadMigrationsFromDir(MIGRATIONS_DIR));
  const clock = new SystemClock();
  const repoService = createRepoService({ db, clock });
  insertRepo(db, repoId);
  const tagService = createTagService({ db, clock, repoService });
  tagService.apply("repo", repoId, { area: { values: ["bonding-curve"] } });
  db.close();
}

test("createLazyRepoVocabLookup honors data_dir from config.toml", () => {
  const home = tempDir("vocab-lookup-home-");
  mkdirSync(join(home, ".quay"), { recursive: true });
  const realDataDir = tempDir("vocab-lookup-data-");
  // Pin data_dir in config; do NOT set QUAY_DATA_DIR.
  writeFileSync(
    join(home, ".quay", "config.toml"),
    `data_dir = "${realDataDir}"\n`,
  );
  seedDataDir(realDataDir, "repo-a");

  const lookup = createLazyRepoVocabLookup(
    { HOME: home },
    () => loadMigrationsFromDir(MIGRATIONS_DIR),
  );
  const ctx = lookup("repo-a");
  expect(ctx).not.toBeNull();
  expect(ctx!.perRepo.area?.values).toEqual(["bonding-curve"]);
});

test("createLazyRepoVocabLookup returns null when data_dir is absent", () => {
  const home = tempDir("vocab-lookup-home-empty-");
  const lookup = createLazyRepoVocabLookup(
    { HOME: home },
    () => loadMigrationsFromDir(MIGRATIONS_DIR),
  );
  expect(lookup("any-repo")).toBeNull();
});

test("QUAY_DATA_DIR env wins over config.toml data_dir", () => {
  const home = tempDir("vocab-lookup-home-env-");
  mkdirSync(join(home, ".quay"), { recursive: true });
  const configDataDir = tempDir("vocab-lookup-config-");
  // Config points at a (seeded) dir, but env overrides to a different
  // (also seeded) dir. The env-pinned dir should win.
  seedDataDir(configDataDir, "repo-config");
  const envDataDir = tempDir("vocab-lookup-env-");
  seedDataDir(envDataDir, "repo-env");
  writeFileSync(
    join(home, ".quay", "config.toml"),
    `data_dir = "${configDataDir}"\n`,
  );

  const lookup = createLazyRepoVocabLookup(
    { HOME: home, QUAY_DATA_DIR: envDataDir },
    () => loadMigrationsFromDir(MIGRATIONS_DIR),
  );
  // The env-dir DB has repo-env, not repo-config.
  expect(lookup("repo-env")).not.toBeNull();
  expect(lookup("repo-config")).toBeNull();
});

test("createLazyRepoVocabLookup defers loadMigrations until first call", () => {
  const home = tempDir("vocab-lookup-home-lazy-");
  // No DB exists, so the lookup short-circuits and migrations are never loaded.
  let migrationCalls = 0;
  const lookup = createLazyRepoVocabLookup(
    { HOME: home },
    () => {
      migrationCalls += 1;
      return loadMigrationsFromDir(MIGRATIONS_DIR);
    },
  );
  // No call → no load.
  expect(migrationCalls).toBe(0);
  // First call → no DB → null, still no migration load (returns before
  // openDatabase). The factory short-circuits on existsSync.
  lookup("anything");
  expect(migrationCalls).toBe(0);
});
