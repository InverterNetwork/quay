// Lazy lookup of the per-repo + deployment tag vocab for the validator.
//
// The validator short-circuits config + DB init for speed, so it has no
// services wired by default. This factory caches the open DB and derived
// services per process so repeated lookups are free, and degrades to "no
// enforcement" before the data dir exists — the validator must still work
// on a host that has never been initialized.
//
// Returning a non-null context implies `perRepo` is non-empty; the caller
// can rely on that without re-checking.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/connection.ts";
import type { Migration } from "../db/migrate.ts";
import { runMigrations } from "../db/migrate.ts";
import { SystemClock } from "../ports/clock.ts";
import { createRepoService } from "../core/repos/service.ts";
import { createTagService } from "../core/tags/service.ts";
import { loadConfig } from "./config.ts";
import { resolveDataDir } from "./data_dir.ts";
import type { RepoVocabLookup } from "./validate_ticket.ts";

export function createLazyRepoVocabLookup(
  env: NodeJS.ProcessEnv,
  loadMigrations: () => readonly Migration[],
): RepoVocabLookup {
  let cached: ReturnType<typeof initServices> | undefined;
  return (repoId: string) => {
    if (cached === undefined) cached = initServices(env, loadMigrations);
    if (cached === null) return null;
    // tagService.getVocab asserts repo existence; for the validator an
    // unregistered repo simply has no vocab and enforcement is skipped.
    if (!cached.repoService.get(repoId)) return null;
    const perRepo = cached.tagService.getVocab("repo", repoId);
    if (Object.keys(perRepo).length === 0) return null;
    const deployment = cached.tagService.getVocab("deployment");
    return { perRepo, deployment };
  };
}

function initServices(
  env: NodeJS.ProcessEnv,
  loadMigrations: () => readonly Migration[],
): {
  tagService: ReturnType<typeof createTagService>;
  repoService: ReturnType<typeof createRepoService>;
} | null {
  // Resolve data_dir the same way the dispatcher does (env > config.toml >
  // ~/.quay) so deployments that pin data_dir in config.toml don't silently
  // bypass enforcement.
  const home = env.HOME ?? homedir();
  const { config } = loadConfig({ env, homeDir: home });
  const dataDir = resolveDataDir(env, config.data_dir, home);
  const dbPath = join(dataDir, "quay.db");
  // Pre-init host: skip enforcement instead of failing the validator.
  // A corrupted or migration-incompatible DB still throws — operators see
  // the real error rather than silent degradation.
  if (!existsSync(dbPath)) return null;
  const db = openDatabase(dbPath);
  runMigrations(db, loadMigrations());
  const clock = new SystemClock();
  const repoService = createRepoService({ db, clock });
  const tagService = createTagService({ db, clock, repoService });
  return { tagService, repoService };
}
