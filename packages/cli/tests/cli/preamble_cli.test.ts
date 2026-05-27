import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatch } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";
import { buildCliDeps } from "../support/cli_deps.ts";
import { insertPreamble } from "../support/fixtures.ts";
import { createHarness, type Harness } from "../support/harness.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("preamble create from file prints stable JSON and list returns summaries", async () => {
  h = createHarness();
  const bodyPath = join(h.dataDir, "worker-preamble.md");
  writeFileSync(bodyPath, "worker preamble body\n", "utf8");
  const built = buildCliDeps(h);

  let io = bufferIO();
  let result = await dispatch(
    ["preamble", "create", "--kind", "code", "--body-file", bodyPath],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(io.out())).toEqual({
    preamble_id: 1,
    kind: "code",
    created_at: h.clock.nowISO(),
    body: "worker preamble body\n",
  });

  io = bufferIO();
  result = await dispatch(["preamble", "list"], built.deps, io);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(io.out())).toEqual([
    {
      preamble_id: 1,
      kind: "code",
      created_at: h.clock.nowISO(),
    },
  ]);
});

test("preamble create accepts stdin and list can filter by kind", async () => {
  h = createHarness();
  insertPreamble(h.db, "worker", "code");
  const built = buildCliDeps(h);

  let io = bufferIO();
  io.setStdin("review preamble body");
  let result = await dispatch(
    ["preamble", "create", "--kind", "review", "--body-file", "-"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(io.out())).toMatchObject({
    preamble_id: 2,
    kind: "review",
    body: "review preamble body",
  });

  io = bufferIO();
  result = await dispatch(
    ["preamble", "list", "--kind", "review"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(io.out())).toEqual([
    {
      preamble_id: 2,
      kind: "review",
      created_at: h.clock.nowISO(),
    },
  ]);
});

test("preamble show returns the stored body", async () => {
  h = createHarness();
  const preambleId = insertPreamble(h.db, "inline body", "review");
  const built = buildCliDeps(h);
  const io = bufferIO();

  const result = await dispatch(
    ["preamble", "show", String(preambleId)],
    built.deps,
    io,
  );

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(io.out())).toEqual({
    preamble_id: preambleId,
    kind: "review",
    created_at: h.clock.nowISO(),
    body: "inline body",
  });
});

test("preamble create rejects invalid kind and ambiguous body sources", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  let io = bufferIO();
  let result = await dispatch(
    ["preamble", "create", "--kind", "worker", "--body", "body"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(io.err()).error).toBe("usage_error");

  io = bufferIO();
  result = await dispatch(
    [
      "preamble",
      "create",
      "--kind",
      "code",
      "--body",
      "body",
      "--body-file",
      "-",
    ],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(io.err()).message).toContain("exactly one");
});
