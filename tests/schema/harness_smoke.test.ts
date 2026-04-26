import { test, expect } from "bun:test";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;

test("slice 0 entry: migrations directory exists and contains 0001_init.sql", () => {
  const migrationsDir = join(ROOT, "migrations");
  expect(existsSync(migrationsDir)).toBe(true);

  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
  expect(files).toContain("0001_init.sql");
});
