import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatBuildVersion,
  hasRelevantDirtyStatus,
  readEmbeddedUiAssets,
} from "../../scripts/embed.ts";

test("formatBuildVersion uses the injected release tag when present", () => {
  expect(formatBuildVersion("v0.3.3", "99caa0b")).toBe("v0.3.3+99caa0b");
});

test("formatBuildVersion falls back to dev for local builds", () => {
  expect(formatBuildVersion(undefined, "99caa0b")).toBe("dev+99caa0b");
  expect(formatBuildVersion("  ", "99caa0b")).toBe("dev+99caa0b");
});

test("generated embed output alone does not mark release builds dirty", () => {
  expect(
    hasRelevantDirtyStatus(" M packages/cli/src/build/embedded.generated.ts"),
  ).toBe(false);
  expect(
    hasRelevantDirtyStatus(
      [
        " M packages/cli/src/build/embedded.generated.ts",
        " M packages/cli/src/admin/api.ts",
      ].join("\n"),
    ),
  ).toBe(true);
});

test("readEmbeddedUiAssets packages explicit UI dist assets deterministically", () => {
  const uiDir = mkdtempSync(join(tmpdir(), "quay-ui-embed-"));
  try {
    mkdirSync(join(uiDir, "assets"));
    writeFileSync(join(uiDir, "index.html"), "<!doctype html><div id=\"root\"></div>");
    writeFileSync(join(uiDir, "assets", "app.js"), "console.log('quay');");

    const assets = readEmbeddedUiAssets({ QUAY_UI_DIST_DIR: uiDir });

    expect(assets.map((asset) => asset.path)).toEqual([
      "assets/app.js",
      "index.html",
    ]);
    expect(
      Buffer.from(assets[0]?.contentBase64 ?? "", "base64").toString("utf8"),
    ).toBe("console.log('quay');");
    expect(
      Buffer.from(assets[1]?.contentBase64 ?? "", "base64").toString("utf8"),
    ).toContain("<div id=\"root\"></div>");
  } finally {
    rmSync(uiDir, { recursive: true, force: true });
  }
});
