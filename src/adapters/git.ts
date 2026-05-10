// Real Git adapter. Implements GitPort using local git against a configurable
// bare-clone root (`<reposRoot>/<repo_id>.git`). All shell-out calls go
// through `Bun.spawnSync`; none of them invoke a shell, so repo ids and branch
// names cannot smuggle metacharacters into the command line.
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DiffSummary, DiffSummaryFile, GitPort } from "../ports/git.ts";

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// Per-file array cap on diff_summary capture. A monorepo PR touching
// thousands of files would otherwise persist a multi-megabyte JSON blob
// inline on the attempts row. 200 keeps the column compact for the
// common case while still showing the head of the path list for
// inspection. Aggregates (files_changed, insertions, deletions) are
// computed before truncation and reflect the full diff.
const MAX_DIFF_FILES = 200;

export class LocalGitAdapter implements GitPort {
  constructor(private readonly reposRoot: string) {}

  // Defense-in-depth: even though the JS slug normalizer already filters bad
  // characters, the adapter runs `git check-ref-format` as a final gate before
  // any branch op. If the slug fails the gate, fall back to `task-<id>`.
  safeBranchSlug(slug: string, taskIdShort: string): string {
    const fallback = `task-${taskIdShort}`;
    if (slug === "") return fallback;
    const probe = run(["git", "check-ref-format", `refs/heads/quay/${slug}`]);
    return probe.exitCode === 0 ? slug : fallback;
  }

  bareCloneExists(repoId: string): boolean {
    const dir = this.bareDir(repoId);
    return existsSync(dir) && existsSync(join(dir, "HEAD"));
  }

  fetch(repoId: string, ref: string): void {
    // Use an explicit `<src>:<dst>` refspec so this works regardless of
    // whether `remote.origin.fetch` is configured on the bare clone. A
    // vanilla `git clone --bare` does NOT set that config by default, so
    // `git fetch origin <ref>` would only update FETCH_HEAD and never
    // populate `refs/remotes/origin/<ref>` — which the worktree-add path
    // needs. The explicit form bypasses the config entirely. The leading
    // `+` allows non-fast-forward updates to the remote-tracking ref, the
    // same semantics the canonical `+refs/heads/*:refs/remotes/origin/*`
    // refspec would provide.
    const refspec = `+${ref}:refs/remotes/origin/${ref}`;
    const result = runIn(this.bareDir(repoId), [
      "git",
      "fetch",
      "origin",
      refspec,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        `git fetch origin ${ref} failed for ${repoId}: ${result.stderr.trim()}`,
      );
    }
  }

  fetchBranchIfExists(repoId: string, branch: string): void {
    // Tolerant counterpart of `fetch` for refs that may not yet exist on
    // origin. Git's stderr for that case is "couldn't find remote ref
    // refs/heads/<branch>"; we match the stable substring and treat as a
    // no-op so the caller's downstream `remoteHeadSha` returns null and
    // the spawn/classify flow records that as "no remote progress" rather
    // than blowing up with a tick error. Anything else (network, auth,
    // malformed args) still throws.
    //
    // Same explicit `<src>:<dst>` refspec as `fetch` for the same reason —
    // works on a clone without `remote.origin.fetch` configured.
    const refspec = `+${branch}:refs/remotes/origin/${branch}`;
    const result = runIn(this.bareDir(repoId), [
      "git",
      "fetch",
      "origin",
      refspec,
    ]);
    if (result.exitCode === 0) return;
    if (result.stderr.toLowerCase().includes("couldn't find remote ref")) {
      return;
    }
    throw new Error(
      `git fetch origin ${branch} failed for ${repoId}: ${result.stderr.trim()}`,
    );
  }

  hasLocalBranch(repoId: string, branch: string): boolean {
    const result = runIn(this.bareDir(repoId), [
      "git",
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    return result.exitCode === 0;
  }

  hasRemoteBranch(repoId: string, branch: string): boolean {
    // `git ls-remote --exit-code origin refs/heads/<branch>` returns 0 if the
    // ref exists on origin, 2 if it doesn't, anything else is a real error.
    const result = runIn(this.bareDir(repoId), [
      "git",
      "ls-remote",
      "--exit-code",
      "origin",
      `refs/heads/${branch}`,
    ]);
    if (result.exitCode === 0) return true;
    if (result.exitCode === 2) return false;
    throw new Error(
      `git ls-remote failed for ${repoId} ${branch}: ${result.stderr.trim()}`,
    );
  }

  hasOpenPullRequestForBranch(repoId: string, branch: string): boolean {
    // Spec §12 collision check, third leg: `gh pr list --head <branch>
    // --state open` returns non-empty iff the branch already has an open PR
    // attached. This catches the "remote branch deleted on merge but PR
    // closed_unmerged" cases — local + remote checks alone would miss it.
    //
    // Two correctness invariants:
    //   1. `gh` must be invoked from inside the bare clone for THIS repo so
    //      it infers the upstream from `origin`. Without `cwd`, `gh` runs
    //      against whatever repo the operator's shell happens to be in (or
    //      none), and the collision check silently inspects the wrong
    //      project — letting enqueue reuse a branch that has an open PR on
    //      the actual target repo.
    //   2. Hard `gh` failures must surface, not get swallowed into "no open
    //      PR." Failing open here defeats the whole point of the collision
    //      check: a transient API error or auth misconfig would let enqueue
    //      reuse an open-PR branch on every retry. The exception is the
    //      legitimate "no PRs at all" gh response (exit 0 with empty array)
    //      and the spawn-not-found case (operator has not installed gh —
    //      caught by the ENOENT branch below; treated as "skip the third
    //      leg" since the spec's collision check is impossible without gh).
    const dir = this.bareDir(repoId);
    const result = runIn(dir, [
      "gh",
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "number",
    ]);
    if (result.exitCode === 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch (err) {
        throw new Error(
          `gh pr list returned unparseable JSON for ${branch}: ${(err as Error).message}`,
        );
      }
      // Fail closed on non-array bodies. The `--json number` contract is an
      // array; anything else (object, null, scalar) is a CLI/schema anomaly,
      // and coercing it to "no open PR" would silently bypass the spec §12
      // collision check on every retry — exactly the regression invariant 2
      // above guards against.
      if (!Array.isArray(parsed)) {
        throw new Error(
          `gh pr list returned non-array JSON for ${repoId} ${branch}: ${result.stdout.trim().slice(0, 200)}`,
        );
      }
      return parsed.length > 0;
    }
    // `Bun.spawnSync` reports a missing executable either by throwing
    // ENOENT (caught in `runIn` and forwarded as exitCode -1) or, on some
    // platforms, by returning exit code 127. Both indicate "gh isn't on
    // PATH" — operator hasn't wired the GitHub CLI, the spec's third leg
    // is structurally unavailable, and we degrade gracefully to "no open
    // PR" so the local + remote legs still gate the enqueue.
    const stderrLower = result.stderr.toLowerCase();
    const ghMissing =
      result.exitCode === -1 ||
      result.exitCode === 127 ||
      stderrLower.includes("command not found") ||
      stderrLower.includes("no such file or directory");
    if (ghMissing) return false;
    // Anything else (auth failure, rate limit, network blip, malformed
    // args, repo-not-recognized) is a hard failure. Fail closed so the
    // collision check isn't silently skipped.
    throw new Error(
      `gh pr list --head ${branch} failed for ${repoId} (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }

  worktreeAdd(
    repoId: string,
    worktreePath: string,
    branch: string,
    baseRef: string,
  ): void {
    const result = runIn(this.bareDir(repoId), [
      "git",
      "worktree",
      "add",
      "-b",
      branch,
      worktreePath,
      baseRef,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(
        `git worktree add ${branch} ${worktreePath} failed: ${result.stderr.trim()}`,
      );
    }
  }

  worktreeDetach(worktreePath: string): void {
    // Severs the bare clone's tracking of this worktree WITHOUT deleting the
    // directory contents — this is what `quay cancel --keep-worktree`
    // relies on. `git worktree remove --force` always deletes; the manual
    // recipe is to drop the gitfile (`<worktree>/.git`) and the matching
    // admin directory inside the bare clone (`<bare>/worktrees/<name>`).
    // Once both are gone, the bare clone no longer thinks the branch is
    // checked out, so `git branch -D` succeeds; the worktree directory is
    // left as a pile of plain files for the operator.
    //
    // Security: the gitfile is *inside the worker's worktree*, so a worker
    // can rewrite it to point anywhere on disk. Two layered defenses:
    //
    //   1. Shape check: refuse any admin path that doesn't resolve to the
    //      canonical `<reposRoot>/<repo_id>.git/worktrees/<name>` layout
    //      (catches escapes outside reposRoot).
    //   2. Backlink check: even when the path SHAPE is legitimate, the
    //      admin dir's `gitdir` backlink must canonically resolve to THIS
    //      worktree's `.git` (catches cross-task aliasing — task A
    //      rewriting its own `.git` to point at task B's admin dir under
    //      the same reposRoot would otherwise pass the shape check and
    //      get task B's admin recursively wiped on the operator's
    //      `cancel --keep-worktree`).
    if (!existsSync(worktreePath)) return;
    const gitfile = join(worktreePath, ".git");
    // Canonicalize the gitfile path BEFORE we remove it, so the backlink
    // check below can compare against a stable identity even if a future
    // refactor moves the rmSync earlier.
    const expectedBacklink = canonical(gitfile);
    let adminDirRaw: string | null = null;
    try {
      const contents = readFileSync(gitfile, "utf8");
      const m = contents.match(/^gitdir:\s*(.+)$/m);
      if (m && m[1]) adminDirRaw = m[1].trim();
    } catch {
      // No .git pointer — already detached, treat as a no-op.
    }
    // Decide what (if anything) to delete BEFORE the gitfile rm so the
    // two checks operate on a consistent snapshot of on-disk state.
    let adminToDelete: string | null = null;
    if (adminDirRaw !== null) {
      // Resolve symlinks on both sides before comparison: macOS routes
      // `/var/folders/...` → `/private/var/folders/...`, and git's gitfile
      // emits the resolved path. A literal-prefix check on unresolved paths
      // would reject every legitimate temp-dir layout.
      const root = canonical(this.reposRoot);
      const adminAbs = canonical(adminDirRaw);
      // Allowed shape: `<reposRoot>/<repo_id>.git/worktrees/<name>`. The
      // first segment under reposRoot must end in `.git`, the second must
      // be exactly `worktrees`, and there must be a non-empty third
      // segment. Anything else (a bare-root delete, an escape via `..`, a
      // symlink target outside reposRoot) is refused. We also re-check
      // `<repo_id>.git`'s charset against the same identifier rules
      // bareDir() enforces.
      if (adminAbs.startsWith(`${root}/`)) {
        const rel = adminAbs.slice(root.length + 1);
        const segs = rel.split("/");
        const repoSeg = segs[0] ?? "";
        const shapeOk =
          segs.length >= 3 &&
          segs[1] === "worktrees" &&
          segs[2] !== "" &&
          segs[2] !== "." &&
          segs[2] !== ".." &&
          repoSeg.endsWith(".git") &&
          /^[A-Za-z0-9._-]+\.git$/.test(repoSeg);
        // Backlink check: layered defense against cross-task aliasing.
        // See the security comment at the top of worktreeDetach.
        if (shapeOk && adminBacklinksTo(adminAbs, expectedBacklink)) {
          adminToDelete = adminAbs;
        }
        // else: shape mismatch OR backlink mismatch — leave the admin
        // alone. The next bare-clone op will lazily prune dangling admin
        // entries.
      }
    }
    try {
      rmSync(gitfile, { force: true });
    } catch {}
    if (adminToDelete !== null) {
      try {
        rmSync(adminToDelete, { recursive: true, force: true });
      } catch {}
    }
  }

  worktreeRemove(worktreePath: string): void {
    if (!existsSync(worktreePath)) return;
    // `git worktree remove --force` requires running from inside the
    // bare-clone (or any repo with a worktree list); we don't always know the
    // repoId here, so we use `--force` and rely on the worktree list inside
    // the path's parent .git/worktrees pointer. The simpler portable form is
    // `git -C <worktreePath> worktree remove --force <worktreePath>` which
    // works because `-C` chooses cwd and the worktree's own .git points at
    // the bare clone.
    const removed = runIn(worktreePath, [
      "git",
      "worktree",
      "remove",
      "--force",
      worktreePath,
    ]);
    if (removed.exitCode !== 0) {
      // Best-effort: if `git worktree remove` failed (e.g., already
      // detached), drop the directory directly. Spec §5 explicitly tolerates
      // worktree cleanup failures during terminal transitions.
      try {
        rmSync(worktreePath, { recursive: true, force: true });
      } catch {}
    }
  }

  branchDelete(repoId: string, branch: string): void {
    const result = runIn(this.bareDir(repoId), [
      "git",
      "branch",
      "-D",
      branch,
    ]);
    // `git branch -D` against a non-existent branch returns non-zero; that's
    // not a programmer error in our cleanup paths, so swallow it. Real
    // failures (permissions, FS error) only surface as logged tick errors.
    if (result.exitCode !== 0) {
      const msg = result.stderr.toLowerCase();
      if (!msg.includes("not found") && !msg.includes("no such")) {
        // Surfacing other errors helps debug worktree corruption per spec §5.
        throw new Error(
          `git branch -D ${branch} failed for ${repoId}: ${result.stderr.trim()}`,
        );
      }
    }
  }

  remoteHeadSha(repoId: string, branch: string): string | null {
    const result = runIn(this.bareDir(repoId), [
      "git",
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/remotes/origin/${branch}`,
    ]);
    if (result.exitCode !== 0) return null;
    const sha = result.stdout.trim();
    return sha.length > 0 ? sha : null;
  }

  deleteRemoteBranch(repoId: string, branch: string): void {
    // Idempotent: tolerate "remote ref does not exist" and any other
    // non-fatal failure per spec §5.
    runIn(this.bareDir(repoId), [
      "git",
      "push",
      "origin",
      "--delete",
      branch,
    ]);
  }

  diffSummary(
    repoId: string,
    baseSha: string,
    headSha: string,
  ): DiffSummary | null {
    // --no-renames so numstat and name-status agree on paths: a renamed
    // file shows as a delete + add in both, instead of name-status
    // emitting "Rxx old new" while numstat collapses it onto one line
    // with a "{old => new}" path. v1 doesn't try to reunify renames; the
    // delete+add split is good enough for the lines-changed query usecase.
    //
    // -c core.quotePath=false keeps non-ASCII filenames literal — without
    // it git emits octal-escaped quoted strings like "caf\303\251.txt"
    // and downstream consumers can't index by the actual on-disk path.
    //
    // Three-dot range (`A...B`) so the diff is computed from the merge-base
    // of A and B rather than from A itself. For the respawn case (A is the
    // prior remote head, an ancestor of B) the merge-base is A, so this is
    // identical to two-dot. For the first-push case where A is the base
    // branch tip and the worker may not have rebased onto the latest base,
    // three-dot still produces a clean PR-shaped diff — two-dot would
    // surface base-only commits as deletions, which is wrong.
    const range = `${baseSha}...${headSha}`;
    const numstatRes = runIn(this.bareDir(repoId), [
      "git",
      "-c",
      "core.quotePath=false",
      "diff",
      "--no-renames",
      "--numstat",
      range,
    ]);
    if (numstatRes.exitCode !== 0) return null;
    const nameStatusRes = runIn(this.bareDir(repoId), [
      "git",
      "-c",
      "core.quotePath=false",
      "diff",
      "--no-renames",
      "--name-status",
      range,
    ]);
    if (nameStatusRes.exitCode !== 0) return null;

    const statusByPath = new Map<string, string>();
    for (const line of nameStatusRes.stdout.split("\n")) {
      if (line === "") continue;
      const cols = line.split("\t");
      if (cols.length < 2) continue;
      const status = cols[0]!.charAt(0);
      const path = cols[cols.length - 1]!;
      statusByPath.set(path, status);
    }

    const files: DiffSummaryFile[] = [];
    let insertions = 0;
    let deletions = 0;
    for (const line of numstatRes.stdout.split("\n")) {
      if (line === "") continue;
      const cols = line.split("\t");
      if (cols.length < 3) continue;
      const insCol = cols[0]!;
      const delCol = cols[1]!;
      const path = cols.slice(2).join("\t");
      const ins = insCol === "-" ? null : parseInt(insCol, 10);
      const del = delCol === "-" ? null : parseInt(delCol, 10);
      if (ins !== null && Number.isFinite(ins)) insertions += ins;
      if (del !== null && Number.isFinite(del)) deletions += del;
      files.push({
        path,
        status: statusByPath.get(path) ?? "M",
        ins: ins !== null && Number.isFinite(ins) ? ins : null,
        del: del !== null && Number.isFinite(del) ? del : null,
      });
    }

    // Truncate the per-file array on monorepo-scale diffs to keep the
    // attempts row compact (TEXT column read on every list query).
    // Aggregates are computed BEFORE truncation so they remain accurate;
    // the truncation marker tells consumers the array is partial. The
    // first MAX_DIFF_FILES entries are kept — the order matches git's
    // output, which is alphabetical-ish; for a monorepo touch the head
    // is as useful as any other slice and avoids needing to score files.
    const totalFilesChanged = files.length;
    let truncated = false;
    let kept = files;
    if (files.length > MAX_DIFF_FILES) {
      kept = files.slice(0, MAX_DIFF_FILES);
      truncated = true;
    }
    return {
      files_changed: totalFilesChanged,
      insertions,
      deletions,
      files: kept,
      ...(truncated ? { truncated: true } : {}),
    };
  }

  private bareDir(repoId: string): string {
    // Defense-in-depth: the schema (`src/core/repos/schema.ts`) already
    // restricts `repo_id` to a safe identifier charset, but the adapter is
    // the last hop before a real `rm`/`git clone` runs against the path, so
    // it re-checks here. Any `repo_id` containing path separators or
    // resolving outside `reposRoot` is refused — making traversal a hard
    // error rather than a silent escape if a future code path skips the
    // schema.
    if (!/^[A-Za-z0-9._-]+$/.test(repoId) || repoId === "." || repoId === "..") {
      throw new Error(`repo_id "${repoId}" is not a safe identifier`);
    }
    const root = resolve(this.reposRoot);
    const dir = resolve(this.reposRoot, `${repoId}.git`);
    if (!dir.startsWith(`${root}/`) && dir !== root) {
      throw new Error(
        `repo_id "${repoId}" escapes reposRoot (${root}); refusing to operate`,
      );
    }
    return dir;
  }
}

function run(cmd: string[]): RunResult {
  // Mirror runIn's spawn-error handling so callers can distinguish
  // "missing binary" from "binary returned non-zero" by checking for
  // exitCode === -1. `env: process.env` for the same PATH-snapshot reason
  // documented on `runIn`.
  let result;
  try {
    result = Bun.spawnSync({
      cmd,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: (err as Error).message ?? String(err),
    };
  }
  return {
    exitCode: result.exitCode ?? 0,
    stdout: decode(result.stdout),
    stderr: decode(result.stderr),
  };
}

function runIn(cwd: string, cmd: string[]): RunResult {
  // If the executable is missing, `Bun.spawnSync` throws `ENOENT` rather
  // than returning a non-zero exit. Adapter code that needs to distinguish
  // "gh not installed" from "gh ran and returned non-zero" relies on
  // `exitCode === -1`, so map any spawn error into that sentinel.
  //
  // `env: process.env` is forwarded explicitly because Bun snapshots PATH
  // at process startup unless a caller passes `env`. Without it, a test
  // that prepends a shim directory to `process.env.PATH` would be silently
  // ignored — the real binary on the original PATH would still resolve.
  let result;
  try {
    result = Bun.spawnSync({
      cmd,
      cwd,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: (err as Error).message ?? String(err),
    };
  }
  return {
    exitCode: result.exitCode ?? 0,
    stdout: decode(result.stdout),
    stderr: decode(result.stderr),
  };
}

function decode(buf: Buffer | Uint8Array | undefined): string {
  if (!buf) return "";
  return new TextDecoder().decode(buf);
}

// Resolve symlinks where they exist; otherwise fall back to the literal
// resolved path. We accept the no-such-path case because the containment
// check is also called against admin dirs that may already have been
// pruned. A non-existent path simply fails the prefix check.
function canonical(p: string): string {
  try {
    return realpathSync(resolve(p));
  } catch {
    return resolve(p);
  }
}

// Verifies the admin dir's `gitdir` backlink resolves to `expectedBacklink`
// (the canonical path of THIS worktree's .git). Git stores the backlink as
// the absolute path to the linked worktree's .git file; if the values
// don't match (or the file is missing / unreadable), the admin dir does
// NOT belong to this worktree and must not be deleted. This is the layer
// that defeats cross-task admin-dir aliasing — see the security comment
// in worktreeDetach.
function adminBacklinksTo(adminAbs: string, expectedBacklink: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(join(adminAbs, "gitdir"), "utf8").trim();
  } catch {
    return false;
  }
  if (raw === "") return false;
  return canonical(raw) === expectedBacklink;
}
