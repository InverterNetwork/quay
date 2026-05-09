import { test, expect, afterEach } from "bun:test";
import { createHarness, type Harness } from "../support/harness.ts";
import { buildCliDeps } from "../support/cli_deps.ts";
import { dispatch } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

async function addRepo(built: ReturnType<typeof buildCliDeps>, id: string): Promise<void> {
  const io = bufferIO();
  const result = await dispatch(
    ["repo", "add", "--id", id, "--url", `git@example.com:owner/${id}.git`,
     "--base-branch", "main", "--package-manager", "bun", "--install-cmd", "bun install"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
}

test("set-tags then get-tags returns the value", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built, "repo-a");

  const setIo = bufferIO();
  const setResult = await dispatch(
    ["repo", "set-tags", "repo-a", "--namespace", "area", "--value", "bonding-curve"],
    built.deps,
    setIo,
  );
  expect(setResult.exitCode).toBe(0);
  const setOut = JSON.parse(setIo.out());
  expect(setOut).toEqual({ ok: true, repo_id: "repo-a", namespace: "area", value: "bonding-curve" });

  const getIo = bufferIO();
  const getResult = await dispatch(["repo", "get-tags", "repo-a"], built.deps, getIo);
  expect(getResult.exitCode).toBe(0);
  const getOut = JSON.parse(getIo.out());
  expect(getOut.repo_id).toBe("repo-a");
  expect(getOut.namespaces.area.values).toEqual(["bonding-curve"]);
  expect(getOut.namespaces.area.required).toBe(false);
});

test("set-tags on existing pair is no-op (idempotent)", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built, "repo-a");

  for (let i = 0; i < 2; i++) {
    const io = bufferIO();
    const result = await dispatch(
      ["repo", "set-tags", "repo-a", "--namespace", "area", "--value", "bonding-curve"],
      built.deps,
      io,
    );
    expect(result.exitCode).toBe(0);
  }

  const getIo = bufferIO();
  await dispatch(["repo", "get-tags", "repo-a"], built.deps, getIo);
  const out = JSON.parse(getIo.out());
  expect(out.namespaces.area.values).toEqual(["bonding-curve"]);
  expect(
    h.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM tag_namespaces").get()!.c,
  ).toBe(1);
});

test("unset-tags --value removes only that value", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built, "repo-a");

  await dispatch(
    ["repo", "set-tags", "repo-a", "--namespace", "area", "--value", "bonding-curve"],
    built.deps,
    bufferIO(),
  );
  await dispatch(
    ["repo", "set-tags", "repo-a", "--namespace", "area", "--value", "vesting"],
    built.deps,
    bufferIO(),
  );

  const unsetIo = bufferIO();
  const unsetResult = await dispatch(
    ["repo", "unset-tags", "repo-a", "--namespace", "area", "--value", "bonding-curve"],
    built.deps,
    unsetIo,
  );
  expect(unsetResult.exitCode).toBe(0);
  const unsetOut = JSON.parse(unsetIo.out());
  expect(unsetOut).toEqual({ ok: true, repo_id: "repo-a", namespace: "area", value: "bonding-curve" });

  const getIo = bufferIO();
  await dispatch(["repo", "get-tags", "repo-a"], built.deps, getIo);
  const out = JSON.parse(getIo.out());
  expect(out.namespaces.area.values).toEqual(["vesting"]);
});

test("unset-tags without value removes whole namespace", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built, "repo-a");

  await dispatch(
    ["repo", "set-tags", "repo-a", "--namespace", "area", "--value", "bonding-curve"],
    built.deps,
    bufferIO(),
  );
  await dispatch(
    ["repo", "set-tags", "repo-a", "--namespace", "area", "--value", "vesting"],
    built.deps,
    bufferIO(),
  );

  const unsetIo = bufferIO();
  const unsetResult = await dispatch(
    ["repo", "unset-tags", "repo-a", "--namespace", "area"],
    built.deps,
    unsetIo,
  );
  expect(unsetResult.exitCode).toBe(0);
  const unsetOut = JSON.parse(unsetIo.out());
  expect(unsetOut).toEqual({ ok: true, repo_id: "repo-a", namespace: "area", value: null });

  const getIo = bufferIO();
  await dispatch(["repo", "get-tags", "repo-a"], built.deps, getIo);
  const out = JSON.parse(getIo.out());
  expect(out.namespaces).toEqual({});
});

test("get-tags returns sorted namespaces and values", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built, "repo-a");

  for (const [ns, v] of [["risk", "reentrancy"], ["area", "vesting"], ["area", "bonding-curve"]]) {
    await dispatch(
      ["repo", "set-tags", "repo-a", "--namespace", ns!, "--value", v!],
      built.deps,
      bufferIO(),
    );
  }

  const getIo = bufferIO();
  await dispatch(["repo", "get-tags", "repo-a"], built.deps, getIo);
  const out = JSON.parse(getIo.out());
  expect(Object.keys(out.namespaces)).toEqual(["area", "risk"]);
  expect(out.namespaces.area.values).toEqual(["bonding-curve", "vesting"]);
});

test("per-repo isolation: tags on repo-a not visible in repo-b", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built, "repo-a");
  await addRepo(built, "repo-b");

  await dispatch(
    ["repo", "set-tags", "repo-a", "--namespace", "area", "--value", "bonding-curve"],
    built.deps,
    bufferIO(),
  );

  const getIo = bufferIO();
  await dispatch(["repo", "get-tags", "repo-b"], built.deps, getIo);
  const out = JSON.parse(getIo.out());
  expect(out.namespaces).toEqual({});
});

test("set-tags for non-existent repo returns unknown_repo", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const io = bufferIO();
  const result = await dispatch(
    ["repo", "set-tags", "no-such-repo", "--namespace", "area", "--value", "val"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err());
  expect(err.error).toBe("unknown_repo");
});

test("set-tags with invalid namespace returns validation_error", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built, "repo-a");

  const io = bufferIO();
  const result = await dispatch(
    ["repo", "set-tags", "repo-a", "--namespace", "Bad Namespace", "--value", "val"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err());
  expect(err.error).toBe("validation_error");
});

test("set-tags requires --namespace flag", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built, "repo-a");

  const io = bufferIO();
  const result = await dispatch(
    ["repo", "set-tags", "repo-a", "--value", "val"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err());
  expect(err.error).toBe("usage_error");
});

test("set-tags requires --value flag", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  await addRepo(built, "repo-a");

  const io = bufferIO();
  const result = await dispatch(
    ["repo", "set-tags", "repo-a", "--namespace", "area"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err());
  expect(err.error).toBe("usage_error");
});

test("get-tags requires <repo_id>", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const io = bufferIO();
  const result = await dispatch(["repo", "get-tags"], built.deps, io);
  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err());
  expect(err.error).toBe("usage_error");
});

test("help flag works for set-tags, unset-tags, get-tags", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  for (const sub of ["set-tags", "unset-tags", "get-tags", "apply-tags"]) {
    const io = bufferIO();
    const result = await dispatch(["repo", sub, "--help"], built.deps, io);
    expect(result.exitCode).toBe(0);
    expect(io.out()).toContain("Usage:");
  }
});
