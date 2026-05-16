import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "./connection.ts";

export interface Migration {
  name: string;
  sql: string;
}

// Read migrations from a directory, sorted by filename. Used by tests and
// the dev path; the production CLI ships a baked-in list via embed.ts.
export function loadMigrationsFromDir(migrationsDir: string): Migration[] {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files.map((name) => ({
    name,
    sql: readFileSync(join(migrationsDir, name), "utf8"),
  }));
}

export function runMigrations(
  db: DB,
  migrations: readonly Migration[],
): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set<string>(
    db
      .query<{ name: string }, []>("SELECT name FROM schema_migrations")
      .all()
      .map((r) => r.name),
  );

  const newlyApplied: string[] = [];

  for (const { name, sql } of migrations) {
    if (applied.has(name)) continue;
    const disableForeignKeys = sql.includes("-- quay: foreign_keys_off");
    if (disableForeignKeys) db.exec("PRAGMA foreign_keys = OFF;");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      if (disableForeignKeys) {
        const violations = db.query<Record<string, unknown>, []>(
          "PRAGMA foreign_key_check",
        ).all();
        if (violations.length > 0) {
          throw new Error(
            `foreign key check failed after migration ${name}: ${JSON.stringify(violations)}`,
          );
        }
      }
      db.query("INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)").run(
        name,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    } finally {
      if (disableForeignKeys) db.exec("PRAGMA foreign_keys = ON;");
    }
    newlyApplied.push(name);
  }

  return newlyApplied;
}
