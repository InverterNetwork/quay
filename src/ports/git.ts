// Slice 2 GitPort. Real implementation lives under src/adapters/ in slice 10.
// Only the methods enqueue needs are listed here.
export interface GitPort {
  bareCloneExists(repoId: string): boolean;
  cloneBare(repoId: string, repoUrl: string): void;
  fetch(repoId: string, ref: string): void;
  hasLocalBranch(repoId: string, branch: string): boolean;
  hasRemoteBranch(repoId: string, branch: string): boolean;
  hasOpenPullRequestForBranch(repoId: string, branch: string): boolean;
  worktreeAdd(
    repoId: string,
    worktreePath: string,
    branch: string,
    baseRef: string,
  ): void;
  worktreeRemove(worktreePath: string): void;
  branchDelete(repoId: string, branch: string): void;
  removeBareClone(repoId: string): void;
}
