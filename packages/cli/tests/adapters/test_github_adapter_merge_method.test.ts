// Setup mirrors the other adapter tests: shadow the real `gh` binary with a
// stub script on PATH. The stub reports a configurable merge-method policy for
// `gh api repos/{owner}/{repo}` and logs the flag passed to `gh pr merge` so
// each case can assert which flag the adapter chose.

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  GitHubCliAdapter,
  classifyMergeErrorKind,
} from "../../src/adapters/github.ts";
import { GitHubMergeError } from "../../src/ports/github.ts";

let cleanups: Array<() => void> = [];
let savedPath: string | undefined;

beforeEach(() => {
  savedPath = process.env.PATH;
});

afterEach(() => {
  if (savedPath !== undefined) process.env.PATH = savedPath;
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {}
  }
});

function tempDir(prefix = "quay-gh-merge-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function installGhStub(body: string): string {
  const bin = tempDir();
  writeFileSync(join(bin, "gh"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  return bin;
}

function makeBareDir(): { reposRoot: string; repoId: string } {
  const reposRoot = tempDir("quay-gh-merge-repos-");
  const repoId = "fake-repo";
  mkdirSync(join(reposRoot, `${repoId}.git`), { recursive: true });
  return { reposRoot, repoId };
}

interface AllowPolicy {
  merge: boolean;
  squash: boolean;
  rebase: boolean;
}

// A `gh` stub that answers `gh api repos/...` with the given policy (appending
// one line to `apiLog` per read) and answers `gh pr merge ...` by appending the
// full argv to `mergeLog`, then exits with `mergeExit` (writing `mergeStderr`).
function mergeMethodStub(opts: {
  allow: AllowPolicy;
  apiLog: string;
  mergeLog: string;
  mergeExit?: number;
  mergeStderr?: string;
}): string {
  const { allow, apiLog, mergeLog } = opts;
  const mergeExit = opts.mergeExit ?? 0;
  const mergeStderr = opts.mergeStderr ?? "";
  return `
if [ "$1" = "api" ]; then
  case "$2" in
    repos/*)
      printf 'read\\n' >> '${apiLog}'
      echo '{"allow_merge_commit":${allow.merge},"allow_squash_merge":${allow.squash},"allow_rebase_merge":${allow.rebase}}'
      exit 0
      ;;
  esac
fi
if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then
  printf '%s\\n' "$*" >> '${mergeLog}'
  ${mergeStderr === "" ? "" : `echo '${mergeStderr}' 1>&2`}
  exit ${mergeExit}
fi
echo "unexpected: $*" 1>&2
exit 2
`;
}

function newLogs(): { apiLog: string; mergeLog: string } {
  const d = tempDir("quay-gh-merge-logs-");
  return { apiLog: join(d, "api.log"), mergeLog: join(d, "merge.log") };
}

test("squash-only repo merges via --squash, not --merge", () => {
  const { apiLog, mergeLog } = newLogs();
  installGhStub(
    mergeMethodStub({
      allow: { merge: false, squash: true, rebase: false },
      apiLog,
      mergeLog,
    }),
  );
  const { reposRoot, repoId } = makeBareDir();
  const adapter = new GitHubCliAdapter(reposRoot);

  adapter.mergePullRequest(repoId, 263, "deadbeef");

  const logged = readFileSync(mergeLog, "utf8");
  expect(logged).toContain("--squash");
  expect(logged).not.toContain("--merge");
  expect(logged).toContain("--match-head-commit deadbeef");
});

test("merge-commit repo still merges via --merge (unchanged behavior)", () => {
  const { apiLog, mergeLog } = newLogs();
  // Multiple methods allowed → deterministic preference keeps `--merge`.
  installGhStub(
    mergeMethodStub({
      allow: { merge: true, squash: true, rebase: true },
      apiLog,
      mergeLog,
    }),
  );
  const { reposRoot, repoId } = makeBareDir();
  const adapter = new GitHubCliAdapter(reposRoot);

  adapter.mergePullRequest(repoId, 42, "cafef00d");

  const logged = readFileSync(mergeLog, "utf8");
  expect(logged).toContain("--merge");
  expect(logged).not.toContain("--squash");
  expect(logged).not.toContain("--rebase");
});

test("rebase-only repo merges via --rebase", () => {
  const { apiLog, mergeLog } = newLogs();
  installGhStub(
    mergeMethodStub({
      allow: { merge: false, squash: false, rebase: true },
      apiLog,
      mergeLog,
    }),
  );
  const { reposRoot, repoId } = makeBareDir();
  const adapter = new GitHubCliAdapter(reposRoot);

  adapter.mergePullRequest(repoId, 7, "abc123");

  const logged = readFileSync(mergeLog, "utf8");
  expect(logged).toContain("--rebase");
  expect(logged).not.toContain("--merge");
  expect(logged).not.toContain("--squash");
});

test("squash preferred over rebase when merge disallowed", () => {
  const { apiLog, mergeLog } = newLogs();
  installGhStub(
    mergeMethodStub({
      allow: { merge: false, squash: true, rebase: true },
      apiLog,
      mergeLog,
    }),
  );
  const { reposRoot, repoId } = makeBareDir();
  const adapter = new GitHubCliAdapter(reposRoot);

  adapter.mergePullRequest(repoId, 9, "sha9");

  const logged = readFileSync(mergeLog, "utf8");
  expect(logged).toContain("--squash");
  expect(logged).not.toContain("--rebase");
});

test("repo allowing no merge method raises a clear error", () => {
  const { apiLog, mergeLog } = newLogs();
  installGhStub(
    mergeMethodStub({
      allow: { merge: false, squash: false, rebase: false },
      apiLog,
      mergeLog,
    }),
  );
  const { reposRoot, repoId } = makeBareDir();
  const adapter = new GitHubCliAdapter(reposRoot);

  expect(() => adapter.mergePullRequest(repoId, 1, "sha")).toThrow(
    /allows no merge method/i,
  );
});

test("allowed merge method is cached per repo (single api read across merges)", () => {
  const { apiLog, mergeLog } = newLogs();
  installGhStub(
    mergeMethodStub({
      allow: { merge: false, squash: true, rebase: false },
      apiLog,
      mergeLog,
    }),
  );
  const { reposRoot, repoId } = makeBareDir();
  const adapter = new GitHubCliAdapter(reposRoot);

  adapter.mergePullRequest(repoId, 263, "sha263");
  adapter.mergePullRequest(repoId, 264, "sha264");
  adapter.mergePullRequest(repoId, 265, "sha265");

  // Three merges, but the merge-method policy is read exactly once.
  const reads = readFileSync(apiLog, "utf8").trim().split("\n").filter(Boolean);
  expect(reads).toHaveLength(1);
  const merges = readFileSync(mergeLog, "utf8").trim().split("\n").filter(Boolean);
  expect(merges).toHaveLength(3);
  expect(merges.every((m) => m.includes("--squash"))).toBe(true);
});

test("policy-rejected merge throws GitHubMergeError kind=method_not_allowed", () => {
  const { apiLog, mergeLog } = newLogs();
  // Method selection picks --merge (allowed per policy) but the merge itself
  // is rejected by a branch/repo rule.
  installGhStub(
    mergeMethodStub({
      allow: { merge: true, squash: false, rebase: false },
      apiLog,
      mergeLog,
      mergeExit: 1,
      mergeStderr: "Merge commits are not allowed on this repository",
    }),
  );
  const { reposRoot, repoId } = makeBareDir();
  const adapter = new GitHubCliAdapter(reposRoot);

  let caught: unknown;
  try {
    adapter.mergePullRequest(repoId, 263, "sha263");
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(GitHubMergeError);
  expect((caught as GitHubMergeError).kind).toBe("method_not_allowed");
});

test("classifyMergeErrorKind maps gh merge failure messages", () => {
  expect(
    classifyMergeErrorKind("Merge commits are not allowed on this repository"),
  ).toBe("method_not_allowed");
  expect(
    classifyMergeErrorKind("Squash merges are not allowed on this repository"),
  ).toBe("method_not_allowed");
  expect(
    classifyMergeErrorKind("Rebase merges are not allowed on this repository"),
  ).toBe("method_not_allowed");
  expect(
    classifyMergeErrorKind(
      "GraphQL: Head branch was modified. Review and try the merge again.",
    ),
  ).toBe("head_mismatch");
  expect(classifyMergeErrorKind("Pull request is not mergeable")).toBe(
    "not_mergeable",
  );
  expect(classifyMergeErrorKind("some unrecognized gh error")).toBe("unknown");
});
