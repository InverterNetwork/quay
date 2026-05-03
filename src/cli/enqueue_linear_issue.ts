// `quay enqueue --linear-issue <id>` — adapters spec §8.
//
// Atomicity invariant (spec §3): fetchTicketContext → validate (child
// process) → enter the existing enqueue core function. Substrate side
// effects (worktree, branch, DB writes, artifact files) start only after
// both adapter assembly and validator return success. Failure at any
// earlier point leaves the system in a clean no-op state — there is
// nothing to roll back because nothing was started.

import { enqueue, type EnqueueDeps, type EnqueueResult } from "../core/enqueue.ts";
import { fetchTicketContextWithIssue } from "../core/ticket_context.ts";
import type { ValidatorRunner } from "../core/validator_runner.ts";
import type { LinearIssue, LinearPort } from "../ports/linear.ts";
import type { SlackPort } from "../ports/slack.ts";
import type { TicketAuthor, TicketContext } from "../ports/ticket_context.ts";
import type { CliIO } from "./io.ts";
import type { DispatchResult } from "./dispatch.ts";
import { toCliError } from "./errors.ts";
import type { DB } from "../db/connection.ts";

export interface EnqueueLinearIssueArgs {
  repoId: string;
  identifier: string;
  cliTags: string[];
}

export interface EnqueueLinearIssueDeps {
  enqueueDeps: EnqueueDeps;
  linear: LinearPort;
  slack: SlackPort;
  validatorRunner: ValidatorRunner;
  adaptersConfig: { linearEnabled: boolean; slackEnabled: boolean };
}

export function handleEnqueueLinearIssue(
  args: EnqueueLinearIssueArgs,
  deps: EnqueueLinearIssueDeps,
  io: CliIO,
): DispatchResult {
  // Idempotency check happens BEFORE any adapter call (spec §8: "Calling
  // --linear-issue ENG-1234 twice returns the same task_id"). Cheap, and
  // means a re-poll of an already-enqueued ticket doesn't burn Linear /
  // Slack API quota.
  const externalRef = args.identifier.toUpperCase();
  const existing = lookupExistingTask(
    deps.enqueueDeps.db,
    args.repoId,
    externalRef,
  );
  if (existing !== null) {
    io.stdout(`${JSON.stringify(existing)}\n`);
    return { exitCode: 0 };
  }

  let ctx: TicketContext;
  let issue: LinearIssue;
  try {
    const fetched = fetchTicketContextWithIssue(
      {
        linear: deps.linear,
        slack: deps.slack,
        config: deps.adaptersConfig,
      },
      args.identifier,
    );
    ctx = fetched.ctx;
    issue = fetched.issue;
  } catch (err) {
    return emitError(io, err);
  }

  const validatorPayload = buildValidatorPayload(ctx, issue);

  let validation;
  try {
    validation = deps.validatorRunner.run(validatorPayload);
  } catch (err) {
    return emitError(io, err);
  }

  if (!validation.valid) {
    // Per spec §11 step 3: surface validator errors verbatim to stdout, exit
    // non-zero. No DB writes (substrate hasn't been entered yet).
    io.stdout(
      `${JSON.stringify({ valid: false, errors: validation.errors })}\n`,
    );
    return { exitCode: 1 };
  }

  const mergedTags = unionTags(ctx.tags, args.cliTags);
  const authorsJson = serializeAuthors(ctx.authors);

  let result: EnqueueResult;
  try {
    result = enqueue(deps.enqueueDeps, {
      repo_id: args.repoId,
      brief: ctx.brief,
      external_ref: ctx.external_ref,
      ticket_snapshot: ctx.ticket_snapshot,
      slack_thread_ref: ctx.slack_thread_ref,
      tags: mergedTags,
      authors_json: authorsJson,
    });
  } catch (err) {
    return emitError(io, err);
  }

  io.stdout(`${JSON.stringify(result)}\n`);
  return { exitCode: 0 };
}

// Spec §11 mapping: explicit. `body` is the raw Linear ticket body (block
// intact, NOT the composed brief). `tags`/`authors`/`external_ref` pass
// through 1:1. `slack_thread` is OMITTED entirely when the ref is null —
// not passed as `null` — because the validator's schema declares it
// `[optional]` and absence is the canonical "no thread" signal.
export function buildValidatorPayload(
  ctx: TicketContext,
  issue: LinearIssue,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    body: issue.body,
    tags: ctx.tags,
    authors: ctx.authors,
    external_ref: ctx.external_ref,
  };
  if (ctx.slack_thread_ref !== null) {
    payload.slack_thread = ctx.slack_thread_ref;
  }
  return payload;
}

export function unionTags(blockTags: string[], cliTags: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const t of [...blockTags, ...cliTags]) {
    if (seen.has(t)) continue;
    seen.add(t);
    merged.push(t);
  }
  return merged;
}

function serializeAuthors(authors: TicketAuthor[]): string {
  return JSON.stringify(authors);
}

interface ExistingTaskRow {
  task_id: string;
  state: string;
  branch_name: string;
  tmux_id: string;
  worktree_path: string;
}

function lookupExistingTask(
  db: DB,
  repoId: string,
  externalRef: string,
): EnqueueResult | null {
  const row = db
    .query<ExistingTaskRow, [string, string]>(
      `SELECT task_id, state, branch_name, tmux_id, worktree_path
         FROM tasks WHERE repo_id = ? AND external_ref = ?`,
    )
    .get(repoId, externalRef);
  if (!row) return null;
  const attempt = db
    .query<{ attempt_id: number }, [string]>(
      `SELECT attempt_id FROM attempts
        WHERE task_id = ?
        ORDER BY attempt_number ASC
        LIMIT 1`,
    )
    .get(row.task_id);
  return {
    task_id: row.task_id,
    // The substrate enqueue's return type narrows `state` to "queued"; for an
    // already-existing task we report the live state instead, which is the
    // honest answer if the task has already advanced. Cast to satisfy the
    // tighter return type — the test asserts task_id equality only.
    state: row.state as "queued",
    branch_name: row.branch_name,
    tmux_id: row.tmux_id,
    worktree_path: row.worktree_path,
    attempt_id: attempt?.attempt_id ?? 0,
  };
}

function emitError(io: CliIO, err: unknown): DispatchResult {
  const payload = toCliError(err);
  io.stderr(`${JSON.stringify(payload)}\n`);
  return { exitCode: 1 };
}
