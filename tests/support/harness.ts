import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, type DB } from "../../src/db/connection.ts";
import { runMigrations } from "../../src/db/migrate.ts";
import { FakeClock } from "./fakes/clock.ts";
import { FakeIdGenerator } from "./fakes/id_generator.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_MIGRATIONS_DIR = join(REPO_ROOT, "migrations");

export interface Harness {
  dataDir: string;
  dbPath: string;
  db: DB;
  artifactRoot: string;
  clock: FakeClock;
  ids: FakeIdGenerator;
  cleanup: () => void;
}

export interface HarnessOptions {
  migrationsDir?: string;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), "quay-test-"));
  const artifactRoot = join(dataDir, "artifacts");
  mkdirSync(artifactRoot, { recursive: true });

  const dbPath = join(dataDir, "quay.db");
  const db = openDatabase(dbPath);

  const migrationsDir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  runMigrations(db, migrationsDir);

  const clock = new FakeClock();
  const ids = new FakeIdGenerator();

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    try {
      db.close();
    } catch {}
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  };

  return { dataDir, dbPath, db, artifactRoot, clock, ids, cleanup };
}
