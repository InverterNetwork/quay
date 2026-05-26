import { expect, test } from "bun:test";
import { detectStartupEnvHazard } from "../../src/cli/startup_env.ts";

test("startup env guard allows an unreadable cwd when QUAY_DATA_DIR is visible", () => {
  const result = detectStartupEnvHazard({
    env: { QUAY_DATA_DIR: "/canonical/quay" },
    invocationCwd: "/root",
    canReadDir: () => false,
  });
  expect(result).toBeNull();
});

test("startup env guard rejects unreadable cwd without visible Quay config env", () => {
  const result = detectStartupEnvHazard({
    env: {},
    invocationCwd: "/root",
    canReadDir: () => false,
  });
  expect(result).toContain("startup environment is unsafe");
  expect(result).toContain("refusing to use the ~/.quay fallback");
});

test("startup env guard rejects unresolved cwd without visible Quay config env", () => {
  const result = detectStartupEnvHazard({
    env: {},
    invocationCwd: undefined,
  });
  expect(result).toContain("inherited cwd could not be resolved");
});

test("startup env guard allows ordinary ~/.quay fallback from readable cwd", () => {
  const result = detectStartupEnvHazard({
    env: {},
    invocationCwd: "/tmp",
    canReadDir: () => true,
  });
  expect(result).toBeNull();
});
