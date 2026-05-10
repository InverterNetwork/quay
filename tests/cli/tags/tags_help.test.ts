import { test, expect, afterEach } from "bun:test";
import { createHarness, type Harness } from "../../support/harness.ts";
import { buildCliDeps } from "../../support/cli_deps.ts";
import { dispatch } from "../../../src/cli/dispatch.ts";
import { bufferIO } from "../../../src/cli/io.ts";
import { topLevelHelp } from "../../../src/cli/help.ts";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

const HELP_SUBCOMMANDS = [
  ["tags", "--help"],
  ["tags", "set-deployment", "--help"],
  ["tags", "unset-deployment", "--help"],
  ["tags", "get-deployment", "--help"],
  ["tags", "apply-deployment", "--help"],
  ["tags", "import", "--help"],
  ["tags", "list", "--help"],
];

for (const argv of HELP_SUBCOMMANDS) {
  test(`${argv.join(" ")} exits 0 and contains "Usage:"`, async () => {
    h = createHarness();
    const built = buildCliDeps(h);

    const io = bufferIO();
    const result = await dispatch(argv, built.deps, io);
    expect(result.exitCode).toBe(0);
    expect(io.out()).toContain("Usage:");
    h?.cleanup();
    h = null;
  });
}

test("tags noun appears in top-level help", () => {
  const help = topLevelHelp();
  expect(help).toContain("tags");
});
