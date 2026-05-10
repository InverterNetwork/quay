// Real-git integration coverage for LocalGitAdapter.diffSummary. Builds a
// throwaway non-bare repo with two commits, then calls diffSummary against
// it (the adapter is bare-only by API but plain `git diff` runs identically
// against either layout — the bareDir-derived cwd just has to be a working
// git directory). Verifies the merged numstat + name-status output.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalGitAdapter } from "../../src/adapters/git.ts";

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {}
  }
});

function tempDir(prefix = "quay-diff-summary-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runIn(cwd: string, cmd: string[]): RunResult {
  const r = Bun.spawnSync({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: r.exitCode ?? 0,
    stdout: new TextDecoder().decode(r.stdout ?? new Uint8Array()),
    stderr: new TextDecoder().decode(r.stderr ?? new Uint8Array()),
  };
}

function git(cwd: string, args: string[]): void {
  const r = runIn(cwd, ["git", ...args]);
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  }
}

interface RepoSetup {
  reposRoot: string;
  repoId: string;
  bareDir: string;
  baseSha: string;
  headSha: string;
}

function setupRepoWithTwoCommits(): RepoSetup {
  const reposRoot = tempDir();
  const repoId = "diff-summary-repo";
  const bareDir = join(reposRoot, `${repoId}.git`);
  // The adapter only needs a working git directory at <reposRoot>/<repoId>.git
  // — using a normal init avoids the dance of cloning into bare and rewriting
  // refs. `git diff <base>..<head>` works identically.
  mkdirSync(bareDir);
  git(bareDir, ["init", "-q", "--initial-branch=main"]);
  git(bareDir, ["config", "user.email", "test@example.com"]);
  git(bareDir, ["config", "user.name", "test"]);

  writeFileSync(join(bareDir, "keep.txt"), "stable\n");
  writeFileSync(join(bareDir, "remove.txt"), "going away\n");
  writeFileSync(join(bareDir, "modify.txt"), "line 1\nline 2\nline 3\n");
  git(bareDir, ["add", "."]);
  git(bareDir, ["commit", "-q", "-m", "base"]);
  const baseShaRaw = runIn(bareDir, ["git", "rev-parse", "HEAD"]).stdout.trim();

  rmSync(join(bareDir, "remove.txt"));
  writeFileSync(
    join(bareDir, "modify.txt"),
    "line 1 changed\nline 2\nline 3\nline 4\n",
  );
  writeFileSync(join(bareDir, "added.txt"), "brand new\nsecond line\n");
  git(bareDir, ["add", "-A"]);
  git(bareDir, ["commit", "-q", "-m", "head"]);
  const headShaRaw = runIn(bareDir, ["git", "rev-parse", "HEAD"]).stdout.trim();

  return {
    reposRoot,
    repoId,
    bareDir,
    baseSha: baseShaRaw,
    headSha: headShaRaw,
  };
}

test("diffSummary returns merged numstat + name-status for a real repo", () => {
  const setup = setupRepoWithTwoCommits();
  const adapter = new LocalGitAdapter(setup.reposRoot);

  const summary = adapter.diffSummary(
    setup.repoId,
    setup.baseSha,
    setup.headSha,
  );
  expect(summary).not.toBeNull();
  expect(summary!.files_changed).toBe(3);

  const byPath = new Map(summary!.files.map((f) => [f.path, f]));
  expect(byPath.get("added.txt")).toEqual({
    path: "added.txt",
    status: "A",
    ins: 2,
    del: 0,
  });
  expect(byPath.get("remove.txt")).toEqual({
    path: "remove.txt",
    status: "D",
    ins: 0,
    del: 1,
  });
  expect(byPath.get("modify.txt")).toEqual({
    path: "modify.txt",
    status: "M",
    ins: 2,
    del: 1,
  });

  // Aggregates match the per-file values.
  const ins = summary!.files.reduce((a, f) => a + (f.ins ?? 0), 0);
  const del = summary!.files.reduce((a, f) => a + (f.del ?? 0), 0);
  expect(summary!.insertions).toBe(ins);
  expect(summary!.deletions).toBe(del);
});

test("diffSummary returns null when a SHA is not present in the repo", () => {
  const setup = setupRepoWithTwoCommits();
  const adapter = new LocalGitAdapter(setup.reposRoot);

  const summary = adapter.diffSummary(
    setup.repoId,
    "0000000000000000000000000000000000000000",
    setup.headSha,
  );
  expect(summary).toBeNull();
});
