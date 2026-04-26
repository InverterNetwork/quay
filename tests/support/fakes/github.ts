import type { GitHubPort } from "../../../src/ports/github.ts";

export class FakeGitHub implements GitHubPort {
  readonly calls: { repoId: string; branch: string }[] = [];
  readonly prExisting = new Map<string, boolean>(); // key = `${repoId}\0${branch}`

  prExistsForBranch(repoId: string, branch: string): boolean {
    this.calls.push({ repoId, branch });
    return this.prExisting.get(`${repoId}\0${branch}`) ?? false;
  }

  setPrExists(repoId: string, branch: string, exists: boolean): void {
    this.prExisting.set(`${repoId}\0${branch}`, exists);
  }
}
