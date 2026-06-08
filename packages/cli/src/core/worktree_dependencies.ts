import type { DB } from "../db/connection.ts";
import type { CommandRunner } from "../ports/command_runner.ts";
import { QuayError } from "./errors.ts";

export interface WorktreeDependencyRepo {
  repo_id: string;
  install_cmd: string;
}

export function loadWorktreeDependencyRepo(
  db: DB,
  repoId: string,
): WorktreeDependencyRepo {
  const row = db
    .query<WorktreeDependencyRepo, [string]>(
      `SELECT repo_id, install_cmd FROM repos WHERE repo_id = ?`,
    )
    .get(repoId);
  if (!row) {
    throw new QuayError("unknown_repo", `repo "${repoId}" not found`, {
      repo_id: repoId,
    });
  }
  return row;
}

export function installWorktreeDependencies(
  commandRunner: CommandRunner,
  repo: WorktreeDependencyRepo,
  worktreePath: string,
): void {
  const installResult = commandRunner.run(repo.install_cmd, {
    cwd: worktreePath,
  });
  if (installResult.exitCode !== 0) {
    throw new QuayError(
      "bootstrap_failed",
      `install_cmd failed for repo "${repo.repo_id}" in ${worktreePath} (exit ${installResult.exitCode}): ${installResult.stderr.trim()}`,
      {
        step: "install",
        repo_id: repo.repo_id,
        worktree_path: worktreePath,
        exit_code: installResult.exitCode,
        stderr: installResult.stderr,
      },
    );
  }
}
