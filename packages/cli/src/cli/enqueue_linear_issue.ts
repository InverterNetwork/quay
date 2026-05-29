// `quay enqueue --linear-issue <id>` — adapters spec §8.
//
// Atomicity invariant (spec §3): fetchTicketContext → validate (child
// process) → enter the existing enqueue core function. Substrate side
// effects (worktree, branch, DB writes, artifact files) start only after
// both adapter assembly and validator return success. Failure at any
// earlier point leaves the system in a clean no-op state — there is
// nothing to roll back because nothing was started.

import {
  enqueue,
  type EnqueueDeps,
  type EnqueueResolvedDependency,
  type EnqueueResult,
} from "../core/enqueue.ts";
import { QuayError } from "../core/errors.ts";
import { parseQuayConfigBlock } from "../core/quay_config_block.ts";
import { mergeNormalizedTags } from "../core/tag_normalize.ts";
import { fetchTicketContextWithIssue } from "../core/ticket_context.ts";
import type { ValidatorRunner } from "../core/validator_runner.ts";
import type {
  LinearBlockedByRelation,
  LinearIssue,
  LinearPort,
} from "../ports/linear.ts";
import type { SlackPort } from "../ports/slack.ts";
import type { TicketAuthor, TicketContext } from "../ports/ticket_context.ts";
import type { CliIO } from "./io.ts";
import type { DispatchResult } from "./dispatch.ts";
import { toCliError } from "./errors.ts";
import type { DB } from "../db/connection.ts";

export interface EnqueueLinearIssueArgs {
  // Explicit --repo flag value; null means "read repo from the ticket".
  repoId: string | null;
  identifier: string;
  cliTags: string[];
  baseBranch: string | null;
  requestPrScreenshots: boolean;
  requirePrScreenshots: boolean;
  workerAgent: string | null;
  workerModel: string | null;
  reviewerAgent: string | null;
  reviewerModel: string | null;
}

export interface EnqueueLinearIssueDeps {
  enqueueDeps: EnqueueDeps;
  linear: LinearPort;
  slack: SlackPort;
  validatorRunner: ValidatorRunner;
  adaptersConfig: { linearEnabled: boolean; slackEnabled: boolean };
}

export async function handleEnqueueLinearIssue(
  args: EnqueueLinearIssueArgs,
  deps: EnqueueLinearIssueDeps,
  io: CliIO,
): Promise<DispatchResult> {
  // Pre-fetch idempotency: when an explicit --repo was given we look up
  // (repo, external_ref) directly. When --repo is absent we'd normally have to
  // fetch the ticket first to learn the repo — but Linear identifiers
  // (ENG-1234, AST-79, …) are globally unique within a workspace, so a unique
  // row by `external_ref` alone is reliably idempotent. Short-circuiting on
  // that match preserves the load-bearing property "a re-poll of an already-
  // enqueued ticket doesn't burn Linear / Slack API quota" on the canonical
  // hermes-agent path. If the lookup returns 0 rows the ticket fetch is
  // unavoidable; if it returns 2+ rows (cross-source collision in some future
  // multi-source world) we defer to the post-fetch (repo, external_ref) check.
  const externalRef = args.identifier.toUpperCase();
  if (args.repoId !== null) {
    const existing = lookupExistingTask(
      deps.enqueueDeps.db,
      args.repoId,
      externalRef,
    );
    if (existing !== null) {
      io.stdout(`${JSON.stringify(existing)}\n`);
      return { exitCode: 0 };
    }
  } else {
    const candidates = lookupRepoIdsForExternalRef(
      deps.enqueueDeps.db,
      externalRef,
    );
    if (candidates.length === 1) {
      const existing = lookupExistingTask(
        deps.enqueueDeps.db,
        candidates[0]!,
        externalRef,
      );
      if (existing !== null) {
        io.stdout(`${JSON.stringify(existing)}\n`);
        return { exitCode: 0 };
      }
    }
  }

  let ctx: TicketContext;
  let issue: LinearIssue;
  try {
    const fetched = await fetchTicketContextWithIssue(
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

  // Explicit --repo wins; ticket-supplied repo is the fallback.
  // This precedence lets operators override the target for one-off runs
  // without editing the ticket.
  const resolvedRepoId = args.repoId ?? ctx.repo;
  const resolvedBaseBranch = args.baseBranch ?? ctx.base_branch;

  // Deferred idempotency check for the ticket-repo path (no --repo given).
  if (args.repoId === null) {
    const existing = lookupExistingTask(
      deps.enqueueDeps.db,
      resolvedRepoId,
      externalRef,
    );
    if (existing !== null) {
      io.stdout(`${JSON.stringify(existing)}\n`);
      return { exitCode: 0 };
    }
  }

  // Block tags are already normalised inside `fetchTicketContextWithIssue`;
  // merge in the CLI `--tag` values (lower-cased + deduped against the block
  // set, first occurrence wins) and route the merged set through the
  // validator. Without this, an operator typo like `--tag CamelCase` would
  // bypass the schema's charset rule and land in `tasks` raw.
  const mergedTags = mergeNormalizedTags(ctx.tags, args.cliTags);

  const validatorPayload = buildValidatorPayload(
    ctx,
    issue,
    mergedTags,
    resolvedBaseBranch,
  );

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

  let dependencyResolution: LinearDependencyResolution;
  try {
    const relations = await deps.linear.getBlockedByRelations(args.identifier);
    dependencyResolution = resolveLinearDependencies(
      deps.enqueueDeps.db,
      relations,
      resolvedRepoId,
      deps.enqueueDeps.clock.nowISO(),
    );
    ctx = {
      ...ctx,
      ticket_snapshot: augmentTicketSnapshotWithDependencies(
        ctx.ticket_snapshot,
        dependencyResolution.snapshotRelations,
      ),
    };
  } catch (err) {
    return emitError(io, err);
  }

  const authorsJson = serializeAuthors(ctx.authors);

  let result: EnqueueResult;
  try {
    result = enqueue(deps.enqueueDeps, {
      repo_id: resolvedRepoId,
      brief: ctx.brief,
      external_ref: ctx.external_ref,
      ticket_snapshot: ctx.ticket_snapshot,
      slack_thread_ref: ctx.slack_thread_ref,
      tags: mergedTags,
      worker_execution: ctx.worker_execution,
      base_branch: resolvedBaseBranch ?? undefined,
      request_pr_screenshots: args.requestPrScreenshots,
      require_pr_screenshots: args.requirePrScreenshots,
      dependencies: dependencyResolution.dependencies,
      authors_json: authorsJson,
      worker_agent: args.workerAgent,
      worker_model: args.workerModel,
      reviewer_agent: args.reviewerAgent,
      reviewer_model: args.reviewerModel,
    });
  } catch (err) {
    // Idempotency under concurrent invocation (spec §3): if two pollers race
    // past the preflight lookupExistingTask() and both reach the INSERT, the
    // unique index on (repo_id, external_ref) ensures only one succeeds. The
    // loser gets SQLITE_CONSTRAINT_UNIQUE; we re-fetch the winner's row and
    // return it as if the preflight had found it. enqueue() already rolls back
    // the substrate side effects (worktree, branch) before re-throwing, so no
    // cleanup is needed here.
    if (isUniqueConstraintError(err) && ctx.external_ref !== null) {
      const recovered = lookupExistingTask(
        deps.enqueueDeps.db,
        resolvedRepoId,
        ctx.external_ref,
      );
      if (recovered !== null) {
        io.stdout(`${JSON.stringify(recovered)}\n`);
        return { exitCode: 0 };
      }
    }
    return emitError(io, err);
  }

  io.stdout(`${JSON.stringify(result)}\n`);
  return { exitCode: 0 };
}

interface DependencyTaskRow {
  task_id: string;
  state: string;
}

interface LinearDependencySnapshot {
  relation_id: string;
  blocker_identifier: string;
  blocker_url: string;
  blocker_title: string;
  blocker_state_type: string | null;
  blocker_repo_id: string | null;
  complete_in_linear: boolean;
  tracked_task_id: string | null;
  tracked_task_state: string | null;
  persisted: boolean;
}

interface LinearDependencyResolution {
  dependencies: EnqueueResolvedDependency[];
  snapshotRelations: LinearDependencySnapshot[];
}

function resolveLinearDependencies(
  db: DB,
  relations: LinearBlockedByRelation[],
  fallbackRepoId: string,
  now: string,
): LinearDependencyResolution {
  const dependencies: EnqueueResolvedDependency[] = [];
  const snapshotRelations: LinearDependencySnapshot[] = [];
  const missing: Array<{ external_ref: string; repo_id: string }> = [];
  const seen = new Set<string>();

  for (const relation of relations) {
    const blockerExternalRef = relation.blocker.identifier.toUpperCase();
    const blockerRepoId = repoIdFromBlockerBody(relation.blocker.body) ?? fallbackRepoId;
    const completeInLinear = isCompleteLinearState(relation.blocker.stateType);
    const key = `${blockerRepoId}\0${blockerExternalRef}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let tracked: DependencyTaskRow | null = null;
    if (!completeInLinear) {
      tracked = lookupDependencyTask(db, blockerRepoId, blockerExternalRef);
      if (tracked === null) {
        missing.push({ external_ref: blockerExternalRef, repo_id: blockerRepoId });
      } else {
        dependencies.push({
          dependency_task_id: tracked.task_id,
          dependency_source: "linear",
          dependency_external_ref: blockerExternalRef,
          dependency_repo_id: blockerRepoId,
          required_state: "merged",
          satisfied_at: tracked.state === "merged" ? now : null,
        });
      }
    }

    snapshotRelations.push({
      relation_id: relation.relationId,
      blocker_identifier: blockerExternalRef,
      blocker_url: relation.blocker.url,
      blocker_title: relation.blocker.title,
      blocker_state_type: relation.blocker.stateType,
      blocker_repo_id: blockerRepoId,
      complete_in_linear: completeInLinear,
      tracked_task_id: tracked?.task_id ?? null,
      tracked_task_state: tracked?.state ?? null,
      persisted: !completeInLinear && tracked !== null,
    });
  }

  if (missing.length > 0) {
    throw new QuayError(
      "dependency_not_tracked",
      `Linear blocker ${missing[0]!.external_ref} is incomplete but not tracked by Quay`,
      { dependencies: missing },
    );
  }

  return { dependencies, snapshotRelations };
}

function repoIdFromBlockerBody(body: string): string | null {
  try {
    return parseQuayConfigBlock(body)?.repo ?? null;
  } catch {
    return null;
  }
}

function isCompleteLinearState(stateType: string | null): boolean {
  return stateType?.toLowerCase() === "completed";
}

function lookupDependencyTask(
  db: DB,
  repoId: string,
  externalRef: string,
): DependencyTaskRow | null {
  return (
    db
      .query<DependencyTaskRow, [string, string]>(
        `SELECT task_id, state FROM tasks WHERE repo_id = ? AND external_ref = ?`,
      )
      .get(repoId, externalRef) ?? null
  );
}

function augmentTicketSnapshotWithDependencies(
  snapshot: string,
  relations: LinearDependencySnapshot[],
): string {
  try {
    const parsed = JSON.parse(snapshot) as Record<string, unknown>;
    parsed.linear_blocked_by_relations = relations;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return JSON.stringify(
      {
        original_snapshot: snapshot,
        linear_blocked_by_relations: relations,
      },
      null,
      2,
    );
  }
}

// Spec §11 mapping: explicit. `body` is the raw Linear ticket body (block
// intact, NOT the composed brief). `tags` is the normalised union of
// block + CLI `--tag` values so charset/count rules apply uniformly to
// everything that lands in the task. `slack_thread` is OMITTED entirely
// when the ref is null — not passed as `null` — because the validator's
// schema declares it `[optional]` and absence is the canonical "no thread"
// signal.
export function buildValidatorPayload(
  ctx: TicketContext,
  issue: LinearIssue,
  mergedTags: string[],
  baseBranch: string | null = ctx.base_branch,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    body: issue.body,
    repo: ctx.repo,
    tags: mergedTags,
    authors: ctx.authors,
    external_ref: ctx.external_ref,
    worker_execution: ctx.worker_execution,
  };
  if (baseBranch !== null) {
    payload.base_branch = baseBranch;
  }
  if (ctx.slack_thread_ref !== null) {
    payload.slack_thread = ctx.slack_thread_ref;
  }
  return payload;
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

// Pre-fetch helper for the no-`--repo` path. Returns the repo_ids of every
// task currently bearing this external_ref. The unique index is
// (repo_id, external_ref), so 2+ rows imply a cross-source collision — rare
// in v1 (Linear-only) but the caller defers to a post-fetch check rather
// than guessing.
function lookupRepoIdsForExternalRef(
  db: DB,
  externalRef: string,
): string[] {
  return db
    .query<{ repo_id: string }, [string]>(
      `SELECT repo_id FROM tasks WHERE external_ref = ?`,
    )
    .all(externalRef)
    .map((r) => r.repo_id);
}

function emitError(io: CliIO, err: unknown): DispatchResult {
  const payload = toCliError(err);
  io.stderr(`${JSON.stringify(payload)}\n`);
  return { exitCode: 1 };
}

// SQLite raises a constraint error whose message contains "UNIQUE constraint
// failed" when a unique index is violated. Match that string so we don't
// swallow unrelated errors.
function isUniqueConstraintError(err: unknown): boolean {
  if (err instanceof Error) {
    return (
      err.message.includes("UNIQUE constraint failed") ||
      err.message.includes("constraint failed")
    );
  }
  return false;
}
