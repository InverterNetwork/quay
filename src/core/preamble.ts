import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";

export const DEFAULT_PREAMBLE_BODY = `Quay protocol preamble (v1)

1. If you cannot make progress, write .quay-blocked.md containing prose explaining what happened, then exit cleanly.
2. Exit when (a) you have opened a PR, (b) you have written a blocker file, or (c) you have decided you cannot complete the task. Do not loop indefinitely. Do not sleep waiting for input.
3. Work inside the worktree. .quay-* files are reserved; you may write .quay-blocked.md and read .quay-prompt.md, but do not touch other .quay-* files.
4. When done, push the branch. Then check whether a PR already exists for this branch (e.g. \`gh pr list --head <branch>\`). If none exists, open one via \`gh pr create\` against the configured base branch and include the ticket reference. If a PR already exists, do NOT create a duplicate.
5. Follow the repo's contribution guide if one is configured.
6. Do not call any tool requiring interactive input.
7. Dependencies are already installed by Quay. Do not re-run install commands.
8. If you would normally ask a clarifying question, write that question into .quay-blocked.md and exit. Do not guess.
`;

export function ensurePreambleId(db: DB, clock: Clock): number {
  const latest = db
    .query<{ preamble_id: number }, []>(
      "SELECT preamble_id FROM preambles ORDER BY preamble_id DESC LIMIT 1",
    )
    .get();
  if (latest) return latest.preamble_id;

  const inserted = db
    .query<{ preamble_id: number }, [string, string]>(
      "INSERT INTO preambles (body, created_at) VALUES (?, ?) RETURNING preamble_id",
    )
    .get(DEFAULT_PREAMBLE_BODY, clock.nowISO());
  if (!inserted) throw new Error("preamble insert returned no row");
  return inserted.preamble_id;
}

export function loadPreambleBody(db: DB, preambleId: number): string {
  const row = db
    .query<{ body: string }, [number]>(
      "SELECT body FROM preambles WHERE preamble_id = ?",
    )
    .get(preambleId);
  if (!row) throw new Error(`preamble ${preambleId} not found`);
  return row.body;
}
