import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetAgentIdentityCacheForTests,
  parseAgentBinary,
  probeAgentIdentity,
} from "../../src/core/agent_identity.ts";

afterEach(() => {
  __resetAgentIdentityCacheForTests();
});

test("parseAgentBinary returns first whitespace token", () => {
  expect(parseAgentBinary("claude --permission-mode bypassPermissions")).toBe(
    "claude",
  );
  expect(parseAgentBinary("  bun  --version")).toBe("bun");
});

test("parseAgentBinary handles single- and double-quoted paths without internal spaces", () => {
  expect(parseAgentBinary(`"/usr/local/bin/claude" -p`)).toBe(
    "/usr/local/bin/claude",
  );
  expect(parseAgentBinary(`'claude' -p`)).toBe("claude");
});

test("parseAgentBinary handles quoted paths with internal spaces", () => {
  expect(
    parseAgentBinary(
      `"/Applications/Claude Code.app/Contents/MacOS/claude" < {prompt_file}`,
    ),
  ).toBe("/Applications/Claude Code.app/Contents/MacOS/claude");
  expect(parseAgentBinary(`'path with spaces/claude' -p`)).toBe(
    "path with spaces/claude",
  );
});

test("parseAgentBinary skips leading env-var assignments", () => {
  expect(parseAgentBinary("ANTHROPIC_MODEL=opus claude < {prompt_file}")).toBe(
    "claude",
  );
  expect(
    parseAgentBinary("FOO=bar BAZ=qux /usr/bin/claude --permission-mode x"),
  ).toBe("/usr/bin/claude");
  expect(parseAgentBinary("_LEADING_UNDERSCORE=ok claude")).toBe("claude");
});

test("parseAgentBinary stops at shell control characters", () => {
  expect(parseAgentBinary("claude < {prompt_file}")).toBe("claude");
  expect(parseAgentBinary("claude | tee out.log")).toBe("claude");
  expect(parseAgentBinary("claude; echo done")).toBe("claude");
  expect(parseAgentBinary("claude && echo ok")).toBe("claude");
});

test("parseAgentBinary returns null for empty/whitespace/all-assignments input", () => {
  expect(parseAgentBinary("")).toBeNull();
  expect(parseAgentBinary("   ")).toBeNull();
  expect(parseAgentBinary("FOO=bar")).toBeNull();
  expect(parseAgentBinary("FOO=bar BAZ=qux")).toBeNull();
});

test("probeAgentIdentity returns runtime/version/unknown for an existing binary", () => {
  const id = probeAgentIdentity("bun --version");
  expect(id.startsWith("bun/")).toBe(true);
  expect(id.endsWith("/unknown")).toBe(true);
  expect(id.split("/").length).toBe(3);
  const [, version] = id.split("/");
  expect(version!.length).toBeGreaterThan(0);
  expect(version).not.toBe("unknown");
});

test("probeAgentIdentity falls back to unknown version when binary is missing", () => {
  const random = `quay-nonexistent-${Math.random().toString(36).slice(2, 10)}`;
  const id = probeAgentIdentity(`${random} --some-flag`);
  expect(id).toBe(`${random}/unknown/unknown`);
});

test("probeAgentIdentity uses the basename when the path is absolute", () => {
  const id = probeAgentIdentity("/bin/sh -c true");
  expect(id.startsWith("sh/")).toBe(true);
  expect(id.endsWith("/unknown")).toBe(true);
});

test("probeAgentIdentity collapses to all-unknown for empty invocation", () => {
  expect(probeAgentIdentity("")).toBe("unknown/unknown/unknown");
  expect(probeAgentIdentity("   ")).toBe("unknown/unknown/unknown");
});

test("probeAgentIdentity probes the command word past env-var assignments", () => {
  const id = probeAgentIdentity("ANTHROPIC_MODEL=opus bun --version");
  expect(id.startsWith("bun/")).toBe(true);
  expect(id).not.toBe("ANTHROPIC_MODEL=opus/unknown/unknown");
});

test("probeAgentIdentity memoises by invocation string", () => {
  const tmp = mkdtempSync(join(tmpdir(), "quay-probe-cache-"));
  const fakeBin = join(tmp, "fake-agent");
  writeFileSync(fakeBin, `#!/bin/sh\necho "fake-agent 1.0.0"\n`);
  chmodSync(fakeBin, 0o755);
  try {
    const invocation = `${fakeBin} -p`;
    const first = probeAgentIdentity(invocation);
    expect(first).toBe("fake-agent/fake-agent 1.0.0/unknown");

    // Replace the binary with one that prints a different version. The
    // cache must short-circuit and return the original probe result —
    // probes are per-process and operator config does not change at
    // runtime, so re-probing every tick would be pointless work.
    writeFileSync(fakeBin, `#!/bin/sh\necho "fake-agent 9.9.9"\n`);
    const second = probeAgentIdentity(invocation);
    expect(second).toBe(first);

    // After cache reset the same invocation re-probes and observes the
    // updated binary.
    __resetAgentIdentityCacheForTests();
    const third = probeAgentIdentity(invocation);
    expect(third).toBe("fake-agent/fake-agent 9.9.9/unknown");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("probeAgentIdentity caps a runaway version line at 256 characters", () => {
  const tmp = mkdtempSync(join(tmpdir(), "quay-probe-cap-"));
  const fakeBin = join(tmp, "verbose-agent");
  // Single line with 1 KiB of payload — the cap matters most when a
  // misbehaving CLI floods stdout on its first line.
  writeFileSync(fakeBin, `#!/bin/sh\nprintf '%s' "${"x".repeat(1024)}"\n`);
  chmodSync(fakeBin, 0o755);
  try {
    const id = probeAgentIdentity(`${fakeBin} -p`);
    const parts = id.split("/");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("verbose-agent");
    expect(parts[1]!.length).toBe(256);
    expect(parts[2]).toBe("unknown");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
