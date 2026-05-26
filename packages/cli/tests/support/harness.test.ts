import { test, expect } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { createHarness } from "./harness.ts";

test("test_test_harness_provides_temp_data_dir_db_and_clock", () => {
  const a = createHarness();
  try {
    expect(existsSync(a.dataDir)).toBe(true);
    expect(statSync(a.dataDir).isDirectory()).toBe(true);
    expect(existsSync(a.dbPath)).toBe(true);
    expect(existsSync(a.artifactRoot)).toBe(true);
    expect(statSync(a.artifactRoot).isDirectory()).toBe(true);

    // Migrations applied: required tables exist.
    const tables = a.db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      )
      .all()
      .map((r) => r.name);
    for (const required of [
      "repos",
      "preambles",
      "retry_templates",
      "tasks",
      "attempts",
      "artifacts",
      "events",
    ]) {
      expect(tables).toContain(required);
    }

    // Deterministic clock: returns the same instant unless advanced.
    const t1 = a.clock.nowISO();
    const t2 = a.clock.nowISO();
    expect(t1).toBe(t2);
    a.clock.advanceMs(1000);
    expect(a.clock.nowISO()).not.toBe(t1);

    // Deterministic id generator: monotonic, predictable.
    expect(a.ids.next()).toBe("id-1");
    expect(a.ids.next()).toBe("id-2");
    expect(a.ids.next()).toBe("id-3");

    // Two harness instances do not collide.
    const b = createHarness();
    try {
      expect(b.dataDir).not.toBe(a.dataDir);
      expect(b.dbPath).not.toBe(a.dbPath);
      expect(b.artifactRoot).not.toBe(a.artifactRoot);

      // Independent ID counters.
      expect(b.ids.next()).toBe("id-1");

      // Independent DBs: a write to one is invisible to the other.
      a.db
        .query(
          `INSERT INTO repos (repo_id, repo_url, base_branch, package_manager, install_cmd, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run("repo-a", "git@x", "main", "bun", "bun install", a.clock.nowISO());
      const aCount = a.db
        .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM repos")
        .get()!.c;
      const bCount = b.db
        .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM repos")
        .get()!.c;
      expect(aCount).toBe(1);
      expect(bCount).toBe(0);
    } finally {
      b.cleanup();
      expect(existsSync(b.dataDir)).toBe(false);
    }
  } finally {
    a.cleanup();
    expect(existsSync(a.dataDir)).toBe(false);
  }
});
