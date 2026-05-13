import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");

test("release builds compiled binaries with autoload startup safeguards", () => {
  const release = readFileSync(
    join(root, ".github", "workflows", "release.yml"),
    "utf8",
  );
  const buildLines = release
    .split("\n")
    .filter((line) => line.includes("bun build --compile"));
  expect(buildLines).toHaveLength(4);
  for (const line of buildLines) {
    expect(line).not.toContain("--compile-exec-argv=--cwd=/");
    expect(line).toContain("--no-compile-autoload-bunfig");
    expect(line).toContain("--no-compile-autoload-dotenv");
  }
});

test("local build script uses the same compiled-binary startup safeguards", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts: { build: string };
  };
  expect(pkg.scripts.build).not.toContain("--compile-exec-argv=--cwd=/");
  expect(pkg.scripts.build).toContain("--no-compile-autoload-bunfig");
  expect(pkg.scripts.build).toContain("--no-compile-autoload-dotenv");
});
