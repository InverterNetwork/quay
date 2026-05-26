import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..", "..");

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

test("release workflow builds and embeds local Admin UI before compiling binaries", () => {
  const release = readFileSync(
    join(root, ".github", "workflows", "release.yml"),
    "utf8",
  );
  expect(release).not.toContain("repository: InverterNetwork/quay-ui");
  expect(release).not.toContain("QUAY_UI_READ_TOKEN");
  expect(release).toContain("Build Admin UI");
  expect(release).toContain("bun run admin-ui:build");
  expect(release).toContain("QUAY_UI_DIST_DIR: ${{ github.workspace }}/packages/admin-ui/dist");
  expect(release).toContain("bun run --cwd packages/cli scripts/embed.ts");
  expect(release).toContain("packages/cli/src/cli/index.ts");
  expect(release).toContain("curl -fsS http://127.0.0.1:19731/");
  expect(release).toContain("grep -q '<div id=\"root\"></div>'");
});

test("local build script uses the same compiled-binary startup safeguards", () => {
  const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts: { build: string };
  };
  const cliPkg = JSON.parse(readFileSync(
    join(root, "packages", "cli", "package.json"),
    "utf8",
  )) as {
    scripts: { build: string };
  };
  expect(rootPkg.scripts.build).toContain("bun run admin-ui:build");
  expect(rootPkg.scripts.build).toContain("bun run --cwd packages/cli build");
  expect(cliPkg.scripts.build).not.toContain("--compile-exec-argv=--cwd=/");
  expect(cliPkg.scripts.build).toContain("--no-compile-autoload-bunfig");
  expect(cliPkg.scripts.build).toContain("--no-compile-autoload-dotenv");
});
