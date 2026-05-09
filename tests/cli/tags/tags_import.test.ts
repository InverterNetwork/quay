import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, afterEach } from "bun:test";
import { createHarness, type Harness } from "../../support/harness.ts";
import { buildCliDeps } from "../../support/cli_deps.ts";
import { dispatch } from "../../../src/cli/dispatch.ts";
import { bufferIO } from "../../../src/cli/io.ts";

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
  const d = mkdtempSync(join(tmpdir(), "quay-tags-import-"));
  scratchDirs.push(d);
  return d;
}

function writeToml(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

const SIMPLE_TOML = `
[tags.namespaces.area]
values = ["bonding-curve", "vesting"]
required = true

[tags.namespaces.risk]
values = ["reentrancy"]
`;

test("fresh import on empty deployment succeeds; deployment vocab matches the TOML", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  const dir = tempDir();
  const path = writeToml(dir, "vocab.toml", SIMPLE_TOML);

  const io = bufferIO();
  const result = await dispatch(["tags", "import", "--from", path], built.deps, io);
  expect(result.exitCode).toBe(0);
  const out = JSON.parse(io.out());
  expect(out.ok).toBe(true);
  expect(out.scope).toBe("deployment");
  expect(out.namespaces.area.values).toEqual(["bonding-curve", "vesting"]);
  expect(out.namespaces.area.required).toBe(true);
  expect(out.namespaces.risk.values).toEqual(["reentrancy"]);
});

test("re-importing same file is a no-op: exit 0, noop true", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  const dir = tempDir();
  const path = writeToml(dir, "vocab.toml", SIMPLE_TOML);

  await dispatch(["tags", "import", "--from", path], built.deps, bufferIO());

  const io = bufferIO();
  const result = await dispatch(["tags", "import", "--from", path], built.deps, io);
  expect(result.exitCode).toBe(0);
  const out = JSON.parse(io.out());
  expect(out.noop).toBe(true);
});

test("different content + non-empty deployment + no --force → vocab_exists error, exit 1", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  const dir = tempDir();
  const first = writeToml(dir, "first.toml", SIMPLE_TOML);
  const second = writeToml(dir, "second.toml", `
[tags.namespaces.type]
values = ["bug", "feature"]
`);

  await dispatch(["tags", "import", "--from", first], built.deps, bufferIO());

  const io = bufferIO();
  const result = await dispatch(["tags", "import", "--from", second], built.deps, io);
  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err());
  expect(err.error).toBe("vocab_exists");
});

test("different content + non-empty deployment + --force → succeeds, deployment vocab matches new TOML", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  const dir = tempDir();
  const first = writeToml(dir, "first.toml", SIMPLE_TOML);
  const second = writeToml(dir, "second.toml", `
[tags.namespaces.type]
values = ["bug", "feature"]
`);

  await dispatch(["tags", "import", "--from", first], built.deps, bufferIO());

  const io = bufferIO();
  const result = await dispatch(
    ["tags", "import", "--from", second, "--force"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(0);
  const out = JSON.parse(io.out());
  expect(out.ok).toBe(true);
  expect(Object.keys(out.namespaces)).toEqual(["type"]);
  expect(out.namespaces.type.values).toEqual(["bug", "feature"]);
});

test("malformed TOML → exit 1, validation_error", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  const dir = tempDir();
  const path = writeToml(dir, "bad.toml", "[tags.namespaces.area\nvalues = [\n");

  const io = bufferIO();
  const result = await dispatch(["tags", "import", "--from", path], built.deps, io);
  expect(result.exitCode).toBe(1);
});

test("TOML with invalid namespace spec (missing values) → exit 1, validation_error", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  const dir = tempDir();
  const path = writeToml(dir, "bad.toml", `
[tags.namespaces.area]
required = true
`);

  const io = bufferIO();
  const result = await dispatch(["tags", "import", "--from", path], built.deps, io);
  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err());
  expect(err.error).toBe("validation_error");
});

test("missing --from flag → usage_error", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const io = bufferIO();
  const result = await dispatch(["tags", "import"], built.deps, io);
  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err());
  expect(err.error).toBe("usage_error");
});

test("file not found → usage_error", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const io = bufferIO();
  const result = await dispatch(
    ["tags", "import", "--from", "/tmp/quay-does-not-exist-xyz.toml"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err());
  expect(err.error).toBe("usage_error");
});

test("TOML missing [tags.namespaces] and deployment empty → no-op, exit 0", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  const dir = tempDir();
  const path = writeToml(dir, "empty.toml", `
[other]
key = "value"
`);

  const io = bufferIO();
  const result = await dispatch(["tags", "import", "--from", path], built.deps, io);
  expect(result.exitCode).toBe(0);
  const out = JSON.parse(io.out());
  expect(out.noop).toBe(true);
});

test("unknown flag → usage_error", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  const dir = tempDir();
  const path = writeToml(dir, "vocab.toml", SIMPLE_TOML);

  const io = bufferIO();
  const result = await dispatch(
    ["tags", "import", "--from", path, "--unknown-flag"],
    built.deps,
    io,
  );
  expect(result.exitCode).toBe(1);
  const err = JSON.parse(io.err());
  expect(err.error).toBe("usage_error");
});
