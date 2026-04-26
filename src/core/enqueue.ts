import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";
import { QuayError } from "./errors.ts";

export interface EnqueueDeps {
  db: DB;
  clock: Clock;
}

export interface EnqueueInput {
  repo_id: string;
}

/**
 * Slice 1 stub: only the archived-repo guard is implemented. The full
 * bootstrap (clone/fetch/install/worktree, task row, attempt #1, artifacts)
 * is owned by Slice 2 and will replace this body.
 */
export function enqueue(deps: EnqueueDeps, input: EnqueueInput): never {
  const row = deps.db
    .query<{ archived_at: string | null }, [string]>(
      "SELECT archived_at FROM repos WHERE repo_id = ?",
    )
    .get(input.repo_id);

  if (!row) {
    throw new QuayError("unknown_repo", `repo "${input.repo_id}" not found`, {
      repo_id: input.repo_id,
    });
  }
  if (row.archived_at !== null) {
    throw new QuayError(
      "repo_archived",
      `repo "${input.repo_id}" is archived; new tasks are rejected`,
      { repo_id: input.repo_id },
    );
  }

  throw new QuayError(
    "validation_error",
    "enqueue is not implemented in slice 1; see slice 2",
  );
}
