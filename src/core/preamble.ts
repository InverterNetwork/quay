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

export const DEFAULT_REVIEWER_PREAMBLE_BODY = `Quay reviewer worker preamble (v1)

You are running as a Quay reviewer worker. Review the pull request and post exactly one GitHub PR review with a definite verdict.

1. Read the Quay brief first, then inspect the diff and only fetch missing context.
2. Identify real correctness, security, integration, and maintainability defects. Do not raise issues that merely disagree with established local patterns.
3. Post findings with precise inline comments whenever they have a file/line locus. Use the review body only for PR-wide findings.
4. Use gh pr review with --approve when there are no blocking findings, or --request-changes when there are blocking findings. Do not use --comment.
5. Do not mutate code or git state: no commits, pushes, installs, branch changes, or writes to repo files. The substrate's .quay-* files are allowed. If you cannot proceed, write .quay-blocked.md and exit without posting a review.
6. After posting the review or writing .quay-blocked.md, exit cleanly. Do not wait for human input or poll for more state.
`;

export type PreambleKind = "code" | "review";

export function ensurePreambleId(
  db: DB,
  clock: Clock,
  kind: PreambleKind = "code",
): number {
  const latest = db
    .query<{ preamble_id: number }, [string]>(
      "SELECT preamble_id FROM preambles WHERE kind = ? ORDER BY preamble_id DESC LIMIT 1",
    )
    .get(kind);
  if (latest) return latest.preamble_id;

  const body =
    kind === "review" ? DEFAULT_REVIEWER_PREAMBLE_BODY : DEFAULT_PREAMBLE_BODY;
  const inserted = db
    .query<{ preamble_id: number }, [string, string, string]>(
      "INSERT INTO preambles (body, kind, created_at) VALUES (?, ?, ?) RETURNING preamble_id",
    )
    .get(body, kind, clock.nowISO());
  if (!inserted) throw new Error("preamble insert returned no row");
  return inserted.preamble_id;
}

export function ensureReviewerPreambleId(db: DB, clock: Clock): number {
  return ensurePreambleId(db, clock, "review");
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
