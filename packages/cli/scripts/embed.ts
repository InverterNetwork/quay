#!/usr/bin/env bun
// Generates packages/cli/src/build/embedded.generated.ts so the compiled
// `quay` binary can run without a sibling `migrations/` or `config/` dir on
// disk.
//
// Embeds:
//   - All migrations/*.sql files (sorted, name+sql pairs)
//   - The shipped default config/ticket_schema.toml
//   - Built Admin UI static assets when QUAY_UI_DIST_DIR is set, or when
//     packages/admin-ui/dist exists in this workspace
//   - Build version: $QUAY_VERSION (release tags) or "dev" + short git SHA
//
// Run by `bun install` (via the `prepare` script) and `bun run build`.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKSPACE_ROOT = resolve(PACKAGE_ROOT, "..", "..");
const MIGRATIONS_DIR = join(PACKAGE_ROOT, "migrations");
const SCHEMA_FILE = join(PACKAGE_ROOT, "config", "ticket_schema.toml");
const OUT_FILE = join(PACKAGE_ROOT, "src", "build", "embedded.generated.ts");
const DEFAULT_UI_DIST_DIR = join(PACKAGE_ROOT, "..", "admin-ui", "dist");

interface EmbeddedUiAsset {
  path: string;
  contentBase64: string;
}

function readMigrations(): Array<{ name: string; sql: string }> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files.map((name) => ({
    name,
    sql: readFileSync(join(MIGRATIONS_DIR, name), "utf8"),
  }));
}

function readSchema(): string {
  return readFileSync(SCHEMA_FILE, "utf8");
}

export function resolveUiDistDir(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const configured = env.QUAY_UI_DIST_DIR;
  if (configured !== undefined) {
    if (configured.trim() === "") {
      throw new Error("QUAY_UI_DIST_DIR must not be empty when set");
    }
    return resolve(PACKAGE_ROOT, configured);
  }
  return existsSync(DEFAULT_UI_DIST_DIR) ? DEFAULT_UI_DIST_DIR : null;
}

function assertUiDistDir(path: string): void {
  let dirStat: ReturnType<typeof statSync>;
  try {
    dirStat = statSync(path);
  } catch {
    throw new Error(`QUAY_UI_DIST_DIR path does not exist: ${path}`);
  }
  if (!dirStat.isDirectory()) {
    throw new Error(`QUAY_UI_DIST_DIR must point to a directory: ${path}`);
  }
  const indexPath = join(path, "index.html");
  let indexStat: ReturnType<typeof statSync>;
  try {
    indexStat = statSync(indexPath);
  } catch {
    throw new Error(`QUAY_UI_DIST_DIR must contain index.html: ${indexPath}`);
  }
  if (!indexStat.isFile()) {
    throw new Error(`QUAY_UI_DIST_DIR must contain index.html: ${indexPath}`);
  }
}

function listUiAssetPaths(root: string, relativeDir = ""): string[] {
  const dirPath = relativeDir === ""
    ? root
    : join(root, ...relativeDir.split("/").filter(Boolean));
  const entries = readdirSync(dirPath, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = relativeDir === ""
      ? entry.name
      : `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...listUiAssetPaths(root, relativePath));
      continue;
    }
    if (entry.isFile()) {
      files.push(relativePath);
      continue;
    }
    throw new Error(`unsupported UI asset type: ${join(dirPath, entry.name)}`);
  }
  return files;
}

export function readEmbeddedUiAssets(
  env: Record<string, string | undefined> = process.env,
): EmbeddedUiAsset[] {
  const uiDistDir = resolveUiDistDir(env);
  if (uiDistDir === null) return [];
  assertUiDistDir(uiDistDir);
  return listUiAssetPaths(uiDistDir).map((path) => ({
    path,
    contentBase64: readFileSync(join(uiDistDir, ...path.split("/"))).toString(
      "base64",
    ),
  }));
}

function readGitSha(): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
      cwd: WORKSPACE_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], {
      cwd: WORKSPACE_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return dirty.length > 0 ? `${sha}+dirty` : sha;
  } catch {
    return "unknown";
  }
}

export function formatBuildVersion(
  injectedVersion: string | undefined,
  sha: string,
): string {
  const baseVersion = injectedVersion?.trim() || "dev";
  return `${baseVersion}+${sha}`;
}

function buildVersion(
  env: Record<string, string | undefined> = process.env,
): string {
  return formatBuildVersion(env.QUAY_VERSION, readGitSha());
}

function tsLiteral(s: string): string {
  // JSON.stringify yields a valid TS string literal for any UTF-8 input,
  // escaping quotes/newlines/control chars correctly.
  return JSON.stringify(s);
}

function render(env: Record<string, string | undefined> = process.env): string {
  const migrations = readMigrations();
  const schema = readSchema();
  const uiAssets = readEmbeddedUiAssets(env);
  const version = buildVersion(env);

  const migrationLines = migrations
    .map(
      (m) =>
        `  { name: ${tsLiteral(m.name)}, sql: ${tsLiteral(m.sql)} },`,
    )
    .join("\n");
  const uiAssetLines = uiAssets
    .map(
      (asset) =>
        `  { path: ${tsLiteral(asset.path)}, contentBase64: ${tsLiteral(asset.contentBase64)} },`,
    )
    .join("\n");

  return `// AUTO-GENERATED by packages/cli/scripts/embed.ts. Do not edit by hand.
// Regenerated on bun install (prepare hook) and bun run build.

import type { Migration } from "../db/migrate.ts";

export const QUAY_VERSION = ${tsLiteral(version)};

export const EMBEDDED_MIGRATIONS: readonly Migration[] = [
${migrationLines}
];

export const EMBEDDED_TICKET_SCHEMA = ${tsLiteral(schema)};

export interface EmbeddedUiAsset {
  readonly path: string;
  readonly contentBase64: string;
}

export const EMBEDDED_UI_ASSETS: readonly EmbeddedUiAsset[] = [
${uiAssetLines}
];
`;
}

function main(): void {
  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, render(), "utf8");
}

if (import.meta.main) {
  main();
}
