import { afterEach, expect, test } from "bun:test";
import { createHarness, type Harness } from "../support/harness.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("attempts has nullable diff_summary TEXT column after migration", () => {
  h = createHarness();
  const cols = h.db
    .query<{ name: string; type: string; notnull: number }, []>(
      "PRAGMA table_info(attempts)",
    )
    .all();
  const ds = cols.find((c) => c.name === "diff_summary");
  expect(ds).toBeDefined();
  expect(ds!.type.toUpperCase()).toBe("TEXT");
  // Nullable so pre-migration rows, attempts that never reached pr_opened,
  // and capture failures all stay NULL — the absence is the signal.
  expect(ds!.notnull).toBe(0);
});
