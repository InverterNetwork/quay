import { expect, test } from "bun:test";
import {
  parseAgentBinary,
  probeAgentIdentity,
} from "../../src/core/agent_identity.ts";

test("parseAgentBinary returns first whitespace token", () => {
  expect(parseAgentBinary("claude --permission-mode bypassPermissions")).toBe(
    "claude",
  );
  expect(parseAgentBinary("  bun  --version")).toBe("bun");
});

test("parseAgentBinary strips wrapping quotes", () => {
  expect(parseAgentBinary(`"/usr/local/bin/claude" -p`)).toBe(
    "/usr/local/bin/claude",
  );
  expect(parseAgentBinary(`'claude' -p`)).toBe("claude");
});

test("parseAgentBinary returns null for empty/whitespace input", () => {
  expect(parseAgentBinary("")).toBeNull();
  expect(parseAgentBinary("   ")).toBeNull();
});

test("probeAgentIdentity returns runtime/version/unknown for an existing binary", () => {
  // `bun` is the runtime executing this test, so it's guaranteed on PATH.
  const id = probeAgentIdentity("bun --version");
  expect(id.startsWith("bun/")).toBe(true);
  expect(id.endsWith("/unknown")).toBe(true);
  // Format guarantee: exactly two slashes (runtime / version / model).
  expect(id.split("/").length).toBe(3);
  // The version segment must be non-empty and not the literal placeholder.
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
  // /bin/sh exists on every POSIX system we ship to. `sh --version` is
  // shell-dependent (dash exits non-zero, bash prints version) — the test
  // only asserts the runtime token comes from the basename, regardless of
  // whether the version probe succeeds.
  const id = probeAgentIdentity("/bin/sh -c true");
  expect(id.startsWith("sh/")).toBe(true);
  expect(id.endsWith("/unknown")).toBe(true);
});

test("probeAgentIdentity collapses to all-unknown for empty invocation", () => {
  expect(probeAgentIdentity("")).toBe("unknown/unknown/unknown");
  expect(probeAgentIdentity("   ")).toBe("unknown/unknown/unknown");
});
