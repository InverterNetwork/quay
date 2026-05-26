import { afterEach, expect, test } from "bun:test";
import { createHarness, type Harness } from "../support/harness.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("attempts has nullable agent_identity column after migration", () => {
  h = createHarness();
  const cols = h.db
    .query<{ name: string; type: string; notnull: number }, []>(
      "PRAGMA table_info(attempts)",
    )
    .all();
  const identity = cols.find((c) => c.name === "agent_identity");
  expect(identity).toBeDefined();
  expect(identity!.type.toUpperCase()).toBe("TEXT");
  // Nullable so pre-migration rows can survive without a backfill.
  expect(identity!.notnull).toBe(0);
});
