// AST-83: human-facing help surface.
//
// Tests cover the three layers of the new contract:
//   * Explicit help → plain text on stdout, exit 0, stderr empty.
//   * Bare sub-noun → keep structured `usage_error` JSON envelope on stderr,
//     followed by the noun's usage block, exit non-zero.
//   * Unknown top-level command → JSON envelope plus a one-line `quay --help`
//     hint on stderr, exit non-zero.
//
// Real failures (validation errors, unknown task, etc.) MUST still emit the
// existing JSON envelope; the existing test suite covers that contract and
// these tests deliberately do not duplicate it.

import { afterEach, expect, test } from "bun:test";
import { dispatch } from "../../src/cli/dispatch.ts";
import { bufferIO } from "../../src/cli/io.ts";
import { createHarness, type Harness } from "../support/harness.ts";
import { buildCliDeps } from "../support/cli_deps.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

// First non-empty stderr line, parsed as JSON. Tests use this when the
// stream contains both a structured envelope and a follow-up usage block.
function parseFirstJsonLine(s: string): { error: string; message: string } & Record<string, unknown> {
  const first = s.split("\n").find((l) => l.length > 0);
  expect(first).toBeDefined();
  return JSON.parse(first as string);
}

test("quay --help prints command list to stdout, exit 0", async () => {
  h = createHarness();
  const built = buildCliDeps(h);
  const io = bufferIO();

  const result = await dispatch(["--help"], built.deps, io);

  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");
  const out = io.out();
  expect(out).toContain("Usage:");
  expect(out).toContain("quay <command>");
  // Every documented top-level command must appear, so an operator scanning
  // `quay --help` sees the full surface in one place.
  for (const cmd of [
    "task",
    "tick",
    "enqueue",
    "repo",
    "cancel",
    "submit-brief",
    "escalate-human",
    "artifact",
    "validate-ticket",
    "--version",
  ]) {
    expect(out).toContain(cmd);
  }
});

test("quay -h and quay help share the --help output", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const ioDashH = bufferIO();
  const dashHResult = await dispatch(["-h"], built.deps, ioDashH);
  expect(dashHResult.exitCode).toBe(0);
  expect(ioDashH.out()).toContain("Usage:");

  const ioHelp = bufferIO();
  const helpResult = await dispatch(["help"], built.deps, ioHelp);
  expect(helpResult.exitCode).toBe(0);
  expect(ioHelp.out()).toContain("Usage:");

  // The three explicit forms must produce the same text — divergence would
  // mean an operator can't trust any single form to be authoritative.
  const ioLong = bufferIO();
  await dispatch(["--help"], built.deps, ioLong);
  expect(ioDashH.out()).toBe(ioLong.out());
  expect(ioHelp.out()).toBe(ioLong.out());
});

test("quay <noun> --help prints per-command usage on stdout", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const ioRepo = bufferIO();
  const repoResult = await dispatch(["repo", "--help"], built.deps, ioRepo);
  expect(repoResult.exitCode).toBe(0);
  expect(ioRepo.err()).toBe("");
  expect(ioRepo.out()).toContain("quay repo");
  // Sub-noun help lists subcommands so operators can drill in.
  expect(ioRepo.out()).toContain("add");
  expect(ioRepo.out()).toContain("list");

  const ioTask = bufferIO();
  const taskResult = await dispatch(["task", "-h"], built.deps, ioTask);
  expect(taskResult.exitCode).toBe(0);
  expect(ioTask.out()).toContain("quay task");
  expect(ioTask.out()).toContain("list");
  expect(ioTask.out()).toContain("claim");
});

test("quay <noun> <sub> --help prints leaf-command usage on stdout", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const io = bufferIO();
  const result = await dispatch(["repo", "add", "--help"], built.deps, io);
  expect(result.exitCode).toBe(0);
  expect(io.err()).toBe("");
  const out = io.out();
  expect(out).toContain("quay repo add");
  // The synopsis must list the required flags so operators don't have to
  // guess them from validator errors (which is exactly what AST-83 fixes).
  expect(out).toContain("--id");
  expect(out).toContain("--url");
  expect(out).toContain("--base-branch");
});

test("quay enqueue --help and quay cancel --help reach stdout, exit 0", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const ioEnq = bufferIO();
  const enq = await dispatch(["enqueue", "--help"], built.deps, ioEnq);
  expect(enq.exitCode).toBe(0);
  expect(ioEnq.out()).toContain("quay enqueue");
  expect(ioEnq.out()).toContain("--brief-file");

  const ioCancel = bufferIO();
  const cancel = await dispatch(["cancel", "--help"], built.deps, ioCancel);
  expect(cancel.exitCode).toBe(0);
  expect(ioCancel.out()).toContain("quay cancel");
  expect(ioCancel.out()).toContain("--close-pr");
});

test("bare sub-noun keeps usage_error JSON and adds usage block on stderr", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const io = bufferIO();
  const result = await dispatch(["repo"], built.deps, io);

  expect(result.exitCode).not.toBe(0);
  expect(io.out()).toBe("");
  // Structured envelope is the first line — machine consumers (hermes-agent)
  // keep parsing it.
  const parsed = parseFirstJsonLine(io.err());
  expect(parsed.error).toBe("usage_error");
  expect(parsed.message).toContain("repo subcommand required");
  // Human-readable usage block follows.
  expect(io.err()).toContain("Usage:");
  expect(io.err()).toContain("quay repo");
});

test("bare quay (no args) prints help to stderr, exit non-zero", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const io = bufferIO();
  const result = await dispatch([], built.deps, io);

  // Bare invocation is misuse for scripts but help is more useful than a
  // one-liner JSON error for a human, so we surface the usage block.
  expect(result.exitCode).not.toBe(0);
  expect(io.out()).toBe("");
  expect(io.err()).toContain("Usage:");
  expect(io.err()).toContain("quay <command>");
});

test("unknown top-level command emits JSON envelope plus one-line hint", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const io = bufferIO();
  const result = await dispatch(["bogus-command"], built.deps, io);

  expect(result.exitCode).not.toBe(0);
  expect(io.out()).toBe("");
  const parsed = parseFirstJsonLine(io.err());
  expect(parsed.error).toBe("usage_error");
  expect(parsed.message).toContain("unknown command: bogus-command");
  // Hint sits on a separate line so the JSON envelope above it stays
  // parseable on its own.
  expect(io.err()).toContain("quay --help");
});

test("artifact and task explicit help reach stdout", async () => {
  h = createHarness();
  const built = buildCliDeps(h);

  const ioArt = bufferIO();
  const artResult = await dispatch(["artifact", "--help"], built.deps, ioArt);
  expect(artResult.exitCode).toBe(0);
  expect(ioArt.out()).toContain("quay artifact");
  expect(ioArt.out()).toContain("get");

  const ioArtGet = bufferIO();
  const artGet = await dispatch(
    ["artifact", "get", "--help"],
    built.deps,
    ioArtGet,
  );
  expect(artGet.exitCode).toBe(0);
  expect(ioArtGet.out()).toContain("--attempt");
  expect(ioArtGet.out()).toContain("--path");

  const ioTaskList = bufferIO();
  const taskList = await dispatch(
    ["task", "list", "--help"],
    built.deps,
    ioTaskList,
  );
  expect(taskList.exitCode).toBe(0);
  expect(ioTaskList.out()).toContain("--state");
  expect(ioTaskList.out()).toContain("--repo");
});
