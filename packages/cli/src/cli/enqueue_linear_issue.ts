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
import {
  LINEAR_STATE_IN_PROGRESS,
  syncLinearState,
} from "../core/linear_state_sync.ts";
import {
  parseQuayConfigBlock,
  setQuayConfigTaskType,
} from "../core/quay_config_block.ts";
import { inferTaskType, type TaskType } from "../core/task_type.ts";
import { mergeNormalizedTags } from "../core/tag_normalize.ts";
import { TASK_TERMINAL_STATES } from "../core/task_state.ts";
import { fetchTicketContextWithIssue } from "../core/ticket_context.ts";
import {
  createOrVerifyUmbrellaWorkflow,
  deriveUmbrellaFeatureBranch,
  listUmbrellaExpectedTasks,
  linkUmbrellaTask,
  lookupUmbrellaWorkflow,
  markUmbrellaExpectedTaskCompleteWithoutQuay,
  markUmbrellaExpectedTaskLinked,
  requireUmbrellaFeatureBranchExists,
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
  rerun: boolean;
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
  // Pre-fetch idempotency is only safe on the explicit override path. The
  // default Linear path treats live parent/child membership as authoritative,
  // so it must inspect Linear hierarchy before returning any existing task.
  // With --as-normal-task the caller opts out of umbrella membership semantics,
  // allowing the old low-quota re-poll shortcut.
  const externalRef = args.identifier.toUpperCase();
  if (args.asNormalTask && args.repoId !== null) {
    const existing = lookupReusableWorkItemRun(
      deps.enqueueDeps.db,
      args.repoId,
      externalRef,
      { rerun: args.rerun },
    );
    if (existing !== null) {
      io.stdout(
        `${JSON.stringify(formatLinearRunOutput(deps.enqueueDeps.db, existing, true))}\n`,
      );
      return { exitCode: 0 };
    }
  } else if (args.asNormalTask) {
    const candidates = lookupRepoIdsForExternalRef(
      deps.enqueueDeps.db,
      externalRef,
    );
    if (candidates.length === 1) {
      const existing = lookupReusableWorkItemRun(
        deps.enqueueDeps.db,
        candidates[0]!,
        externalRef,
        { rerun: args.rerun },
      );
      if (existing !== null) {
        io.stdout(
          `${JSON.stringify(formatLinearRunOutput(deps.enqueueDeps.db, existing, true))}\n`,
        );
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

  try {
    const prepared = await ensureTicketTaskType(deps.linear, issue, ctx, ctx.tags);
    issue = prepared.issue;
    ctx = prepared.ctx;
  } catch (err) {
    return emitError(io, err);
  }

  // Explicit --repo wins; ticket-supplied repo is the fallback.
  // This precedence lets operators override the target for one-off runs
  // without editing the ticket.
  const resolvedRepoId = args.repoId ?? ctx.repo;
  const resolvedBaseBranch = args.baseBranch ?? ctx.base_branch;

  if (ctx.umbrella !== null) {
    return emitError(
      io,
      new QuayError(
        "validation_error",
        "quay-config umbrella metadata is not supported for Linear-backed enqueue; use native Linear parent/child relations for umbrella membership and native Linear blocked-by relations for ordering",
        { external_ref: externalRef },
      ),
    );
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
      const result = await createLinearUmbrellaParentWorkflow(deps, {
        args,
        repoId: resolvedRepoId,
        externalRef,
        baseBranch: resolvedBaseBranch,
        title: issue.title,
        url: issue.url,
        hierarchy,
      });
      io.stdout(`${JSON.stringify(result)}\n`);
      return { exitCode: 0 };
    } catch (err) {
      return emitError(io, err);
    }
  }

  if (!args.asNormalTask && hierarchy.parent !== null) {
    const parentExternalRef = hierarchy.parent.identifier.toUpperCase();
    return emitError(
      io,
      new QuayError(
        "umbrella_child_direct_enqueue",
        `Linear issue ${externalRef} is a child of umbrella parent ${parentExternalRef}; enqueue the parent issue to start the umbrella workflow, or pass --as-normal-task to process this child as a normal task`,
        {
          repo_id: resolvedRepoId,
          parent_external_ref: parentExternalRef,
          child_external_ref: externalRef,
        },
      ),
    );
  }

  const existing = lookupReusableWorkItemRun(
    deps.enqueueDeps.db,
    resolvedRepoId,
    externalRef,
    { rerun: args.rerun },
  );
  if (existing !== null) {
    io.stdout(
      `${JSON.stringify(formatLinearRunOutput(deps.enqueueDeps.db, existing, true))}\n`,
    );
    return { exitCode: 0 };
  }

  let dependencyResolution: LinearDependencyResolution;
  try {
    const now = deps.enqueueDeps.clock.nowISO();
    dependencyResolution = resolveLinearDependencies(
      deps.enqueueDeps.db,
      relations,
      resolvedRepoId,
      now,
      { umbrellaWorkflow: null },
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
      task_type: ctx.task_type,
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
    // past the preflight lookup and both reach the INSERT, the unique active-run
    // index on work_item_id ensures only one succeeds. The loser gets
    // SQLITE_CONSTRAINT_UNIQUE; we re-fetch the winner's row and return it as if
    // the preflight had found it. enqueue() already rolls back the substrate
    // side effects (worktree, branch) before re-throwing, so no cleanup is
    // needed here.
    if (isUniqueConstraintError(err) && ctx.external_ref !== null) {
      const recovered = lookupReusableWorkItemRun(
        deps.enqueueDeps.db,
        resolvedRepoId,
        ctx.external_ref,
        { rerun: args.rerun },
      );
      if (recovered !== null) {
        io.stdout(
          `${JSON.stringify(formatLinearRunOutput(deps.enqueueDeps.db, recovered, true))}\n`,
        );
        return { exitCode: 0 };
      }
    }
    return emitError(io, err);
  }

  io.stdout(
    `${JSON.stringify(formatLinearRunOutput(deps.enqueueDeps.db, result, false))}\n`,
  );
  if (args.rerun) {
    await syncLinearState(deps.linear, externalRef, LINEAR_STATE_IN_PROGRESS);
  }
  return { exitCode: 0 };
}

interface DependencyTaskRow {
  task_id: string;
  state: string;
}

async function ensureTicketTaskType(
  linear: LinearPort,
  issue: LinearIssue,
  ctx: TicketContext,
  tags: readonly string[],
): Promise<{ issue: LinearIssue; ctx: TicketContext }> {
  if (ctx.task_type !== null) return { issue, ctx };

  const taskType = inferTaskType({
    title: issue.title,
    body: issue.body,
    tags,
  });
  const updatedBody = setQuayConfigTaskType(issue.body, taskType);
  if (updatedBody !== issue.body) {
    await linear.updateIssueBody(issue.identifier, updatedBody);
  }
  const updatedIssue = { ...issue, body: updatedBody };
  return {
    issue: updatedIssue,
    ctx: {
      ...ctx,
      task_type: taskType,
      ticket_snapshot: setSnapshotTaskType(ctx.ticket_snapshot, updatedIssue, taskType),
    },
  };
}

function setSnapshotTaskType(
  snapshot: string,
  issue: LinearIssue,
  taskType: TaskType,
): string {
  try {
    const parsed = JSON.parse(snapshot) as {
      linear_issue?: unknown;
      quay_config_block?: unknown;
      [key: string]: unknown;
    };
    parsed.linear_issue = issue;
    if (
      parsed.quay_config_block !== null &&
      typeof parsed.quay_config_block === "object" &&
      !Array.isArray(parsed.quay_config_block)
    ) {
      parsed.quay_config_block = {
        ...parsed.quay_config_block,
        task_type: taskType,
      };
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return snapshot;
  }
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
  child_tasks: LinearUmbrellaChildMaterialization[];
  linear_hierarchy: LinearHierarchySnapshot;
}

interface LinearUmbrellaChildPlan {
  externalRef: string;
  ctx: TicketContext | null;
  relations: LinearBlockedByRelation[];
  completeInLinear: boolean;
}

interface LinearUmbrellaChildMaterialization {
  external_ref: string;
  complete_in_linear: boolean;
  task: EnqueueResult | null;
  reused_existing_task: boolean;
}

interface RepoRow {
  repo_id: string;
  base_branch: string;
  archived_at: string | null;
}

async function createLinearUmbrellaParentWorkflow(
  deps: EnqueueLinearIssueDeps,
  input: {
    args: EnqueueLinearIssueArgs;
    repoId: string;
    externalRef: string;
    baseBranch: string | null;
    title: string;
    url: string;
    hierarchy: LinearIssueHierarchy;
  },
): Promise<UmbrellaParentEnqueueResult> {
  const enqueueDeps = deps.enqueueDeps;
  const repo = lookupRepo(enqueueDeps.db, input.repoId);
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
  if (!enqueueDeps.git.bareCloneExists(repo.repo_id)) {
    const expectedPath = join(
      enqueueDeps.paths.reposRoot,
      `${repo.repo_id}.git`,
    );
    throw new QuayError(
      "bare_clone_missing",
      `bare clone for repo "${repo.repo_id}" not found at ${expectedPath}; materialize it before enqueuing (e.g. \`git clone --bare <repo_url> ${expectedPath}\` — look up <repo_url> via \`quay repo get ${repo.repo_id}\`)`,
      { repo_id: repo.repo_id, expected_path: expectedPath },
    );
  }

  const baseBranch = input.baseBranch ?? repo.base_branch;
  const featureBranch = deriveUmbrellaFeatureBranch(
    enqueueDeps.git,
    input.externalRef,
  );
  const childPlans = await buildLinearUmbrellaChildPlans(deps, {
    parentExternalRef: input.externalRef,
    repoId: repo.repo_id,
    baseBranch,
    hierarchy: input.hierarchy,
  });
  assertUmbrellaChildDependencyPreflight(enqueueDeps.db, {
    repoId: repo.repo_id,
    childPlans,
  });
  const orderedChildPlans = orderUmbrellaChildPlans(
    input.externalRef,
    childPlans,
  );
  const now = enqueueDeps.clock.nowISO();
  const existingWorkflow = lookupUmbrellaWorkflow(
    enqueueDeps.db,
    repo.repo_id,
    input.externalRef,
  );

  enqueueDeps.db.exec("BEGIN");
  let workflow: UmbrellaWorkflowRow;
  try {
    workflow = createOrVerifyUmbrellaWorkflow(
      { db: enqueueDeps.db, git: enqueueDeps.git },
      {
        repoId: repo.repo_id,
        externalRef: input.externalRef,
        baseBranch,
        featureBranch,
        linearIssueTitle: input.title,
        linearIssueUrl: input.url,
        now,
        ensureBranch: false,
      },
    );

    const expectedExternalRefs = new Set<string>();
    for (const child of input.hierarchy.children) {
      const childExternalRef = child.identifier.toUpperCase();
      if (expectedExternalRefs.has(childExternalRef)) continue;
      expectedExternalRefs.add(childExternalRef);
      const row = upsertUmbrellaExpectedTask(enqueueDeps.db, {
        umbrellaWorkflowId: workflow.umbrella_workflow_id,
        externalRef: childExternalRef,
        title: child.title,
        linearIssueUrl: child.url,
        now,
      });
      if (isCompleteLinearState(child.stateType) && row.state !== "linked") {
        markUmbrellaExpectedTaskCompleteWithoutQuay(enqueueDeps.db, {
          umbrellaWorkflowId: workflow.umbrella_workflow_id,
          externalRef: childExternalRef,
          completionSource: "linear",
          completionReason: "Linear issue was complete when umbrella was enqueued",
          completedAt: now,
          now,
        });
      }
    }

    if (existingWorkflow === null) {
      enqueueDeps.git.ensureRemoteBranchFromBase(
        repo.repo_id,
        workflow.feature_branch,
        workflow.base_branch,
      );
    } else {
      requireUmbrellaFeatureBranchExists(enqueueDeps, workflow);
    }
    enqueueDeps.db.exec("COMMIT");
  } catch (err) {
    try {
      enqueueDeps.db.exec("ROLLBACK");
    } catch {}
    throw err;
  }

  const childTasks: LinearUmbrellaChildMaterialization[] = [];
  for (const child of childPlans) {
    if (!child.completeInLinear) continue;
    childTasks.push({
      external_ref: child.externalRef,
      complete_in_linear: true,
      task: null,
      reused_existing_task: false,
    });
  }
  for (const child of orderedChildPlans) {
    childTasks.push(
      enqueueLinearUmbrellaChildTask(deps, {
        args: input.args,
        workflow,
        parentExternalRef: input.externalRef,
        parentTitle: input.title,
        parentUrl: input.url,
        child,
      }),
    );
  }

  return {
    umbrella_workflow_id: workflow.umbrella_workflow_id,
    external_ref: workflow.external_ref,
    repo_id: workflow.repo_id,
    base_branch: workflow.base_branch,
    feature_branch: workflow.feature_branch,
    expected_tasks: listUmbrellaExpectedTasks(
      enqueueDeps.db,
      workflow.umbrella_workflow_id,
    ),
    child_tasks: childTasks,
    linear_hierarchy: buildLinearHierarchySnapshot(input.hierarchy),
  };
}

async function buildLinearUmbrellaChildPlans(
  deps: EnqueueLinearIssueDeps,
  input: {
    parentExternalRef: string;
    repoId: string;
    baseBranch: string;
    hierarchy: LinearIssueHierarchy;
  },
): Promise<LinearUmbrellaChildPlan[]> {
  const plans: LinearUmbrellaChildPlan[] = [];
  const seen = new Set<string>();

  for (const child of input.hierarchy.children) {
    const childExternalRef = child.identifier.toUpperCase();
    if (seen.has(childExternalRef)) continue;
    seen.add(childExternalRef);

    const completeInLinear = isCompleteLinearState(child.stateType);
    let ctx: TicketContext | null = null;
    if (completeInLinear) {
      await fetchLinearIssueOnly(deps.linear, childExternalRef);
    } else {
      const fetched = await fetchTicketContextWithIssue(
        {
          linear: deps.linear,
          slack: deps.slack,
          config: deps.adaptersConfig,
        },
        childExternalRef,
      );
      const prepared = await ensureTicketTaskType(
        deps.linear,
        fetched.issue,
        fetched.ctx,
        fetched.ctx.tags,
      );
      ctx = prepared.ctx;
      validateUmbrellaChildContext(deps, {
        ctx,
        issue: prepared.issue,
        repoId: input.repoId,
        baseBranch: input.baseBranch,
        parentExternalRef: input.parentExternalRef,
        childExternalRef,
      });
    }

    plans.push({
      externalRef: childExternalRef,
      ctx,
      relations: await deps.linear.getBlockedByRelations(childExternalRef),
      completeInLinear,
    });
  }

  const completedChildren = new Set(
    plans
      .filter((plan) => plan.completeInLinear)
      .map((plan) => plan.externalRef),
  );
  return plans.map((plan) => ({
    ...plan,
    relations: markCompletedSameUmbrellaRelations(
      plan.relations,
      completedChildren,
    ),
  }));
}

async function fetchLinearIssueOnly(
  linear: LinearPort,
  identifier: string,
): Promise<LinearIssue> {
  let issue: LinearIssue | null;
  try {
    issue = await linear.getIssue(identifier);
  } catch (e) {
    if (e instanceof QuayError) throw e;
    throw new QuayError(
      "adapter_error",
      `Linear getIssue failed: ${(e as Error).message}`,
      { adapter: "linear", retryable: false },
    );
  }
  if (issue === null) {
    throw new QuayError(
      "ticket_not_found",
      `Linear issue ${identifier} not found`,
      { identifier },
    );
  }
  return issue;
}

function validateUmbrellaChildContext(
  deps: EnqueueLinearIssueDeps,
  input: {
    ctx: TicketContext;
    issue: LinearIssue;
    repoId: string;
    baseBranch: string;
    parentExternalRef: string;
    childExternalRef: string;
  },
): void {
  if (input.ctx.umbrella !== null) {
    throw new QuayError(
      "validation_error",
      "quay-config umbrella metadata is not supported for Linear-backed enqueue; use native Linear parent/child relations for umbrella membership and native Linear blocked-by relations for ordering",
      {
        parent_external_ref: input.parentExternalRef,
        child_external_ref: input.childExternalRef,
      },
    );
  }
  if (input.ctx.repo !== input.repoId) {
    throw new QuayError(
      "validation_error",
      `umbrella child ${input.childExternalRef} targets repo "${input.ctx.repo}", but parent ${input.parentExternalRef} targets repo "${input.repoId}"`,
      {
        parent_external_ref: input.parentExternalRef,
        child_external_ref: input.childExternalRef,
        parent_repo_id: input.repoId,
        child_repo_id: input.ctx.repo,
      },
    );
  }

  const childBaseBranch = input.ctx.base_branch ?? input.baseBranch;
  if (childBaseBranch !== input.baseBranch) {
    throw new QuayError(
      "validation_error",
      `umbrella child ${input.childExternalRef} targets base branch "${childBaseBranch}", but parent ${input.parentExternalRef} targets base branch "${input.baseBranch}"`,
      {
        parent_external_ref: input.parentExternalRef,
        child_external_ref: input.childExternalRef,
        parent_base_branch: input.baseBranch,
        child_base_branch: childBaseBranch,
      },
    );
  }

  const validation = deps.validatorRunner.run(
    buildValidatorPayload(
      input.ctx,
      input.issue,
      input.ctx.tags,
      childBaseBranch,
    ),
  );
  if (!validation.valid) {
    throw new QuayError(
      "validation_error",
      `umbrella child ${input.childExternalRef} failed quay-config validation`,
      {
        parent_external_ref: input.parentExternalRef,
        child_external_ref: input.childExternalRef,
        errors: validation.errors,
      },
    );
  }
}

function markCompletedSameUmbrellaRelations(
  relations: LinearBlockedByRelation[],
  completedChildren: Set<string>,
): LinearBlockedByRelation[] {
  return relations.map((relation) => {
    const blockerExternalRef = relation.blocker.identifier.toUpperCase();
    if (
      !completedChildren.has(blockerExternalRef) ||
      isCompleteLinearState(relation.blocker.stateType)
    ) {
      return relation;
    }
    return {
      ...relation,
      blocker: {
        ...relation.blocker,
        identifier: blockerExternalRef,
        stateType: "completed",
      },
    };
  });
}

function assertUmbrellaChildDependencyPreflight(
  db: DB,
  input: {
    repoId: string;
    childPlans: LinearUmbrellaChildPlan[];
  },
): void {
  const childRefs = new Set(input.childPlans.map((plan) => plan.externalRef));
  const missing: Array<{
    external_ref: string;
    repo_id: string;
    umbrella_external_ref?: string;
  }> = [];
  const seen = new Set<string>();

  for (const plan of input.childPlans) {
    if (plan.completeInLinear) continue;
    for (const relation of plan.relations) {
      const blockerExternalRef = relation.blocker.identifier.toUpperCase();
      if (childRefs.has(blockerExternalRef)) continue;
      if (isCompleteLinearState(relation.blocker.stateType)) continue;

      const blockerRepoId =
        repoIdFromBlockerBody(relation.blocker.body) ?? input.repoId;
      const key = `${blockerRepoId}\0${blockerExternalRef}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (lookupDependencyTask(db, blockerRepoId, blockerExternalRef) === null) {
        missing.push({
          external_ref: blockerExternalRef,
          repo_id: blockerRepoId,
        });
      }
    }
  }

  if (missing.length > 0) {
    throw new QuayError(
      "dependency_not_tracked",
      `Linear blocker ${missing[0]!.external_ref} is incomplete but not tracked by Quay`,
      { dependencies: missing },
    );
  }
}

function orderUmbrellaChildPlans(
  parentExternalRef: string,
  childPlans: LinearUmbrellaChildPlan[],
): LinearUmbrellaChildPlan[] {
  const activePlans = childPlans.filter((plan) => !plan.completeInLinear);
  const planByRef = new Map(activePlans.map((plan) => [plan.externalRef, plan]));
  const indegree = new Map(activePlans.map((plan) => [plan.externalRef, 0]));
  const dependents = new Map<string, string[]>();

  for (const plan of activePlans) {
    for (const relation of plan.relations) {
      const blockerExternalRef = relation.blocker.identifier.toUpperCase();
      if (!planByRef.has(blockerExternalRef)) continue;
      if (isCompleteLinearState(relation.blocker.stateType)) continue;
      indegree.set(plan.externalRef, (indegree.get(plan.externalRef) ?? 0) + 1);
      const refs = dependents.get(blockerExternalRef) ?? [];
      refs.push(plan.externalRef);
      dependents.set(blockerExternalRef, refs);
    }
  }

  const queue = activePlans
    .filter((plan) => (indegree.get(plan.externalRef) ?? 0) === 0)
    .map((plan) => plan.externalRef);
  const ordered: LinearUmbrellaChildPlan[] = [];

  while (queue.length > 0) {
    const nextRef = queue.shift()!;
    const nextPlan = planByRef.get(nextRef);
    if (nextPlan === undefined) continue;
    ordered.push(nextPlan);
    for (const dependentRef of dependents.get(nextRef) ?? []) {
      const nextIndegree = (indegree.get(dependentRef) ?? 0) - 1;
      indegree.set(dependentRef, nextIndegree);
      if (nextIndegree === 0) queue.push(dependentRef);
    }
  }

  if (ordered.length !== activePlans.length) {
    const cycleRefs = activePlans
      .filter((plan) => !ordered.includes(plan))
      .map((plan) => plan.externalRef);
    throw new QuayError(
      "umbrella_dependency_cycle",
      `same-umbrella dependency cycle detected for ${parentExternalRef}: ${cycleRefs.join(", ")}`,
      {
        parent_external_ref: parentExternalRef,
        child_external_refs: cycleRefs,
      },
    );
  }

  return ordered;
}

function enqueueLinearUmbrellaChildTask(
  deps: EnqueueLinearIssueDeps,
  input: {
    args: EnqueueLinearIssueArgs;
    workflow: UmbrellaWorkflowRow;
    parentExternalRef: string;
    parentTitle: string;
    parentUrl: string;
    child: LinearUmbrellaChildPlan;
  },
): LinearUmbrellaChildMaterialization {
  const ctx = input.child.ctx;
  if (ctx === null) {
    throw new Error(
      `cannot enqueue complete umbrella child ${input.child.externalRef}`,
    );
  }

  const existing = lookupReusableWorkItemRunWithBase(
    deps.enqueueDeps.db,
    input.workflow.repo_id,
    input.child.externalRef,
    { rerun: false, allowTerminalReuse: true },
  );
  if (existing !== null) {
    assertExistingUmbrellaChildBase(
      input.workflow,
      input.child.externalRef,
      existing,
    );
    ensureUmbrellaChildTaskLinked(deps.enqueueDeps.db, {
      workflow: input.workflow,
      taskId: existing.task_id,
      externalRef: input.child.externalRef,
      now: deps.enqueueDeps.clock.nowISO(),
    });
    return {
      external_ref: input.child.externalRef,
      complete_in_linear: false,
      task: toEnqueueResult(existing),
      reused_existing_task: true,
    };
  }

  const now = deps.enqueueDeps.clock.nowISO();
  const childHierarchy: LinearIssueHierarchy = {
    parent: {
      identifier: input.parentExternalRef,
      title: input.parentTitle,
      url: input.parentUrl,
      stateType: null,
    },
    children: [],
  };
  const dependencyResolution = resolveLinearDependencies(
    deps.enqueueDeps.db,
    input.child.relations,
    input.workflow.repo_id,
    now,
    { umbrellaWorkflow: input.workflow },
  );
  const ticketSnapshot = augmentTicketSnapshot(
    ctx.ticket_snapshot,
    dependencyResolution.snapshotRelations,
    childHierarchy,
  );

  try {
    return {
      external_ref: input.child.externalRef,
      complete_in_linear: false,
      task: enqueue(deps.enqueueDeps, {
        repo_id: input.workflow.repo_id,
        brief: ctx.brief,
        external_ref: ctx.external_ref,
        ticket_snapshot: ticketSnapshot,
        slack_thread_ref: ctx.slack_thread_ref,
        tags: ctx.tags,
        worker_execution: ctx.worker_execution,
        task_type: ctx.task_type,
        base_branch: input.workflow.feature_branch,
        umbrella: {
          external_ref: input.workflow.external_ref,
          base_branch: input.workflow.base_branch,
          feature_branch: input.workflow.feature_branch,
          expected_external_ref: input.child.externalRef,
          complete_without_quay:
            dependencyResolution.umbrellaCompletions.length === 0
              ? undefined
              : dependencyResolution.umbrellaCompletions,
        },
        request_pr_screenshots: input.args.requestPrScreenshots,
        require_pr_screenshots: input.args.requirePrScreenshots,
        dependencies: dependencyResolution.dependencies,
        authors_json: serializeAuthors(ctx.authors),
        worker_agent: input.args.workerAgent,
        worker_model: input.args.workerModel,
        reviewer_agent: input.args.reviewerAgent,
        reviewer_model: input.args.reviewerModel,
      }),
      reused_existing_task: false,
    };
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      const recovered = lookupReusableWorkItemRunWithBase(
        deps.enqueueDeps.db,
        input.workflow.repo_id,
        input.child.externalRef,
        { rerun: false, allowTerminalReuse: true },
      );
      if (recovered !== null) {
        assertExistingUmbrellaChildBase(
          input.workflow,
          input.child.externalRef,
          recovered,
        );
        ensureUmbrellaChildTaskLinked(deps.enqueueDeps.db, {
          workflow: input.workflow,
          taskId: recovered.task_id,
          externalRef: input.child.externalRef,
          now: deps.enqueueDeps.clock.nowISO(),
        });
        return {
          external_ref: input.child.externalRef,
          complete_in_linear: false,
          task: toEnqueueResult(recovered),
          reused_existing_task: true,
        };
      }
    }
    throw err;
  }
}

interface ExistingTaskWithBase extends EnqueueResult {
  base_branch: string;
}

const ACTIVE_TASK_SQL = `cancel_requested_at IS NULL AND state NOT IN (${TASK_TERMINAL_STATES.map(() => "?").join(", ")})`;

function lookupReusableWorkItemRunWithBase(
  db: DB,
  repoId: string,
  externalRef: string,
  options: { rerun: boolean; allowTerminalReuse?: boolean },
): ExistingTaskWithBase | null {
  if (options.allowTerminalReuse !== true) {
    assertNoTerminalReuse(db, repoId, externalRef, options);
  }
  const statePredicate =
    options.allowTerminalReuse === true ? "1 = 1" : ACTIVE_TASK_SQL;
  const params =
    options.allowTerminalReuse === true
      ? [repoId, externalRef] as [string, string]
      : [repoId, externalRef, ...TASK_TERMINAL_STATES] as [string, string, ...string[]];
  const row = db
    .query<ExistingTaskRow & { base_branch: string }, typeof params>(
      `SELECT task_id, state, branch_name, base_branch, tmux_id, worktree_path
         FROM tasks
        WHERE repo_id = ?
          AND external_ref = ?
          AND ${statePredicate}
        ORDER BY run_number DESC, created_at DESC, task_id DESC
        LIMIT 1`,
    )
    .get(...params);
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
    state: row.state as "queued",
    branch_name: row.branch_name,
    base_branch: row.base_branch,
    tmux_id: row.tmux_id,
    worktree_path: row.worktree_path,
    attempt_id: attempt?.attempt_id ?? 0,
  };
}

function toEnqueueResult(row: ExistingTaskWithBase): EnqueueResult {
  return {
    task_id: row.task_id,
    state: row.state,
    branch_name: row.branch_name,
    tmux_id: row.tmux_id,
    worktree_path: row.worktree_path,
    attempt_id: row.attempt_id,
  };
}

function assertExistingUmbrellaChildBase(
  workflow: UmbrellaWorkflowRow,
  externalRef: string,
  existing: ExistingTaskWithBase,
): void {
  if (existing.base_branch === workflow.feature_branch) return;
  throw new QuayError(
    "validation_error",
    `existing task for umbrella child ${externalRef} targets base branch "${existing.base_branch}", not umbrella feature branch "${workflow.feature_branch}"`,
    {
      umbrella_workflow_id: workflow.umbrella_workflow_id,
      parent_external_ref: workflow.external_ref,
      child_external_ref: externalRef,
      existing_task_id: existing.task_id,
      existing_base_branch: existing.base_branch,
      feature_branch: workflow.feature_branch,
    },
  );
}

function ensureUmbrellaChildTaskLinked(
  db: DB,
  input: {
    workflow: UmbrellaWorkflowRow;
    taskId: string;
    externalRef: string;
    now: string;
  },
): void {
  const exact = db
    .query<{ umbrella_task_id: number }, [number, string, string]>(
      `SELECT umbrella_task_id
         FROM umbrella_tasks
        WHERE umbrella_workflow_id = ?
          AND external_ref = ?
          AND task_id = ?
        LIMIT 1`,
    )
    .get(
      input.workflow.umbrella_workflow_id,
      input.externalRef,
      input.taskId,
    );
  if (exact == null) {
    const conflict = db
      .query<
        { umbrella_workflow_id: number; task_id: string; external_ref: string },
        [string, number, string]
      >(
        `SELECT umbrella_workflow_id, task_id, external_ref
           FROM umbrella_tasks
          WHERE task_id = ?
             OR (umbrella_workflow_id = ? AND external_ref = ?)
          LIMIT 1`,
      )
      .get(
        input.taskId,
        input.workflow.umbrella_workflow_id,
        input.externalRef,
      );
    if (conflict != null) {
      throw new QuayError(
        "validation_error",
        `existing task ${input.taskId} cannot be linked to umbrella child ${input.externalRef}`,
        {
          umbrella_workflow_id: input.workflow.umbrella_workflow_id,
          parent_external_ref: input.workflow.external_ref,
          child_external_ref: input.externalRef,
          task_id: input.taskId,
          conflicting_umbrella_workflow_id: conflict.umbrella_workflow_id,
          conflicting_external_ref: conflict.external_ref,
        },
      );
    }
    linkUmbrellaTask(db, {
      umbrellaWorkflowId: input.workflow.umbrella_workflow_id,
      taskId: input.taskId,
      externalRef: input.externalRef,
      now: input.now,
    });
  }

  markUmbrellaExpectedTaskLinked(db, {
    umbrellaWorkflowId: input.workflow.umbrella_workflow_id,
    externalRef: input.externalRef,
    now: input.now,
  });
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
  const missing: Array<{
    external_ref: string;
    repo_id: string;
    umbrella_external_ref?: string;
    umbrella_workflow_id?: number;
  }> = [];
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
      if (sameUmbrellaBlocker.task_id === null && completeInLinear) {
        snapshotRelations.push({
          relation_id: relation.relationId,
          blocker_identifier: blockerExternalRef,
          blocker_url: relation.blocker.url,
          blocker_title: relation.blocker.title,
          blocker_state_type: relation.blocker.stateType,
          blocker_repo_id: dependencyRepoId,
          complete_in_linear: completeInLinear,
          tracked_task_id: null,
          tracked_task_state: sameUmbrellaBlocker.task_state ?? null,
          persisted: false,
        });
        continue;
      }
      if (sameUmbrellaBlocker.task_id === null) {
        missing.push({
          external_ref: blockerExternalRef,
          repo_id: dependencyRepoId,
          umbrella_external_ref: umbrellaWorkflow!.external_ref,
          umbrella_workflow_id: umbrellaWorkflow!.umbrella_workflow_id,
        });
        continue;
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
        `SELECT task_id, state
           FROM tasks
          WHERE repo_id = ? AND external_ref = ?
          ORDER BY run_number DESC, created_at DESC, task_id DESC
          LIMIT 1`,
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
    task_type: ctx.task_type,
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

function formatLinearRunOutput(
  db: DB,
  result: EnqueueResult,
  reusedExistingTask: boolean,
): Record<string, unknown> {
  const row = db
    .query<
      { run_number: number | null; supersedes_task_id: string | null },
      [string]
    >(
      `SELECT run_number, supersedes_task_id
         FROM tasks
        WHERE task_id = ?`,
    )
    .get(result.task_id);
  return {
    ...result,
    reused_existing_task: reusedExistingTask,
    created_new_run: !reusedExistingTask,
    run_number: row?.run_number ?? null,
    supersedes_task_id: row?.supersedes_task_id ?? null,
  };
}

function lookupExistingTask(
  db: DB,
  repoId: string,
  externalRef: string,
): EnqueueResult | null {
  return lookupReusableWorkItemRun(db, repoId, externalRef, { rerun: false });
}

function lookupReusableWorkItemRun(
  db: DB,
  repoId: string,
  externalRef: string,
  options: { rerun: boolean; allowTerminalReuse?: boolean },
): EnqueueResult | null {
  if (options.allowTerminalReuse !== true) {
    assertNoTerminalReuse(db, repoId, externalRef, options);
  }
  const row = db
    .query<ExistingTaskRow, [string, string, ...string[]]>(
      `SELECT task_id, state, branch_name, tmux_id, worktree_path
         FROM tasks
        WHERE repo_id = ?
          AND external_ref = ?
          AND ${ACTIVE_TASK_SQL}
        ORDER BY run_number DESC, created_at DESC, task_id DESC
        LIMIT 1`,
    )
    .get(repoId, externalRef, ...TASK_TERMINAL_STATES);
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

interface LatestWorkItemRunRow {
  task_id: string;
  state: string;
  run_number: number | null;
}

function assertNoTerminalReuse(
  db: DB,
  repoId: string,
  externalRef: string,
  options: { rerun: boolean },
): void {
  const latest = db
    .query<LatestWorkItemRunRow, [string, string, string]>(
      `SELECT t.task_id, t.state, t.run_number
         FROM tasks t
         JOIN work_items wi ON wi.work_item_id = t.work_item_id
        WHERE t.repo_id = ?
          AND wi.source = 'linear'
          AND wi.repo_id = ?
          AND wi.external_ref = ?
        ORDER BY t.run_number DESC, t.created_at DESC, t.task_id DESC
        LIMIT 1`,
    )
    .get(repoId, repoId, externalRef);
  if (latest == null) {
    if (options.rerun) {
      throw new QuayError(
        "validation_error",
        `cannot rerun ${externalRef}; no existing work item run was found`,
        {
          repo_id: repoId,
          external_ref: externalRef,
        },
      );
    }
    return;
  }
  if (!TASK_TERMINAL_STATES.includes(latest.state as typeof TASK_TERMINAL_STATES[number])) {
    return;
  }
  if (options.rerun) return;
  const runNumber = latest.run_number ?? 1;
  throw new QuayError(
    "work_item_terminal",
    `latest run for ${externalRef} is terminal (${latest.state}); use quay rerun --linear-issue ${externalRef}`,
    {
      repo_id: repoId,
      external_ref: externalRef,
      last_task_id: latest.task_id,
      last_run_state: latest.state,
      last_run_number: runNumber,
      rerun_command: `quay rerun --linear-issue ${externalRef}`,
    },
  );
}

// Pre-fetch helper for the no-`--repo` path. Returns the repo_ids of every
// task currently bearing this external_ref. Multiple rows can exist after
// work-item reruns or across repos; 2+ repo candidates means the caller defers
// to a post-fetch check rather than guessing.
function lookupRepoIdsForExternalRef(
  db: DB,
  externalRef: string,
): string[] {
  return db
    .query<{ repo_id: string }, [string]>(
      `SELECT DISTINCT repo_id FROM tasks WHERE external_ref = ?`,
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
