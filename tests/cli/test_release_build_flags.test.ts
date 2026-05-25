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

test("release workflow builds and embeds Quay UI before compiling binaries", () => {
  const release = readFileSync(
    join(root, ".github", "workflows", "release.yml"),
    "utf8",
  );
  expect(release).toContain("echo \"quay-ui/\" >> .git/info/exclude");
  expect(release).toContain("repository: InverterNetwork/quay-ui");
  expect(release).toContain("token: ${{ secrets.QUAY_UI_READ_TOKEN || github.token }}");
  expect(release).toContain("working-directory: quay-ui");
  expect(release).toContain("bun run build");
  expect(release).toContain("QUAY_UI_DIST_DIR: ${{ github.workspace }}/quay-ui/dist");
  expect(release).toContain("bun run scripts/embed.ts");
});

test("local build script uses the same compiled-binary startup safeguards", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts: { build: string };
  };
  expect(pkg.scripts.build).not.toContain("--compile-exec-argv=--cwd=/");
  expect(pkg.scripts.build).toContain("--no-compile-autoload-bunfig");
  expect(pkg.scripts.build).toContain("--no-compile-autoload-dotenv");
});
