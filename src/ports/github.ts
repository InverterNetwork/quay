// Slice 3 GitHubPort. Real implementation lives under src/adapters/ in slice 10.
//
// Only the read used at promotion time is exposed here — `gh pr view <branch>`
// to snapshot whether a PR already exists for the branch (open or closed/merged).
// Returns true iff `gh pr view` would exit 0.
export interface GitHubPort {
  prExistsForBranch(repoId: string, branch: string): boolean;
}
