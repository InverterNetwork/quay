// `quay enqueue --linear-issue <id>` — adapters spec §8.
//
// Atomicity invariant (spec §3): fetchTicketContext → validate (child
// process) → enter the existing enqueue core function. Substrate side
// effects (worktree, branch, DB writes, artifact files) start only after
// both adapter assembly and validator return success. Failure at any
// earlier point leaves the system in a clean no-op state — there is
// nothing to roll back because nothing was started.

import { join } from "node:path";
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
import {
  createOrVerifyUmbrellaWorkflow,
  deriveUmbrellaFeatureBranch,
  listUmbrellaExpectedTasks,
  lookupUmbrellaWorkflow,
  markUmbrellaExpectedTaskCompleteWithoutQuay,
  requireUmbrellaExpectedTask,
  upsertUmbrellaExpectedTask,
  type UmbrellaExpectedTaskRow,
  type UmbrellaWorkflowRow,
} from "../core/umbrella_workflows.ts";
import type { ValidatorRunner } from "../core/validator_runner.ts";
import type {
  LinearBlockedByRelation,
  LinearHierarchyIssue,
  LinearIssueHierarchy,
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
  asNormalTask: boolean;
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

  let relations: LinearBlockedByRelation[];
  let hierarchy: LinearIssueHierarchy;
  try {
    relations = await deps.linear.getBlockedByRelations(args.identifier);
    hierarchy = await deps.linear.getIssueHierarchy(args.identifier);
  } catch (err) {
    return emitError(io, err);
  }

  if (hierarchy.children.length > 0) {
    try {
      const result = createLinearUmbrellaParentWorkflow(deps.enqueueDeps, {
        repoId: resolvedRepoId,
        externalRef,
        baseBranch: resolvedBaseBranch,
        hierarchy,
      });
      io.stdout(`${JSON.stringify(result)}\n`);
      return { exitCode: 0 };
    } catch (err) {
      return emitError(io, err);
    }
  }

  let resolvedLinearUmbrella: LinearUmbrellaSubtaskResolution | null = null;
  if (!args.asNormalTask && hierarchy.parent !== null) {
    try {
      resolvedLinearUmbrella = resolveLinearUmbrellaSubtask(
        deps.enqueueDeps.db,
        {
          repoId: resolvedRepoId,
          childExternalRef: externalRef,
          parent: hierarchy.parent,
        },
      );
    } catch (err) {
      return emitError(io, err);
    }
  }
  if (
    ctx.umbrella !== null &&
    ctx.umbrella.depends_on.length > 0 &&
    resolvedLinearUmbrella === null
  ) {
    return emitError(
      io,
      new QuayError(
        "validation_error",
        "quay-config umbrella.depends_on is not supported for Linear-backed enqueue; use native Linear blocked-by relations",
        { external_ref: externalRef },
      ),
    );
  }

  let dependencyResolution: LinearDependencyResolution;
  try {
    const now = deps.enqueueDeps.clock.nowISO();
    dependencyResolution = resolveLinearDependencies(
      deps.enqueueDeps.db,
      relations,
      resolvedRepoId,
      now,
      { umbrellaWorkflow: resolvedLinearUmbrella?.workflow ?? null },
    );
    ctx = {
      ...ctx,
      ticket_snapshot: augmentTicketSnapshot(
        ctx.ticket_snapshot,
        dependencyResolution.snapshotRelations,
        hierarchy,
        args.asNormalTask
          ? { linear_umbrella_membership_override: "as_normal_task" }
          : {},
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
      base_branch:
        resolvedLinearUmbrella?.workflow.feature_branch ??
        resolvedBaseBranch ??
        undefined,
      umbrella:
        resolvedLinearUmbrella !== null
          ? {
              external_ref: resolvedLinearUmbrella.workflow.external_ref,
              base_branch: resolvedLinearUmbrella.workflow.base_branch,
              feature_branch: resolvedLinearUmbrella.workflow.feature_branch,
              expected_external_ref: externalRef,
              complete_without_quay:
                dependencyResolution.umbrellaCompletions.length === 0
                  ? undefined
                  : dependencyResolution.umbrellaCompletions,
            }
          : ctx.umbrella === null
          ? undefined
          : {
              external_ref: ctx.umbrella.external_ref,
              base_branch:
                ctx.umbrella.base_branch ?? resolvedBaseBranch ?? undefined,
              feature_branch: ctx.umbrella.feature_branch ?? undefined,
            },
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
  umbrellaCompletions: LinearUmbrellaCompletionWithoutQuay[];
}

interface LinearUmbrellaCompletionWithoutQuay {
  external_ref: string;
  completion_source: "linear";
  completion_reason: string;
  completed_at: string;
}

interface LinearHierarchySnapshotIssue {
  identifier: string;
  url: string;
  title: string;
  state_type: string | null;
  complete_in_linear: boolean;
}

interface LinearHierarchySnapshot {
  parent: LinearHierarchySnapshotIssue | null;
  children: LinearHierarchySnapshotIssue[];
}

interface UmbrellaParentEnqueueResult {
  umbrella_workflow_id: number;
  external_ref: string;
  repo_id: string;
  base_branch: string;
  feature_branch: string;
  expected_tasks: UmbrellaExpectedTaskRow[];
  linear_hierarchy: LinearHierarchySnapshot;
}

interface LinearUmbrellaSubtaskResolution {
  workflow: UmbrellaWorkflowRow;
}

interface RepoRow {
  repo_id: string;
  base_branch: string;
  archived_at: string | null;
}

function createLinearUmbrellaParentWorkflow(
  deps: EnqueueDeps,
  input: {
    repoId: string;
    externalRef: string;
    baseBranch: string | null;
    hierarchy: LinearIssueHierarchy;
  },
): UmbrellaParentEnqueueResult {
  const repo = lookupRepo(deps.db, input.repoId);
  if (repo === null) {
    throw new QuayError("unknown_repo", `repo "${input.repoId}" not found`, {
      repo_id: input.repoId,
    });
  }
  if (repo.archived_at !== null) {
    throw new QuayError(
      "repo_archived",
      `repo "${input.repoId}" is archived; new tasks are rejected`,
      { repo_id: input.repoId },
    );
  }
  if (!deps.git.bareCloneExists(repo.repo_id)) {
    const expectedPath = join(deps.paths.reposRoot, `${repo.repo_id}.git`);
    throw new QuayError(
      "bare_clone_missing",
      `bare clone for repo "${repo.repo_id}" not found at ${expectedPath}; materialize it before enqueuing (e.g. \`git clone --bare <repo_url> ${expectedPath}\` — look up <repo_url> via \`quay repo get ${repo.repo_id}\`)`,
      { repo_id: repo.repo_id, expected_path: expectedPath },
    );
  }

  const baseBranch = input.baseBranch ?? repo.base_branch;
  const featureBranch = deriveUmbrellaFeatureBranch(deps.git, input.externalRef);
  const now = deps.clock.nowISO();

  deps.db.exec("BEGIN");
  try {
    const workflow = createOrVerifyUmbrellaWorkflow(
      { db: deps.db, git: deps.git },
      {
        repoId: repo.repo_id,
        externalRef: input.externalRef,
        baseBranch,
        featureBranch,
        now,
        ensureBranch: false,
      },
    );

    const expectedExternalRefs = new Set<string>();
    for (const child of input.hierarchy.children) {
      const childExternalRef = child.identifier.toUpperCase();
      if (expectedExternalRefs.has(childExternalRef)) continue;
      expectedExternalRefs.add(childExternalRef);
      const row = upsertUmbrellaExpectedTask(deps.db, {
        umbrellaWorkflowId: workflow.umbrella_workflow_id,
        externalRef: childExternalRef,
        title: child.title,
        linearIssueUrl: child.url,
        now,
      });
      if (isCompleteLinearState(child.stateType) && row.state !== "linked") {
        markUmbrellaExpectedTaskCompleteWithoutQuay(deps.db, {
          umbrellaWorkflowId: workflow.umbrella_workflow_id,
          externalRef: childExternalRef,
          completionSource: "linear",
          completionReason: "Linear issue was complete when umbrella was enqueued",
          completedAt: now,
          now,
        });
      }
    }

    const expectedTasks = listUmbrellaExpectedTasks(
      deps.db,
      workflow.umbrella_workflow_id,
    );
    deps.git.ensureRemoteBranchFromBase(
      repo.repo_id,
      workflow.feature_branch,
      workflow.base_branch,
    );
    deps.db.exec("COMMIT");
    return {
      umbrella_workflow_id: workflow.umbrella_workflow_id,
      external_ref: workflow.external_ref,
      repo_id: workflow.repo_id,
      base_branch: workflow.base_branch,
      feature_branch: workflow.feature_branch,
      expected_tasks: expectedTasks,
      linear_hierarchy: buildLinearHierarchySnapshot(input.hierarchy),
    };
  } catch (err) {
    try {
      deps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

function resolveLinearUmbrellaSubtask(
  db: DB,
  input: {
    repoId: string;
    childExternalRef: string;
    parent: LinearHierarchyIssue;
  },
): LinearUmbrellaSubtaskResolution {
  const parentExternalRef = input.parent.identifier.toUpperCase();
  const childExternalRef = input.childExternalRef.toUpperCase();
  const workflow = lookupUmbrellaWorkflow(
    db,
    input.repoId,
    parentExternalRef,
  );
  if (workflow === null) {
    throw new QuayError(
      "umbrella_not_enqueued",
      `Linear parent ${parentExternalRef} has not been enqueued as an umbrella workflow`,
      {
        repo_id: input.repoId,
        parent_external_ref: parentExternalRef,
        child_external_ref: childExternalRef,
      },
    );
  }
  const expectedTask = requireUmbrellaExpectedTask(db, {
    umbrellaWorkflowId: workflow.umbrella_workflow_id,
    externalRef: childExternalRef,
  });
  if (expectedTask.state === "complete_without_quay") {
    throw new QuayError(
      "validation_error",
      `umbrella subtask ${childExternalRef} is already complete without Quay and cannot be enqueued`,
      {
        umbrella_workflow_id: workflow.umbrella_workflow_id,
        parent_external_ref: parentExternalRef,
        child_external_ref: childExternalRef,
        state: expectedTask.state,
      },
    );
  }
  return { workflow };
}

function resolveLinearDependencies(
  db: DB,
  relations: LinearBlockedByRelation[],
  fallbackRepoId: string,
  now: string,
  options: { umbrellaWorkflow?: UmbrellaWorkflowRow | null } = {},
): LinearDependencyResolution {
  const dependencies: EnqueueResolvedDependency[] = [];
  const snapshotRelations: LinearDependencySnapshot[] = [];
  const umbrellaCompletions: LinearUmbrellaCompletionWithoutQuay[] = [];
  const missing: Array<{ external_ref: string; repo_id: string }> = [];
  const seen = new Set<string>();
  const umbrellaWorkflow = options.umbrellaWorkflow ?? null;

  for (const relation of relations) {
    const blockerExternalRef = relation.blocker.identifier.toUpperCase();
    const blockerRepoId = repoIdFromBlockerBody(relation.blocker.body) ?? fallbackRepoId;
    const completeInLinear = isCompleteLinearState(relation.blocker.stateType);
    const sameUmbrellaBlocker =
      umbrellaWorkflow === null
        ? null
        : lookupSameUmbrellaDependency(
            db,
            umbrellaWorkflow.umbrella_workflow_id,
            blockerExternalRef,
          );
    const dependencyRepoId =
      sameUmbrellaBlocker === null ? blockerRepoId : umbrellaWorkflow!.repo_id;
    const key = `${sameUmbrellaBlocker === null ? "normal" : "umbrella"}\0${dependencyRepoId}\0${blockerExternalRef}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let tracked: DependencyTaskRow | null = null;
    let persisted = false;
    if (sameUmbrellaBlocker !== null) {
      tracked =
        sameUmbrellaBlocker.task_id === null
          ? null
          : {
              task_id: sameUmbrellaBlocker.task_id,
              state: sameUmbrellaBlocker.task_state ?? "",
            };
      if (
        sameUmbrellaBlocker.task_id === null &&
        completeInLinear &&
        sameUmbrellaBlocker.expected_state !== "complete_without_quay"
      ) {
        umbrellaCompletions.push({
          external_ref: blockerExternalRef,
          completion_source: "linear",
          completion_reason:
            "Linear issue was complete when used as an umbrella dependency",
          completed_at: now,
        });
      }
      dependencies.push({
        dependency_task_id: sameUmbrellaBlocker.task_id,
        dependency_source: "linear",
        dependency_external_ref: blockerExternalRef,
        dependency_repo_id: dependencyRepoId,
        umbrella_workflow_id: umbrellaWorkflow!.umbrella_workflow_id,
        scope: "umbrella",
        required_state: "merged_to_feature_branch",
        satisfied_at: sameUmbrellaDependencySatisfied(
          sameUmbrellaBlocker,
          completeInLinear,
        )
          ? now
          : null,
      });
      persisted = true;
    } else {
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
          persisted = true;
        }
      }
    }

    snapshotRelations.push({
      relation_id: relation.relationId,
      blocker_identifier: blockerExternalRef,
      blocker_url: relation.blocker.url,
      blocker_title: relation.blocker.title,
      blocker_state_type: relation.blocker.stateType,
      blocker_repo_id: dependencyRepoId,
      complete_in_linear: completeInLinear,
      tracked_task_id: tracked?.task_id ?? null,
      tracked_task_state:
        sameUmbrellaBlocker?.task_state ?? tracked?.state ?? null,
      persisted,
    });
  }

  if (missing.length > 0) {
    throw new QuayError(
      "dependency_not_tracked",
      `Linear blocker ${missing[0]!.external_ref} is incomplete but not tracked by Quay`,
      { dependencies: missing },
    );
  }

  return { dependencies, snapshotRelations, umbrellaCompletions };
}

interface SameUmbrellaDependencyRow {
  expected_state: string;
  task_id: string | null;
  task_state: string | null;
}

function lookupSameUmbrellaDependency(
  db: DB,
  umbrellaWorkflowId: number,
  externalRef: string,
): SameUmbrellaDependencyRow | null {
  return (
    db
      .query<SameUmbrellaDependencyRow, [number, string]>(
        `SELECT uet.state AS expected_state,
                ut.task_id AS task_id,
                t.state AS task_state
           FROM umbrella_expected_tasks uet
           LEFT JOIN umbrella_tasks ut
             ON ut.umbrella_workflow_id = uet.umbrella_workflow_id
            AND ut.external_ref = uet.external_ref
           LEFT JOIN tasks t
             ON t.task_id = ut.task_id
          WHERE uet.umbrella_workflow_id = ?
            AND uet.external_ref = ?
          LIMIT 1`,
      )
      .get(umbrellaWorkflowId, externalRef) ?? null
  );
}

function sameUmbrellaDependencySatisfied(
  row: SameUmbrellaDependencyRow,
  completeInLinear: boolean,
): boolean {
  return (
    row.task_state === "merged_to_feature_branch" ||
    row.expected_state === "complete_without_quay" ||
    (row.task_id === null && completeInLinear)
  );
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

function lookupRepo(db: DB, repoId: string): RepoRow | null {
  return (
    db
      .query<RepoRow, [string]>(
        `SELECT repo_id, base_branch, archived_at FROM repos WHERE repo_id = ?`,
      )
      .get(repoId) ?? null
  );
}

function augmentTicketSnapshot(
  snapshot: string,
  relations: LinearDependencySnapshot[],
  hierarchy: LinearIssueHierarchy,
  options: { linear_umbrella_membership_override?: string | null } = {},
): string {
  const hierarchySnapshot = buildLinearHierarchySnapshot(hierarchy);
  try {
    const parsed = JSON.parse(snapshot) as Record<string, unknown>;
    parsed.linear_blocked_by_relations = relations;
    parsed.linear_hierarchy = hierarchySnapshot;
    if (options.linear_umbrella_membership_override !== undefined) {
      parsed.linear_umbrella_membership_override =
        options.linear_umbrella_membership_override;
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    const wrapped: Record<string, unknown> = {
      original_snapshot: snapshot,
      linear_blocked_by_relations: relations,
      linear_hierarchy: hierarchySnapshot,
    };
    if (options.linear_umbrella_membership_override !== undefined) {
      wrapped.linear_umbrella_membership_override =
        options.linear_umbrella_membership_override;
    }
    return JSON.stringify(wrapped, null, 2);
  }
}

function buildLinearHierarchySnapshot(
  hierarchy: LinearIssueHierarchy,
): LinearHierarchySnapshot {
  return {
    parent:
      hierarchy.parent === null
        ? null
        : snapshotHierarchyIssue(hierarchy.parent),
    children: hierarchy.children.map(snapshotHierarchyIssue),
  };
}

function snapshotHierarchyIssue(
  issue: LinearHierarchyIssue,
): LinearHierarchySnapshotIssue {
  return {
    identifier: issue.identifier.toUpperCase(),
    url: issue.url,
    title: issue.title,
    state_type: issue.stateType,
    complete_in_linear: isCompleteLinearState(issue.stateType),
  };
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
