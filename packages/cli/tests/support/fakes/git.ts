import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isValidGitRef } from "../../../src/core/branch_slug.ts";
import type { DiffSummary, GitPort } from "../../../src/ports/git.ts";

export interface FakeGitCall {
  op: string;
  args: Record<string, unknown>;
}

export interface FakeGitFailures {
  fetch?: (repoId: string, ref: string) => boolean;
  fetchBranchIfExists?: (repoId: string, branch: string) => boolean;
  worktreeAdd?: (worktreePath: string) => boolean;
  worktreeDetach?: (worktreePath: string) => boolean;
  branchDelete?: (branch: string) => boolean;
  worktreeRemove?: (worktreePath: string) => boolean;
}

export class FakeGit implements GitPort {
  readonly calls: FakeGitCall[] = [];
  readonly bareClones = new Set<string>();
  readonly localBranches = new Map<string, Set<string>>();
  readonly remoteBranches = new Map<string, Set<string>>();
  readonly openPrBranches = new Map<string, Set<string>>();
  readonly remoteHeads = new Map<string, string>(); // key = `${repoId}\0${branch}`
  readonly diffSummaries = new Map<string, DiffSummary>(); // key = `${repoId}\0${base}\0${head}`
  readonly worktrees = new Set<string>();
  readonly worktreeBranches = new Map<string, { repoId: string; branch: string }>();
  readonly reposRoot: string;
  fail: FakeGitFailures = {};

  constructor(reposRoot: string) {
    this.reposRoot = reposRoot;
  }

  private record(op: string, args: Record<string, unknown>): void {
    this.calls.push({ op, args });
  }

  private bareDir(repoId: string): string {
    return join(this.reposRoot, `${repoId}.git`);
  }

  bareCloneExists(repoId: string): boolean {
    // Mirror the real adapter: both the in-memory record AND a HEAD file must
    // exist. This ensures an empty directory at the expected path routes through
    // the bare_clone_missing error path, matching production behavior.
    return this.bareClones.has(repoId) && existsSync(join(this.bareDir(repoId), "HEAD"));
  }

  fetch(repoId: string, ref: string): void {
    this.record("fetch", { repoId, ref });
    if (this.fail.fetch?.(repoId, ref)) {
      throw new Error(`fake: fetch failed for ${repoId} ${ref}`);
    }
  }

  fetchBranchIfExists(repoId: string, branch: string): void {
    // No-op by default: the fake has no real "remote ref exists" state, and
    // `remoteHeadSha` is independently seeded via `setRemoteHeadSha`. Tests
    // exercising "fetch genuinely failed (network / auth)" can opt in via
    // `fail.fetchBranchIfExists`.
    this.record("fetchBranchIfExists", { repoId, branch });
    if (this.fail.fetchBranchIfExists?.(repoId, branch)) {
      throw new Error(
        `fake: fetchBranchIfExists failed for ${repoId} ${branch}`,
      );
    }
  }

  hasLocalBranch(repoId: string, branch: string): boolean {
    this.record("hasLocalBranch", { repoId, branch });
    return this.localBranches.get(repoId)?.has(branch) ?? false;
  }

  hasRemoteBranch(repoId: string, branch: string): boolean {
    this.record("hasRemoteBranch", { repoId, branch });
    return this.remoteBranches.get(repoId)?.has(branch) ?? false;
  }

  hasOpenPullRequestForBranch(repoId: string, branch: string): boolean {
    this.record("hasOpenPullRequestForBranch", { repoId, branch });
    return this.openPrBranches.get(repoId)?.has(branch) ?? false;
  }

  worktreeAdd(
    repoId: string,
    worktreePath: string,
    branch: string,
    baseRef: string,
  ): void {
    this.record("worktreeAdd", { repoId, worktreePath, branch, baseRef });
    if (this.fail.worktreeAdd?.(worktreePath)) {
      throw new Error(`fake: worktreeAdd failed for ${worktreePath}`);
    }
    mkdirSync(worktreePath, { recursive: true });
    this.worktrees.add(worktreePath);
    let set = this.localBranches.get(repoId);
    if (!set) {
      set = new Set<string>();
      this.localBranches.set(repoId, set);
    }
    set.add(branch);
    this.worktreeBranches.set(worktreePath, { repoId, branch });
  }

  worktreeAddExistingBranch(
    repoId: string,
    worktreePath: string,
    branch: string,
    baseRef: string,
  ): void {
    this.record("worktreeAddExistingBranch", {
      repoId,
      worktreePath,
      branch,
      baseRef,
    });
    if (this.fail.worktreeAdd?.(worktreePath)) {
      throw new Error(`fake: worktreeAddExistingBranch failed for ${worktreePath}`);
    }
    mkdirSync(worktreePath, { recursive: true });
    this.worktrees.add(worktreePath);
    let set = this.localBranches.get(repoId);
    if (!set) {
      set = new Set<string>();
      this.localBranches.set(repoId, set);
    }
    set.add(branch);
    this.worktreeBranches.set(worktreePath, { repoId, branch });
  }

  checkoutPullRequest(
    repoId: string,
    worktreePath: string,
    prNumber: number,
    headSha: string,
  ): void {
    this.record("checkoutPullRequest", { repoId, worktreePath, prNumber, headSha });
    mkdirSync(worktreePath, { recursive: true });
    this.worktrees.add(worktreePath);
    this.worktreeBranches.set(worktreePath, {
      repoId,
      branch: `pr/${prNumber}@${headSha}`,
    });
  }

  worktreeDetach(worktreePath: string): void {
    this.record("worktreeDetach", { worktreePath });
    if (this.fail.worktreeDetach?.(worktreePath)) {
      throw new Error(`fake: worktreeDetach failed for ${worktreePath}`);
    }
    this.worktreeBranches.delete(worktreePath);
  }

  worktreeRemove(worktreePath: string): void {
    this.record("worktreeRemove", { worktreePath });
    if (this.fail.worktreeRemove?.(worktreePath)) {
      throw new Error(`fake: worktreeRemove failed for ${worktreePath}`);
    }
    rmSync(worktreePath, { recursive: true, force: true });
    this.worktrees.delete(worktreePath);
    this.worktreeBranches.delete(worktreePath);
  }

  branchDelete(repoId: string, branch: string): void {
    this.record("branchDelete", { repoId, branch });
    if (this.fail.branchDelete?.(branch)) {
      throw new Error(`fake: branchDelete failed for ${branch}`);
    }
    for (const checkout of this.worktreeBranches.values()) {
      if (checkout.repoId === repoId && checkout.branch === branch) {
        throw new Error(`fake: branch ${branch} is checked out in a worktree`);
      }
    }
    this.localBranches.get(repoId)?.delete(branch);
  }

  deleteRemoteBranch(repoId: string, branch: string): void {
    this.record("deleteRemoteBranch", { repoId, branch });
    // Idempotent — missing remote ref is not an error.
    this.remoteBranches.get(repoId)?.delete(branch);
  }

  remoteHeadSha(repoId: string, branch: string): string | null {
    this.record("remoteHeadSha", { repoId, branch });
    return this.remoteHeads.get(`${repoId}\0${branch}`) ?? null;
  }

  diffSummary(
    repoId: string,
    baseSha: string,
    headSha: string,
  ): DiffSummary | null {
    this.record("diffSummary", { repoId, baseSha, headSha });
    return this.diffSummaries.get(`${repoId}\0${baseSha}\0${headSha}`) ?? null;
  }

  setDiffSummary(
    repoId: string,
    baseSha: string,
    headSha: string,
    summary: DiffSummary | null,
  ): void {
    const key = `${repoId}\0${baseSha}\0${headSha}`;
    if (summary === null) {
      this.diffSummaries.delete(key);
    } else {
      this.diffSummaries.set(key, summary);
    }
  }

  setRemoteHeadSha(repoId: string, branch: string, sha: string | null): void {
    const key = `${repoId}\0${branch}`;
    if (sha === null) {
      this.remoteHeads.delete(key);
    } else {
      this.remoteHeads.set(key, sha);
    }
  }

  // Helpers for test setup.
  setLocalBranches(repoId: string, branches: string[]): void {
    this.localBranches.set(repoId, new Set(branches));
  }
  setRemoteBranches(repoId: string, branches: string[]): void {
    this.remoteBranches.set(repoId, new Set(branches));
  }
  setWorktreeBranch(repoId: string, worktreePath: string, branch: string): void {
    mkdirSync(worktreePath, { recursive: true });
    this.worktrees.add(worktreePath);
    this.worktreeBranches.set(worktreePath, { repoId, branch });
  }
  setOpenPrBranches(repoId: string, branches: string[]): void {
    this.openPrBranches.set(repoId, new Set(branches));
  }
  seedBareClone(repoId: string): void {
    const dir = this.bareDir(repoId);
    mkdirSync(dir, { recursive: true });
    // Touch a HEAD file to mirror the real adapter's tightened bareCloneExists
    // check: an empty directory at the path is not a valid bare clone.
    writeFileSync(join(dir, "HEAD"), "ref: refs/heads/main\n");
    this.bareClones.add(repoId);
  }
  countCalls(op: string): number {
    return this.calls.filter((c) => c.op === op).length;
  }

  // Mirrors the real adapter's `git check-ref-format` gate: tests use the JS
  // validator so the contract stays decoupled from a tmpdir-based git probe.
  safeBranchSlug(slug: string, taskIdShort: string): string {
    this.record("safeBranchSlug", { slug, taskIdShort });
    if (slug === "" || !isValidGitRef(`quay/${slug}`)) {
      return `task-${taskIdShort}`;
    }
    return slug;
  }
}
