import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, afterEach } from "bun:test";
import { createHarness, type Harness } from "../support/harness.ts";
import { buildCliDeps } from "../support/cli_deps.ts";
import { insertRepo } from "../support/fixtures.ts";
import { dispatch } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";

let h: Harness | null = null;
let scratchDirs: string[] = [];
afterEach(() => {
  h?.cleanup();
  h = null;
  for (const d of scratchDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "quay-apply-tags-"));
  scratchDirs.push(d);
  return d;
}

function writeJson(dir: string, filename: string, data: unknown): string {
  const path = join(dir, filename);
  writeFileSync(path, JSON.stringify(data));
  return path;
}

test("apply-tags declaratively sets namespaces and values", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  insertRepo(h.db, "repo-a");
  const dir = tempDir();

  const path = writeJson(dir, "tags.json", {
    namespaces: {
      area: { values: ["bonding-curve", "vesting"], required: true },
      risk: { values: ["reentrancy"] },
    },
  });

  const io = bufferIO();
  const result = await dispatch(
    ["repo", "apply-tags", "repo-a", "--from", path],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
  const out = JSON.parse(io.out());
  expect(out.ok).toBe(true);
  expect(out.repo_id).toBe("repo-a");
  expect(out.namespaces.area.values).toEqual(["bonding-curve", "vesting"]);
  expect(out.namespaces.area.required).toBe(true);
  expect(out.namespaces.risk.values).toEqual(["reentrancy"]);
  expect(out.namespaces.risk.required).toBe(false);
});

test("apply-tags removes existing values not in input", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  insertRepo(h.db, "repo-a");
  const dir = tempDir();

  // First apply: set area and risk.
  const first = writeJson(dir, "first.json", {
    namespaces: {
      area: { values: ["bonding-curve"] },
      risk: { values: ["reentrancy"] },
    },
  });
  await dispatch(["repo", "apply-tags", "repo-a", "--from", first], built.deps, bufferIO());

  // Second apply: only area; risk should be gone.
  const second = writeJson(dir, "second.json", {
    namespaces: {
      area: { values: ["vesting"] },
    },
  });
  const io = bufferIO();
  const result = await dispatch(
    ["repo", "apply-tags", "repo-a", "--from", second],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
  const out = JSON.parse(io.out());
  expect(Object.keys(out.namespaces)).toEqual(["area"]);
  expect(out.namespaces.area.values).toEqual(["vesting"]);
});

test("apply-tags with empty namespaces clears everything", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  insertRepo(h.db, "repo-a");
  const dir = tempDir();

  const seed = writeJson(dir, "seed.json", {
    namespaces: { area: { values: ["bonding-curve"], required: true } },
  });
  await dispatch(["repo", "apply-tags", "repo-a", "--from", seed], built.deps, bufferIO());

  const clear = writeJson(dir, "clear.json", { namespaces: {} });
  const io = bufferIO();
  const result = await dispatch(
    ["repo", "apply-tags", "repo-a", "--from", clear],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
  const out = JSON.parse(io.out());
  expect(out.namespaces).toEqual({});
});

test("apply-tags required flag toggling", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  insertRepo(h.db, "repo-a");
  const dir = tempDir();

  const required = writeJson(dir, "required.json", {
    namespaces: { area: { values: ["val"], required: true } },
  });
  await dispatch(["repo", "apply-tags", "repo-a", "--from", required], built.deps, bufferIO());

  let getIo = bufferIO();
  await dispatch(["repo", "get-tags", "repo-a"], built.deps, getIo);
  expect(JSON.parse(getIo.out()).namespaces.area.required).toBe(true);

  const notRequired = writeJson(dir, "not-required.json", {
    namespaces: { area: { values: ["val"], required: false } },
  });
  await dispatch(["repo", "apply-tags", "repo-a", "--from", notRequired], built.deps, bufferIO());

  getIo = bufferIO();
  await dispatch(["repo", "get-tags", "repo-a"], built.deps, getIo);
  expect(JSON.parse(getIo.out()).namespaces.area.required).toBe(false);
});

test("apply-tags post-apply state matches exactly what was requested", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  insertRepo(h.db, "repo-a");
  const dir = tempDir();

  // Pre-populate with extra data.
  await dispatch(
    ["repo", "set-tags", "repo-a", "--namespace", "extra", "--value", "noise"],
    built.deps,
    bufferIO(),
  );

  const desired = {
    namespaces: {
      area: { values: ["bonding-curve", "vesting"], required: true },
    },
  };
  const path = writeJson(dir, "desired.json", desired);
  await dispatch(["repo", "apply-tags", "repo-a", "--from", path], built.deps, bufferIO());

  const getIo = bufferIO();
  await dispatch(["repo", "get-tags", "repo-a"], built.deps, getIo);
  const state = JSON.parse(getIo.out());

  expect(Object.keys(state.namespaces)).toEqual(["area"]);
  expect(state.namespaces.area.values).toEqual(["bonding-curve", "vesting"]);
  expect(state.namespaces.area.required).toBe(true);
});

test("apply-tags for non-existent repo returns unknown_repo", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  const dir = tempDir();

  const path = writeJson(dir, "tags.json", { namespaces: {} });
  const io = bufferIO();
  const result = await dispatch(
    ["repo", "apply-tags", "no-such-repo", "--from", path],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err());
  expect(err.error).toBe("unknown_repo");
});

test("apply-tags with invalid namespace charset returns validation_error", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  insertRepo(h.db, "repo-a");
  const dir = tempDir();

  const path = writeJson(dir, "bad.json", {
    namespaces: { "Bad Namespace": { values: ["val"] } },
  });
  const io = bufferIO();
  const result = await dispatch(
    ["repo", "apply-tags", "repo-a", "--from", path],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err());
  expect(err.error).toBe("validation_error");
});

test("apply-tags with invalid value charset returns validation_error", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  insertRepo(h.db, "repo-a");
  const dir = tempDir();

  const path = writeJson(dir, "bad-val.json", {
    namespaces: { area: { values: ["Bad Value"] } },
  });
  const io = bufferIO();
  const result = await dispatch(
    ["repo", "apply-tags", "repo-a", "--from", path],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err());
  expect(err.error).toBe("validation_error");
});

test("apply-tags requires --from flag", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  insertRepo(h.db, "repo-a");

  const io = bufferIO();
  const result = await dispatch(["repo", "apply-tags", "repo-a"], built.deps, io);
  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err());
  expect(err.error).toBe("usage_error");
});

test("apply-tags requires <repo_id>", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const io = bufferIO();
  const result = await dispatch(["repo", "apply-tags"], built.deps, io);
  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err());
  expect(err.error).toBe("usage_error");
});

test("apply-tags reads from stdin when --from is '-'", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  insertRepo(h.db, "repo-a");

  const io = bufferIO();
  io.setStdin(JSON.stringify({ namespaces: { area: { values: ["bonding-curve"] } } }));
  const result = await dispatch(
    ["repo", "apply-tags", "repo-a", "--from", "-"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
  const out = JSON.parse(io.out());
  expect(out.namespaces.area.values).toEqual(["bonding-curve"]);
});

test("per-repo isolation: apply-tags on repo-a does not affect repo-b", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  insertRepo(h.db, "repo-a");
  insertRepo(h.db, "repo-b");
  const dir = tempDir();

  await dispatch(
    ["repo", "set-tags", "repo-b", "--namespace", "area", "--value", "val"],
    built.deps,
    bufferIO(),
  );

  const path = writeJson(dir, "tags.json", {
    namespaces: { risk: { values: ["reentrancy"] } },
  });
  await dispatch(["repo", "apply-tags", "repo-a", "--from", path], built.deps, bufferIO());

  const getIo = bufferIO();
  await dispatch(["repo", "get-tags", "repo-b"], built.deps, getIo);
  const out = JSON.parse(getIo.out());
  expect(out.namespaces.area?.values).toEqual(["val"]);
  expect(out.namespaces.risk).toBeUndefined();
});
