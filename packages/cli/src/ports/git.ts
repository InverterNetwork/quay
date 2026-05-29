// Git operations used by core services. Real implementation lives under
// src/adapters/.
export interface GitPort {
  bareCloneExists(repoId: string): boolean;
  fetch(repoId: string, ref: string): void;
  // Like `fetch`, but tolerates "remote ref does not exist" — the natural case
  // for newly-enqueued tasks whose `quay/<slug>` branch hasn't been pushed
  // yet, and for spawn-window recoveries where the worker died before push.
  // Other failures (network, permissions, malformed args) still throw so
  // genuine breakage surfaces as a tick error.
  fetchBranchIfExists(repoId: string, branch: string): void;
  hasLocalBranch(repoId: string, branch: string): boolean;
  hasRemoteBranch(repoId: string, branch: string): boolean;
  hasOpenPullRequestForBranch(repoId: string, branch: string): boolean;
  ensureRemoteBranchFromBase(
    repoId: string,
    branch: string,
    baseBranch: string,
  ): void;
  worktreeAdd(
    repoId: string,
    worktreePath: string,
    branch: string,
    baseRef: string,
  ): void;
  worktreeAddExistingBranch(
    repoId: string,
    worktreePath: string,
    branch: string,
    baseRef: string,
  ): void;
  checkoutPullRequest(
    repoId: string,
    worktreePath: string,
    prNumber: number,
    headSha: string,
  ): void;
  worktreeCurrentBranch(worktreePath: string): string | null;
  worktreeDetach(worktreePath: string): void;
  worktreeRemove(worktreePath: string): void;
  branchDelete(repoId: string, branch: string): void;
  // Returns the SHA at origin/<branch> in the bare clone after a fetch, or null
  // if the remote ref does not exist.
  remoteHeadSha(repoId: string, branch: string): string | null;
  // Best-effort lines-changed summary between two commits in the bare clone.
  // Returns null if git fails for any reason (SHA missing locally, fetch
  // race, etc) so the caller can leave `attempts.diff_summary` NULL and
  // emit a tick_error event. Never throws.
  diffSummary(
    repoId: string,
    baseSha: string,
    headSha: string,
  ): DiffSummary | null;
  // Idempotent `git push origin --delete <branch>`. Real adapter tolerates
  // "remote ref does not exist" and any other non-fatal error.
  deleteRemoteBranch(repoId: string, branch: string): void;
  // Final defense-in-depth gate after the JS slug normalizer (spec §13):
  // returns the input slug if `git check-ref-format refs/heads/quay/<slug>`
  // accepts it, otherwise returns `task-<taskIdShort>`.
  safeBranchSlug(slug: string, taskIdShort: string): string;
}

export interface DiffSummaryFile {
  // Full new path. Renames are split into delete+add (we pass --no-renames
  // so numstat and name-status agree on a single canonical path per file).
  path: string;
  // Single-letter `git diff --name-status` code: M, A, D, T, etc. The
  // first character only — the percentage suffix on R/C is stripped, but
  // we don't actually expect those because of --no-renames.
  status: string;
  // Lines added / removed. NULL for binary files (numstat shows `-`).
  ins: number | null;
  del: number | null;
}

export interface DiffSummary {
  files_changed: number;
  insertions: number;
  deletions: number;
  files: DiffSummaryFile[];
  // Set to true (and only emitted as true; absent when not truncated) when
  // `files[]` was capped because the underlying diff exceeded the per-file
  // array limit. `files_changed` and the line-count totals always reflect
  // the full diff — only the per-file array is partial.
  truncated?: true;
}
