import { test, expect, afterEach } from "bun:test";
import { createHarness, type Harness } from "../../support/harness.ts";
import { buildCliDeps } from "../../support/cli_deps.ts";
import { dispatch } from "../../../src/cli/dispatch.ts";
import { bufferIO } from "../../../src/cli/io.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

test("set-deployment then get-deployment round-trip", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const setIo = bufferIO();
  const setResult = await dispatch(
    ["tags", "set-deployment", "--namespace", "area", "--value", "bonding-curve"],
    built.deps,
    setIo,
  );
  expect(setResult.exitCode).toBe(0);
  const setOut = JSON.parse(setIo.out());
  expect(setOut).toEqual({ ok: true, scope: "deployment", namespace: "area", value: "bonding-curve" });

  const getIo = bufferIO();
  const getResult = await dispatch(["tags", "get-deployment"], built.deps, getIo);
  expect(getResult.exitCode).toBe(0);
  const getOut = JSON.parse(getIo.out());
  expect(getOut.scope).toBe("deployment");
  expect(getOut.namespaces.area.values).toEqual(["bonding-curve"]);
  expect(getOut.namespaces.area.required).toBe(false);
});

test("set-deployment is idempotent", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  for (let i = 0; i < 2; i++) {
    const io = bufferIO();
    const result = await dispatch(
      ["tags", "set-deployment", "--namespace", "area", "--value", "bonding-curve"],
      built.deps,
      io,
    );
    expect(result.exitCode).toBe(0);
  }

  expect(
    h.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM tag_namespaces").get()!.c,
  ).toBe(1);
});

test("unset-deployment --value removes only that value", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  await dispatch(
    ["tags", "set-deployment", "--namespace", "area", "--value", "bonding-curve"],
    built.deps,
    bufferIO(),
  );
  await dispatch(
    ["tags", "set-deployment", "--namespace", "area", "--value", "vesting"],
    built.deps,
    bufferIO(),
  );

  const unsetIo = bufferIO();
  const unsetResult = await dispatch(
    ["tags", "unset-deployment", "--namespace", "area", "--value", "bonding-curve"],
    built.deps,
    unsetIo,
  );
  expect(unsetResult.exitCode).toBe(0);
  const unsetOut = JSON.parse(unsetIo.out());
  expect(unsetOut).toEqual({ ok: true, scope: "deployment", namespace: "area", value: "bonding-curve" });

  const getIo = bufferIO();
  await dispatch(["tags", "get-deployment"], built.deps, getIo);
  const out = JSON.parse(getIo.out());
  expect(out.namespaces.area.values).toEqual(["vesting"]);
});

test("unset-deployment without --value removes whole namespace and meta", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  await dispatch(
    ["tags", "set-deployment", "--namespace", "area", "--value", "bonding-curve"],
    built.deps,
    bufferIO(),
  );
  await dispatch(
    ["tags", "set-deployment", "--namespace", "area", "--value", "vesting"],
    built.deps,
    bufferIO(),
  );

  const unsetIo = bufferIO();
  const unsetResult = await dispatch(
    ["tags", "unset-deployment", "--namespace", "area"],
    built.deps,
    unsetIo,
  );
  expect(unsetResult.exitCode).toBe(0);
  const unsetOut = JSON.parse(unsetIo.out());
  expect(unsetOut).toEqual({ ok: true, scope: "deployment", namespace: "area", value: null });

  const getIo = bufferIO();
  await dispatch(["tags", "get-deployment"], built.deps, getIo);
  const out = JSON.parse(getIo.out());
  expect(out.namespaces).toEqual({});
});

test("get-deployment on empty deployment vocab returns empty namespaces", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const io = bufferIO();
  const result = await dispatch(["tags", "get-deployment"], built.deps, io);
  expect(result.exitCode).toBe(0);
  const out = JSON.parse(io.out());
  expect(out).toEqual({ scope: "deployment", namespaces: {} });
});

test("apply-deployment declaratively replaces deployment vocab", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const io = bufferIO();
  io.setStdin(JSON.stringify({
    namespaces: {
      area: { values: ["bonding-curve", "vesting"], required: true },
      risk: { values: ["reentrancy"] },
    },
  }));
  const result = await dispatch(
    ["tags", "apply-deployment", "--from", "-"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
  const out = JSON.parse(io.out());
  expect(out.ok).toBe(true);
  expect(out.scope).toBe("deployment");
  expect(out.namespaces.area.values).toEqual(["bonding-curve", "vesting"]);
  expect(out.namespaces.area.required).toBe(true);
  expect(out.namespaces.risk.values).toEqual(["reentrancy"]);
  expect(out.namespaces.risk.required).toBe(false);
});

test("apply-deployment with empty namespaces clears everything", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const seedIo = bufferIO();
  seedIo.setStdin(JSON.stringify({ namespaces: { area: { values: ["bonding-curve"] } } }));
  await dispatch(["tags", "apply-deployment", "--from", "-"], built.deps, seedIo);

  const clearIo = bufferIO();
  clearIo.setStdin(JSON.stringify({ namespaces: {} }));
  const result = await dispatch(
    ["tags", "apply-deployment", "--from", "-"],
    built.deps,
    clearIo,
  );
  expect(result.exitCode).toBe(0);
  const out = JSON.parse(clearIo.out());
  expect(out.namespaces).toEqual({});
});

test("apply-deployment reads from stdin when --from is '-'", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const io = bufferIO();
  io.setStdin(JSON.stringify({ namespaces: { area: { values: ["defi"] } } }));
  const result = await dispatch(
    ["tags", "apply-deployment", "--from", "-"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
  const out = JSON.parse(io.out());
  expect(out.namespaces.area.values).toEqual(["defi"]);
});

test("apply-deployment rejects malformed shape with validation_error and writes nothing", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const cases: Array<unknown> = [
    { namespaces: { area: { values: "abc" } } },
    { namespaces: { area: { values: 42 } } },
    { namespaces: { area: { required: true } } },
    { namespaces: { area: 42 } },
    { namespaces: { area: { values: ["ok", 7] } } },
    { namespaces: { area: { values: ["ok"], wat: true } } },
  ];

  for (const input of cases) {
    const io = bufferIO();
    io.setStdin(JSON.stringify(input));
    const result = await dispatch(
      ["tags", "apply-deployment", "--from", "-"],
      built.deps,
      io,
    );
    expect(result.exitCode).toBe(1);
    const err = JSON.parse(io.err());
    expect(err.error).toBe("validation_error");
  }

  expect(
    h.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM tag_namespaces").get()!.c,
  ).toBe(0);
});

test("set-deployment does not require any repo to exist", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const io = bufferIO();
  const result = await dispatch(
    ["tags", "set-deployment", "--namespace", "area", "--value", "val"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
});

test("unset-deployment does not require any repo to exist", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const io = bufferIO();
  const result = await dispatch(
    ["tags", "unset-deployment", "--namespace", "area"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
});

test("apply-deployment does not require any repo to exist", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const io = bufferIO();
  io.setStdin(JSON.stringify({ namespaces: { area: { values: ["val"] } } }));
  const result = await dispatch(
    ["tags", "apply-deployment", "--from", "-"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
});

test("set-deployment requires --namespace flag", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const io = bufferIO();
  const result = await dispatch(
    ["tags", "set-deployment", "--value", "val"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err());
  expect(err.error).toBe("usage_error");
});

test("set-deployment requires --value flag", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const io = bufferIO();
  const result = await dispatch(
    ["tags", "set-deployment", "--namespace", "area"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err());
  expect(err.error).toBe("usage_error");
});

test("unset-deployment requires --namespace flag", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const io = bufferIO();
  const result = await dispatch(["tags", "unset-deployment"], built.deps, io);
  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err());
  expect(err.error).toBe("usage_error");
});

test("apply-deployment requires --from flag", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const io = bufferIO();
  const result = await dispatch(["tags", "apply-deployment"], built.deps, io);
  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err());
  expect(err.error).toBe("usage_error");
});
