import { afterEach, expect, test } from "bun:test";
import { createHarness, type Harness } from "../support/harness.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("attempts has nullable exit_code and exit_signal columns after migration", () => {
  h = createHarness();
  const cols = h.db
    .query<{ name: string; type: string; notnull: number }, []>(
      "PRAGMA table_info(attempts)",
    )
    .all();

  const exitCode = cols.find((c) => c.name === "exit_code");
  expect(exitCode).toBeDefined();
  expect(exitCode!.type.toUpperCase()).toBe("INTEGER");
  // Nullable so pre-migration rows survive without backfill, and so
  // attempts whose substrate spawn never produced a real process
  // (spawn_failed) keep both columns NULL by default.
  expect(exitCode!.notnull).toBe(0);

  const exitSignal = cols.find((c) => c.name === "exit_signal");
  expect(exitSignal).toBeDefined();
  expect(exitSignal!.type.toUpperCase()).toBe("TEXT");
  expect(exitSignal!.notnull).toBe(0);
});
