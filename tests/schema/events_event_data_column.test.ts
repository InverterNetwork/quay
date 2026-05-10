import { afterEach, expect, test } from "bun:test";
import { createHarness, type Harness } from "../support/harness.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("events has nullable event_data column after migration", () => {
  h = createHarness();
  const cols = h.db
    .query<{ name: string; type: string; notnull: number }, []>(
      "PRAGMA table_info(events)",
    )
    .all();
  const ed = cols.find((c) => c.name === "event_data");
  expect(ed).toBeDefined();
  expect(ed!.type.toUpperCase()).toBe("TEXT");
  // Nullable so pre-migration events and event-types this slice
  // doesn't populate stay NULL — the absence is the signal.
  expect(ed!.notnull).toBe(0);
});
