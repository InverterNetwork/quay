// Regression: `prCheckStatus` is the convenience read for callers that want
// a single PR's CI verdict without going through the tick-side `classifyCi`.
// It must preserve no-CI pass behavior for an empty reported set, while still
// treating any reported failure as blocking even when GitHub marks it
// non-required.
import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "bun:test";
import { GitHubCliAdapter } from "../../src/adapters/github.ts";

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

function tempDir(prefix = "quay-gh-noreq-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function installGhStub(body: string): void {
  const bin = tempDir();
  writeFileSync(join(bin, "gh"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
}

function makeBareDir(): { reposRoot: string; repoId: string } {
  const reposRoot = tempDir("quay-gh-repos-");
  const repoId = "fake-repo";
  mkdirSync(join(reposRoot, `${repoId}.git`), { recursive: true });
  return { reposRoot, repoId };
}

test("prCheckStatus returns pass when no required checks are configured", () => {
  // Two passing non-required checks in the unfiltered set, an empty
  // `--required` array. Non-required passing rows do not block.
  installGhStub(`
case "$*" in
  *"checks"*"--required"*)
    echo '[]'
    exit 0
    ;;
  *"checks"*)
    echo '[{"bucket":"pass","workflow":"ci","name":"lint","state":"SUCCESS"},{"bucket":"pass","workflow":"ci","name":"build","state":"SUCCESS"}]'
    exit 0
    ;;
  *"view"*)
    echo '{"state":"OPEN","headRefOid":"abc","baseRefOid":"def","mergeable":"MERGEABLE","reviewDecision":"NONE","latestReviews":[]}'
    exit 0
    ;;
  *)
    echo '[]'
    exit 0
    ;;
esac
`);
  const { reposRoot, repoId } = makeBareDir();
  const adapter = new GitHubCliAdapter(reposRoot);
  const status = adapter.prCheckStatus(repoId, "quay/branch");
  expect(status.state).toBe("pass");
});

test("prCheckStatus returns fail on a non-required failing check", () => {
  installGhStub(`
case "$*" in
  *"checks"*"--required"*)
    echo '[]'
    exit 0
    ;;
  *"checks"*)
    echo '[{"bucket":"fail","workflow":"installer-smoke","name":"install","state":"FAILURE"}]'
    exit 1
    ;;
  *"view"*)
    echo '{"state":"OPEN","headRefOid":"abc","baseRefOid":"def","mergeable":"MERGEABLE","reviewDecision":"NONE","latestReviews":[]}'
    exit 0
    ;;
  *)
    echo '[]'
    exit 0
    ;;
esac
`);
  const { reposRoot, repoId } = makeBareDir();
  const adapter = new GitHubCliAdapter(reposRoot);
  const status = adapter.prCheckStatus(repoId, "quay/branch");
  expect(status.state).toBe("fail");
});

test("prCheckStatus returns pass on a repo with no checks at all", () => {
  // The "no checks reported on this PR" branch: gh emits an empty array on
  // the unfiltered call, and a "no checks" hint on the required call. With
  // an empty unfiltered set is the no-CI fallback.
  installGhStub(`
case "$*" in
  *"checks"*"--required"*)
    echo 'no checks reported on this branch' 1>&2
    exit 1
    ;;
  *"checks"*)
    echo 'no checks reported on this branch' 1>&2
    exit 1
    ;;
  *"view"*)
    echo '{"state":"OPEN","headRefOid":"abc","baseRefOid":"def","mergeable":"MERGEABLE","reviewDecision":"NONE","latestReviews":[]}'
    exit 0
    ;;
  *)
    echo '[]'
    exit 0
    ;;
esac
`);
  const { reposRoot, repoId } = makeBareDir();
  const adapter = new GitHubCliAdapter(reposRoot);
  const status = adapter.prCheckStatus(repoId, "quay/branch");
  expect(status.state).toBe("pass");
});
