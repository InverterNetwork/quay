import { test, expect, afterEach } from "bun:test";
import { createHarness, type Harness } from "../../support/harness.ts";
import { buildCliDeps } from "../../support/cli_deps.ts";
import { insertRepo } from "../../support/fixtures.ts";
import { dispatch } from "../../../src/cli/dispatch.ts";
import { bufferIO } from "../../../src/cli/io.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("repo with no per-repo vocab + no deployment → empty namespaces, not enforced", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  insertRepo(h.db, "repo-a");

  const io = bufferIO();
  const result = await dispatch(["tags", "list", "--repo", "repo-a"], built.deps, io);
  expect(result.exitCode).toBe(0);
  const out = JSON.parse(io.out());
  expect(out.repo_id).toBe("repo-a");
  expect(out.namespaces).toEqual({});
  expect(out.enforced).toBe(false);
});

test("repo with no per-repo vocab + deployment vocab present → deployment passes through, not enforced", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  insertRepo(h.db, "repo-a");

  const applyIo = bufferIO();
  applyIo.setStdin(JSON.stringify({
    namespaces: { area: { values: ["bonding-curve"], required: false } },
  }));
  await dispatch(["tags", "apply-deployment", "--from", "-"], built.deps, applyIo);

  const io = bufferIO();
  const result = await dispatch(["tags", "list", "--repo", "repo-a"], built.deps, io);
  expect(result.exitCode).toBe(0);
  const out = JSON.parse(io.out());
  expect(out.namespaces.area.values).toEqual(["bonding-curve"]);
  expect(out.enforced).toBe(false);
});

test("repo with per-repo vocab + no deployment → per-repo passes through, enforced", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  insertRepo(h.db, "repo-a");

  await dispatch(
    ["repo", "set-tags", "repo-a", "--namespace", "risk", "--value", "reentrancy"],
    built.deps,
    bufferIO(),
  );

  const io = bufferIO();
  const result = await dispatch(["tags", "list", "--repo", "repo-a"], built.deps, io);
  expect(result.exitCode).toBe(0);
  const out = JSON.parse(io.out());
  expect(out.namespaces.risk.values).toEqual(["reentrancy"]);
  expect(out.enforced).toBe(true);
});

test("both populated with overlap → merged shape, enforced, deployment required survives per-repo required=false", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  insertRepo(h.db, "repo-a");

  const applyIo = bufferIO();
  applyIo.setStdin(JSON.stringify({
    namespaces: { area: { values: ["bonding-curve"], required: true } },
  }));
  await dispatch(["tags", "apply-deployment", "--from", "-"], built.deps, applyIo);

  const repoApplyIo = bufferIO();
  repoApplyIo.setStdin(JSON.stringify({
    namespaces: { area: { values: ["vesting"], required: false } },
  }));
  await dispatch(
    ["repo", "apply-tags", "repo-a", "--from", "-"],
    built.deps,
    repoApplyIo,
  );

  const io = bufferIO();
  const result = await dispatch(["tags", "list", "--repo", "repo-a"], built.deps, io);
  expect(result.exitCode).toBe(0);
  const out = JSON.parse(io.out());
  expect(out.enforced).toBe(true);
  expect(out.namespaces.area.values).toEqual(["bonding-curve", "vesting"]);
  expect(out.namespaces.area.required).toBe(true);
});

test("non-existent repo → exit 1, unknown_repo error", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const io = bufferIO();
  const result = await dispatch(["tags", "list", "--repo", "no-such-repo"], built.deps, io);
  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err());
  expect(err.error).toBe("unknown_repo");
});

test("missing --repo flag → usage_error", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const io = bufferIO();
  const result = await dispatch(["tags", "list"], built.deps, io);
  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err());
  expect(err.error).toBe("usage_error");
});

test("unknown flag on tags list is rejected", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  insertRepo(h.db, "repo-a");

  const io = bufferIO();
  const result = await dispatch(
    ["tags", "list", "--repo", "repo-a", "--frce"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err());
  expect(err.error).toBe("usage_error");
});
