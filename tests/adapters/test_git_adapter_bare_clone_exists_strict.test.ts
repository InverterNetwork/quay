// Spec §12 / AST-76: bareCloneExists must not return true for an empty
// directory at the expected path. A vanilla `mkdir <repos_root>/<repo_id>.git`
// (typoed path, half-finished clone, interrupted `git clone --bare`) would
// previously bypass the bare_clone_missing friendly-error path and instead
// hit an obscure `git fetch origin ... failed: fatal: not a git repository`.
//
// The fix: also require a HEAD file — the canonical "this is a git repo" marker
// present in every bare (and non-bare) git clone. This test verifies the
// JS-level check without requiring a real git install.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { LocalGitAdapter } from "../../src/adapters/git.ts";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {}
  }
});

function tempDir(prefix = "quay-bare-exists-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

test("bareCloneExists returns false for an empty directory at the expected path", () => {
  const reposRoot = tempDir();
  const repoId = "test-repo";
  // Create an empty directory at <reposRoot>/<repoId>.git — no HEAD file.
  mkdirSync(join(reposRoot, `${repoId}.git`));

  const adapter = new LocalGitAdapter(reposRoot);
  expect(adapter.bareCloneExists(repoId)).toBe(false);
});

test("bareCloneExists returns false when path does not exist at all", () => {
  const reposRoot = tempDir();
  const adapter = new LocalGitAdapter(reposRoot);
  expect(adapter.bareCloneExists("nonexistent-repo")).toBe(false);
});

test("bareCloneExists returns true when HEAD file is present", () => {
  const reposRoot = tempDir();
  const repoId = "real-repo";
  const bareDir = join(reposRoot, `${repoId}.git`);
  mkdirSync(bareDir);
  // Write a minimal HEAD file (as `git clone --bare` would).
  writeFileSync(join(bareDir, "HEAD"), "ref: refs/heads/main\n");

  const adapter = new LocalGitAdapter(reposRoot);
  expect(adapter.bareCloneExists(repoId)).toBe(true);
});
