import { expect, test } from "bun:test";
import { formatBuildVersion } from "../../scripts/embed.ts";

test("formatBuildVersion uses the injected release tag when present", () => {
  expect(formatBuildVersion("v0.3.3", "99caa0b")).toBe("v0.3.3+99caa0b");
});

test("formatBuildVersion falls back to dev for local builds", () => {
  expect(formatBuildVersion(undefined, "99caa0b")).toBe("dev+99caa0b");
  expect(formatBuildVersion("  ", "99caa0b")).toBe("dev+99caa0b");
});
