import { rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";
import type { CommandRunner } from "../ports/command_runner.ts";
import type { GitPort } from "../ports/git.ts";
import type { IdGenerator } from "../ports/id_generator.ts";
import {
  computeBranchSlug,
  computeTmuxId,
  QUAY_BRANCH_PREFIX,
  taskIdShort,
} from "./branch_slug.ts";
import { baseBranchNameSchema } from "./base_branch.ts";
import type { AgentResolver } from "./agents.ts";
import { QuayError } from "./errors.ts";
import { resolvePreambleForAttemptReason } from "./preamble.ts";
import {
  normalizeSlackThreadRef,
  normalizeStoredSlackThreadRef,
} from "./slack_thread_ref.ts";
import {
  composeWorkerPrompt,
  INITIAL_ATTEMPT_GUIDANCE,
} from "./worker_prompt.ts";
import {
  insertTaskGoal,
  parseWorkerExecution,
  type WorkerExecution,
} from "./goals.ts";
import {
  createTaskDependency,
  enqueueDependencyWaitingOutboxItem,
  TASK_DEPENDENCY_REQUIRED_STATES,
  TASK_DEPENDENCY_SCOPES,
  TASK_DEPENDENCY_SOURCES,
  type TaskDependencyRow,
  type TaskDependencyRequiredState,
  type TaskDependencyScope,
  type TaskDependencySource,
} from "./task_dependencies.ts";
import {
  assertUmbrellaWorkflowBranchMetadata,
  createOrVerifyUmbrellaWorkflow,
  deriveUmbrellaFeatureBranch,
  linkUmbrellaTask,
  lookupUmbrellaWorkflow,
  markUmbrellaExpectedTaskCompleteWithoutQuay,
  markUmbrellaExpectedTaskLinked,
  requireUmbrellaFeatureBranchExists,
  UMBRELLA_EXPECTED_TASK_COMPLETION_SOURCES,
} from "./umbrella_workflows.ts";
import { installWorktreeDependencies } from "./worktree_dependencies.ts";

export const DEFAULT_RETRY_BUDGET = 5;

export interface EnqueuePaths {
  reposRoot: string;
  worktreesRoot: string;
  artifactsRoot: string;
}

export interface EnqueueDeps {
  db: DB;
  clock: Clock;
  ids: IdGenerator;
  git: GitPort;
  commandRunner: CommandRunner;
  artifactStore: ArtifactStore;
  paths: EnqueuePaths;
  retryBudget?: number;
  agentResolver?: AgentResolver;
  referenceReposRoot?: string | undefined;
  retargetIntent?: {
    retargetedFromTaskId: string;
    sourceTaskId: string;
    cancelRequestedAt: string;
    activeAttemptId: number | null;
  };
}

export const enqueueInputSchema = z
  .object({
    repo_id: z.string().min(1),
    brief: z.string().min(1),
    external_ref: z.string().nullable().optional(),
    ticket_snapshot: z.string().nullable().optional(),
    slack_thread_ref: z.string().nullable().optional(),
    // Spec §5: one row per `tags:` entry from the quay-config block, deduped.
    // Legacy --brief-file callers omit this; new --linear-issue path forwards
    // the union of block + CLI --tag flags.
    tags: z.array(z.string()).optional(),
    // Spec §5: JSON-serialized TicketAuthor[]; nullable on the legacy path.
    authors_json: z.string().nullable().optional(),
    worker_agent: z.string().min(1).nullable().optional(),
    worker_model: z.string().min(1).nullable().optional(),
    reviewer_agent: z.string().min(1).nullable().optional(),
    reviewer_model: z.string().min(1).nullable().optional(),
    worker_execution: z.enum(["oneshot", "goal"]).optional(),
    base_branch: baseBranchNameSchema.optional(),
    request_pr_screenshots: z.boolean().optional(),
    require_pr_screenshots: z.boolean().optional(),
    dependencies: z
      .array(
        z
          .object({
            dependency_task_id: z.string().min(1).nullable().optional(),
            dependency_source: z.enum(TASK_DEPENDENCY_SOURCES),
            dependency_external_ref: z.string().min(1).nullable().optional(),
            dependency_repo_id: z.string().min(1).nullable().optional(),
            umbrella_workflow_id: z.number().int().positive().nullable().optional(),
            scope: z.enum(TASK_DEPENDENCY_SCOPES).optional(),
            required_state: z.enum(TASK_DEPENDENCY_REQUIRED_STATES).optional(),
            satisfied_at: z.string().min(1).nullable().optional(),
          })
          .strict()
          .refine(
            (dep) =>
              (dep.dependency_task_id !== null &&
                dep.dependency_task_id !== undefined) ||
              (dep.dependency_external_ref !== null &&
                dep.dependency_external_ref !== undefined),
            {
              message:
                "dependency_task_id or dependency_external_ref is required",
            },
          ),
      )
      .optional(),
    umbrella: z
      .object({
        external_ref: z.string().min(1),
        base_branch: baseBranchNameSchema.nullable().optional(),
        feature_branch: baseBranchNameSchema.nullable().optional(),
        expected_external_ref: z.string().min(1).nullable().optional(),
        complete_without_quay: z
          .array(
            z
              .object({
                external_ref: z.string().min(1),
                completion_source: z.enum(UMBRELLA_EXPECTED_TASK_COMPLETION_SOURCES),
                completion_reason: z.string().nullable().optional(),
                completed_at: z.string().min(1),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type EnqueueInput = z.infer<typeof enqueueInputSchema>;

export interface EnqueueResult {
  task_id: string;
  state: "queued" | "waiting_dependencies";
  branch_name: string;
  tmux_id: string;
  worktree_path: string;
  attempt_id: number;
}

export interface EnqueueResolvedDependency {
  dependency_task_id?: string | null;
  dependency_source: TaskDependencySource;
  dependency_external_ref?: string | null;
  dependency_repo_id?: string | null;
  umbrella_workflow_id?: number | null;
  scope?: TaskDependencyScope;
  required_state?: TaskDependencyRequiredState;
  satisfied_at?: string | null;
}

interface RepoRow {
  repo_id: string;
  repo_url: string;
  base_branch: string;
  install_cmd: string;
  archived_at: string | null;
}

interface TaskAgentSnapshot {
  worker_agent: string | null;
  worker_model: string | null;
  reviewer_agent: string | null;
  reviewer_model: string | null;
}

interface ResolvedTaskAgentSnapshot extends TaskAgentSnapshot {
  workerCapabilities: string[];
  reviewerCapabilities: string[];
}

export interface WorkItemRunIdentity {
  workItemId: string;
  runNumber: number;
  supersedesTaskId: string | null;
}

export function enqueue(deps: EnqueueDeps, rawInput: unknown): EnqueueResult {
  const input = parseInput(rawInput);

  const repo = lookupRepo(deps.db, input.repo_id);
  if (!repo) {
    throw new QuayError("unknown_repo", `repo "${input.repo_id}" not found`, {
      repo_id: input.repo_id,
    });
  }
  if (repo.archived_at !== null) {
    throw new QuayError(
      "repo_archived",
      `repo "${input.repo_id}" is archived; new tasks are rejected`,
      { repo_id: input.repo_id },
    );
  }

  let effectiveBaseBranch = input.base_branch ?? repo.base_branch;
  const prScreenshotsRequired = input.require_pr_screenshots === true;
  const prScreenshotsRequested =
    input.request_pr_screenshots === true || prScreenshotsRequired;
  const workerExecution: WorkerExecution = parseWorkerExecution(
    input.worker_execution,
  );
  const agentSnapshot = resolveTaskAgentSnapshot(deps, repo.repo_id, {
    worker_agent: input.worker_agent ?? null,
    worker_model: input.worker_model ?? null,
    reviewer_agent: input.reviewer_agent ?? null,
    reviewer_model: input.reviewer_model ?? null,
  });
  if (
    prScreenshotsRequired &&
    !agentSnapshot.workerCapabilities.includes("screenshots")
  ) {
    throw new QuayError(
      "missing_agent_capability",
      `--require-pr-screenshots requires worker agent "${agentSnapshot.worker_agent ?? "<unresolved>"}" to advertise capability "screenshots"`,
      {
        agent: agentSnapshot.worker_agent,
        capability: "screenshots",
        worker_capabilities: agentSnapshot.workerCapabilities,
      },
    );
  }

  const taskId = deps.ids.next();
  const goalId = workerExecution === "goal" ? deps.ids.next() : null;
  const shortId = taskIdShort(taskId);
  const tmuxId = computeTmuxId(input.external_ref, shortId);
  const worktreePath = join(deps.paths.worktreesRoot, taskId);
  const retryBudget = deps.retryBudget ?? DEFAULT_RETRY_BUDGET;
  const dependencies = input.dependencies ?? [];
  const slackThreadRef =
    deps.retargetIntent !== undefined
      ? normalizeStoredSlackThreadRef(input.slack_thread_ref)
      : normalizeSlackThreadRef(input.slack_thread_ref);
  const plannedRunNumber = lookupNextRunNumber(
    deps.db,
    repo.repo_id,
    input.external_ref ?? null,
  );
  const initialState =
    dependencies.some((dep) => dep.satisfied_at === null || dep.satisfied_at === undefined)
      ? "waiting_dependencies"
      : "queued";

  // Track substrate side effects so rollback knows what to undo.
  let worktreeCreated = false;
  let branchCreated = false;
  let fullBranchName: string | null = null;
  const writtenArtifactPaths: string[] = [];

  const rollback = () => {
    if (worktreeCreated) {
      try {
        deps.git.worktreeRemove(worktreePath);
      } catch {
        try {
          rmSync(worktreePath, { recursive: true, force: true });
        } catch {}
      }
    }
    if (branchCreated && fullBranchName !== null) {
      try {
        deps.git.branchDelete(repo.repo_id, fullBranchName);
      } catch {}
    }
    // Best-effort artifact file cleanup. SQL rollback removes the rows.
    try {
      rmSync(join(deps.paths.artifactsRoot, taskId), {
        recursive: true,
        force: true,
      });
    } catch {}
    for (const p of writtenArtifactPaths) {
      try {
        rmSync(p, { force: true });
      } catch {}
    }
  };

  try {
    // Step 1: validate bare clone exists. Quay is a pure consumer of bare
    // clones — materializing the clone is the operator's job. If it isn't
    // present, fail loudly with the expected path so the operator knows
    // exactly where to create it.
    if (!deps.git.bareCloneExists(repo.repo_id)) {
      const expectedPath = join(deps.paths.reposRoot, `${repo.repo_id}.git`);
      // Don't include the registered repo URL in the error: HTTPS remotes can
      // carry credentials/tokens in the URL, and this error is routinely
      // serialized to stderr / orchestrator logs. Operators can look the URL
      // up via `quay repo get <repo_id>` if they need it.
      throw new QuayError(
        "bare_clone_missing",
        `bare clone for repo "${repo.repo_id}" not found at ${expectedPath}; materialize it before enqueuing (e.g. \`git clone --bare <repo_url> ${expectedPath}\` — look up <repo_url> via \`quay repo get ${repo.repo_id}\`)`,
        { repo_id: repo.repo_id, expected_path: expectedPath },
      );
    }

    let resolvedUmbrella:
      | {
          externalRef: string;
          baseBranch: string;
          featureBranch: string;
          expectedExternalRef: string | null;
        }
      | null = null;
    let resolvedUmbrellaWorkflowId: number | null = null;
    if (input.umbrella !== undefined) {
      const umbrellaBaseBranch =
        input.umbrella.base_branch ?? effectiveBaseBranch;
      const umbrellaFeatureBranch =
        input.umbrella.feature_branch ??
        deriveUmbrellaFeatureBranch(deps.git, input.umbrella.external_ref);
      const existingUmbrella = lookupUmbrellaWorkflow(
        deps.db,
        repo.repo_id,
        input.umbrella.external_ref,
      );
      if (existingUmbrella === null) {
        deps.git.ensureRemoteBranchFromBase(
          repo.repo_id,
          umbrellaFeatureBranch,
          umbrellaBaseBranch,
        );
      } else {
        assertUmbrellaWorkflowBranchMetadata(existingUmbrella, {
          repoId: repo.repo_id,
          externalRef: input.umbrella.external_ref,
          baseBranch: umbrellaBaseBranch,
          featureBranch: umbrellaFeatureBranch,
        });
        requireUmbrellaFeatureBranchExists(deps, existingUmbrella);
      }
      resolvedUmbrella = {
        externalRef: input.umbrella.external_ref,
        baseBranch: umbrellaBaseBranch,
        featureBranch: umbrellaFeatureBranch,
        expectedExternalRef: input.umbrella.expected_external_ref ?? null,
      };
      effectiveBaseBranch = umbrellaFeatureBranch;
    }

    // Step 2: fetch the effective base branch. A task-level override does
    // not mutate the repo default; it is copied onto the task row below.
    deps.git.fetch(repo.repo_id, effectiveBaseBranch);

    // Step 3: branch resolution + collision check. Returns the bare slug;
    // the local/remote branch is `quay/<slug>` per spec §13. We carry the
    // full `quay/<slug>` form everywhere downstream — worktree-add, SQL,
    // rollback — so tick.ts (fetch / remoteHeadSha / PR check) and the
    // worker's eventual push all agree on the same ref.
    const resolvedSlug = resolveBranchName(
      deps.git,
      repo.repo_id,
      input.external_ref ?? null,
      shortId,
      plannedRunNumber,
    );
    fullBranchName = `${QUAY_BRANCH_PREFIX}${resolvedSlug}`;

    // Step 4: worktree add. This both creates the directory and registers the local branch.
    deps.git.worktreeAdd(
      repo.repo_id,
      worktreePath,
      fullBranchName,
      `origin/${effectiveBaseBranch}`,
    );
    worktreeCreated = true;
    branchCreated = true;

    // Step 5: install_cmd.
    installWorktreeDependencies(deps.commandRunner, repo, worktreePath);

    // Step 6: SQL transaction + artifact writes.
    const resolvedPreamble = resolvePreambleForAttemptReason(
      deps.db,
      deps.clock,
      "initial",
      { repoId: repo.repo_id },
    );
    const preambleId = resolvedPreamble.preambleId;
    const preambleBody = resolvedPreamble.body;
    const now = deps.clock.nowISO();

    deps.db.exec("BEGIN");
    let attemptId = -1;
    try {
      const runIdentity = ensureWorkItemRunIdentity(deps.db, {
        taskId,
        repoId: repo.repo_id,
        externalRef: input.external_ref ?? null,
        now,
      });

      if (deps.retargetIntent !== undefined) {
        deps.db
          .query(
            `UPDATE tasks
                SET cancel_requested_at = COALESCE(cancel_requested_at, ?),
                    cancel_close_pr = 0,
                    cancel_keep_worktree = 0,
                    tick_error = NULL,
                    updated_at = ?
              WHERE task_id = ?`,
          )
          .run(
            deps.retargetIntent.cancelRequestedAt,
            deps.retargetIntent.cancelRequestedAt,
            deps.retargetIntent.sourceTaskId,
          );
        if (deps.retargetIntent.activeAttemptId !== null) {
          deps.db
            .query(
              `UPDATE attempts SET kill_intent = 'cancel'
                WHERE attempt_id = ? AND kill_intent IS NULL`,
            )
            .run(deps.retargetIntent.activeAttemptId);
        }
      }

      deps.db
        .query(
          `INSERT INTO tasks (
             task_id, repo_id, external_ref, work_item_id, run_number,
             supersedes_task_id, state, branch_name, base_branch, tmux_id, worktree_path,
             retry_budget, slack_thread_ref, authors_json, worker_execution,
             pr_screenshots_requested, pr_screenshots_required,
             worker_agent, worker_model, reviewer_agent, reviewer_model,
             retargeted_from_task_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          taskId,
          repo.repo_id,
          input.external_ref ?? null,
          runIdentity.workItemId,
          runIdentity.runNumber,
          runIdentity.supersedesTaskId,
          initialState,
          fullBranchName,
          effectiveBaseBranch,
          tmuxId,
          worktreePath,
          retryBudget,
          slackThreadRef,
          input.authors_json ?? null,
          workerExecution,
          prScreenshotsRequested ? 1 : 0,
          prScreenshotsRequired ? 1 : 0,
          agentSnapshot.worker_agent,
          agentSnapshot.worker_model,
          agentSnapshot.reviewer_agent,
          agentSnapshot.reviewer_model,
          deps.retargetIntent?.retargetedFromTaskId ?? null,
          now,
          now,
        );

      if (resolvedUmbrella !== null) {
        const umbrellaWorkflow = createOrVerifyUmbrellaWorkflow(
          { db: deps.db, git: deps.git },
          {
            repoId: repo.repo_id,
            externalRef: resolvedUmbrella.externalRef,
            baseBranch: resolvedUmbrella.baseBranch,
            featureBranch: resolvedUmbrella.featureBranch,
            now,
            ensureBranch: false,
          },
        );
        resolvedUmbrellaWorkflowId = umbrellaWorkflow.umbrella_workflow_id;
        linkUmbrellaTask(deps.db, {
          umbrellaWorkflowId: umbrellaWorkflow.umbrella_workflow_id,
          taskId,
          externalRef: input.external_ref ?? taskId,
          now,
        });
        if (resolvedUmbrella.expectedExternalRef !== null) {
          markUmbrellaExpectedTaskLinked(deps.db, {
            umbrellaWorkflowId: umbrellaWorkflow.umbrella_workflow_id,
            externalRef: resolvedUmbrella.expectedExternalRef,
            now,
          });
        }
        for (const completed of input.umbrella?.complete_without_quay ?? []) {
          markUmbrellaExpectedTaskCompleteWithoutQuay(deps.db, {
            umbrellaWorkflowId: umbrellaWorkflow.umbrella_workflow_id,
            externalRef: completed.external_ref,
            completionSource: completed.completion_source,
            completionReason: completed.completion_reason ?? null,
            completedAt: completed.completed_at,
            now,
          });
        }
      }

      const createdDependencies: TaskDependencyRow[] = [];
      for (const dep of dependencies) {
        const dependencyInput: Parameters<typeof createTaskDependency>[1] = {
          dependentTaskId: taskId,
          dependencySource: dep.dependency_source,
          dependencyExternalRef: dep.dependency_external_ref ?? null,
          dependencyRepoId: dep.dependency_repo_id ?? null,
          umbrellaWorkflowId:
            dep.umbrella_workflow_id ??
            (dep.scope === "umbrella" ? resolvedUmbrellaWorkflowId : null),
          satisfiedAt: dep.satisfied_at ?? null,
          now,
        };
        if (dep.dependency_task_id !== undefined) {
          dependencyInput.dependencyTaskId = dep.dependency_task_id;
        }
        if (dep.scope !== undefined) dependencyInput.scope = dep.scope;
        if (dep.required_state !== undefined) {
          dependencyInput.requiredState = dep.required_state;
        }
        createdDependencies.push(createTaskDependency(deps.db, dependencyInput));
      }

      if (initialState === "waiting_dependencies") {
        const eventRow = deps.db
          .query<{ event_id: number }, [string, string, string]>(
            `INSERT INTO events (
               task_id, event_type, to_state, occurred_at, event_data
             ) VALUES (?, 'dependency_waiting', 'waiting_dependencies', ?, ?)
             RETURNING event_id`,
          )
          .get(
            taskId,
            now,
            JSON.stringify({ dependency_count: createdDependencies.length }),
          );
        if (!eventRow) throw new Error("dependency_waiting event insert returned no row");
        enqueueDependencyWaitingOutboxItem(
          { db: deps.db, clock: deps.clock },
          {
            taskId,
            sourceEventId: eventRow.event_id,
            dependencyCount: createdDependencies.length,
            dependencies: createdDependencies,
          },
        );
      }

      // Spec §8 step 5 / §12: task_tags rows land in the same transaction as
      // the tasks insert. Dedupe in JS (the spec already deduped inside the
      // adapter, but a cautious dedupe here keeps the invariant local).
      if (input.tags !== undefined && input.tags.length > 0) {
        const seen = new Set<string>();
        const insertTag = deps.db.query(
          `INSERT INTO task_tags (task_id, tag, created_at) VALUES (?, ?, ?)`,
        );
        for (const raw of input.tags) {
          if (seen.has(raw)) continue;
          seen.add(raw);
          insertTag.run(taskId, raw, now);
        }
      }

      const attemptRow = deps.db
        .query<
          { attempt_id: number },
          [string, number, number, number | null, string, number, string | null]
        >(
          `INSERT INTO attempts (
             task_id, attempt_number, preamble_id, repo_guidance_id, reason, consumed_budget, goal_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           RETURNING attempt_id`,
        )
        .get(taskId, 1, preambleId, resolvedPreamble.repoGuidanceId, "initial", 1, goalId);
      if (!attemptRow) throw new Error("attempt insert returned no row");
      attemptId = attemptRow.attempt_id;

      if (input.ticket_snapshot !== undefined && input.ticket_snapshot !== null) {
        const t = deps.artifactStore.writeArtifact({
          taskId,
          attemptId: null,
          kind: "ticket_snapshot",
          content: input.ticket_snapshot,
          extension: "md",
        });
        writtenArtifactPaths.push(t.filePath);
      }

      // Stable task objective: one task-level artifact that every later
      // code-worker attempt loads via loadOriginalTaskObjective().
      const objectiveArtifact = deps.artifactStore.writeArtifact({
        taskId,
        attemptId: null,
        kind: "task_objective",
        content: input.brief,
        extension: "md",
      });
      writtenArtifactPaths.push(objectiveArtifact.filePath);

      if (workerExecution === "goal") {
        if (goalId === null) throw new Error("goal_id missing for goal task");
        insertTaskGoal(deps.db, {
          taskId,
          goalId,
          objective: input.brief,
          createdAt: now,
        });
      }

      const composed = composeWorkerPrompt({
        preambleBody,
        taskObjective: {
          body: input.brief,
          artifactId: objectiveArtifact.artifactId,
          filePath: objectiveArtifact.filePath,
        },
        prBaseBranch: effectiveBaseBranch,
        prScreenshotsRequested,
        prScreenshotsRequired,
        referenceReposRoot: deps.referenceReposRoot,
        goalContext:
          workerExecution === "goal" && goalId !== null
            ? {
                goalId,
                status: "active",
                objective: input.brief,
                objectiveArtifactId: objectiveArtifact.artifactId,
                objectiveFilePath: objectiveArtifact.filePath,
                tokensUsed: 0,
                tokenBudget: null,
                timeUsedSeconds: 0,
              }
            : undefined,
        attemptGuidance: {
          reason: "initial",
          body: INITIAL_ATTEMPT_GUIDANCE,
        },
      });

      const briefArtifact = deps.artifactStore.writeArtifact({
        taskId,
        attemptId,
        kind: "brief",
        content: composed.brief,
        extension: "md",
      });
      writtenArtifactPaths.push(briefArtifact.filePath);

      const finalArtifact = deps.artifactStore.writeArtifact({
        taskId,
        attemptId,
        kind: "final_prompt",
        content: composed.finalPrompt,
        extension: "md",
      });
      writtenArtifactPaths.push(finalArtifact.filePath);

      deps.db.exec("COMMIT");
    } catch (err) {
      try {
        deps.db.exec("ROLLBACK");
      } catch {}
      throw err;
    }

    // The branch_name column carries the full `quay/<slug>` form.
    return {
      task_id: taskId,
      state: initialState,
      branch_name: fullBranchName,
      tmux_id: tmuxId,
      worktree_path: worktreePath,
      attempt_id: attemptId,
    };
  } catch (err) {
    rollback();
    throw err;
  }
}

export function ensureWorkItemRunIdentity(
  db: DB,
  input: {
    taskId: string;
    repoId: string;
    externalRef: string | null;
    now: string;
  },
): WorkItemRunIdentity {
  const source = input.externalRef === null ? "synthetic" : "linear";
  const externalRef = input.externalRef ?? input.taskId;
  const proposedWorkItemId = `wi:${input.taskId}`;

  db.query(
    `INSERT INTO work_items (
       work_item_id, source, repo_id, external_ref, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, repo_id, external_ref) DO UPDATE SET updated_at = excluded.updated_at`,
  ).run(
    proposedWorkItemId,
    source,
    input.repoId,
    externalRef,
    input.now,
    input.now,
  );

  const workItem = db
    .query<{ work_item_id: string }, [string, string, string]>(
      `SELECT work_item_id
         FROM work_items
        WHERE source = ? AND repo_id = ? AND external_ref = ?`,
    )
    .get(source, input.repoId, externalRef);
  if (!workItem) throw new Error("work item upsert returned no row");

  const lineage = db
    .query<{ run_number: number | null; task_id: string | null }, [string]>(
      `SELECT run_number, task_id
         FROM tasks
        WHERE work_item_id = ?
        ORDER BY run_number DESC, created_at DESC, task_id DESC
        LIMIT 1`,
    )
    .get(workItem.work_item_id);

  return {
    workItemId: workItem.work_item_id,
    runNumber: (lineage?.run_number ?? 0) + 1,
    supersedesTaskId: lineage?.task_id ?? null,
  };
}

function lookupNextRunNumber(
  db: DB,
  repoId: string,
  externalRef: string | null,
): number {
  if (externalRef === null) return 1;
  const row = db
    .query<{ run_number: number | null }, [string, string]>(
      `SELECT MAX(t.run_number) AS run_number
         FROM tasks t
         JOIN work_items wi ON wi.work_item_id = t.work_item_id
        WHERE wi.source = 'linear'
          AND wi.repo_id = ?
          AND wi.external_ref = ?`,
    )
    .get(repoId, externalRef);
  return (row?.run_number ?? 0) + 1;
}

function resolveTaskAgentSnapshot(
  deps: EnqueueDeps,
  repoId: string,
  overrides: TaskAgentSnapshot,
): ResolvedTaskAgentSnapshot {
  if (deps.agentResolver === undefined) {
    return {
      ...overrides,
      workerCapabilities: [],
      reviewerCapabilities: [],
    };
  }
  const worker = deps.agentResolver.resolve(repoId, "worker", {
    agent: overrides.worker_agent,
    model: overrides.worker_model,
  });
  const reviewer = deps.agentResolver.resolve(repoId, "reviewer", {
    agent: overrides.reviewer_agent,
    model: overrides.reviewer_model,
  });
  return {
    worker_agent: worker.agent,
    worker_model: worker.model,
    reviewer_agent: reviewer.agent,
    reviewer_model: reviewer.model,
    workerCapabilities: worker.capabilities,
    reviewerCapabilities: reviewer.capabilities,
  };
}

function parseInput(raw: unknown): EnqueueInput {
  const result = enqueueInputSchema.safeParse(raw);
  if (result.success) return result.data;
  const summary = result.error.issues
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("; ");
  throw new QuayError("validation_error", `enqueue input invalid: ${summary}`, {
    issues: result.error.issues,
  });
}

function lookupRepo(db: DB, repoId: string): RepoRow | null {
  return (
    db
      .query<RepoRow, [string]>(
        `SELECT repo_id, repo_url, base_branch, install_cmd, archived_at
           FROM repos WHERE repo_id = ?`,
      )
      .get(repoId) ?? null
  );
}

function isBranchTaken(git: GitPort, repoId: string, slug: string): boolean {
  const branch = `${QUAY_BRANCH_PREFIX}${slug}`;
  if (git.hasLocalBranch(repoId, branch)) return true;
  if (git.hasRemoteBranch(repoId, branch)) return true;
  if (git.hasOpenPullRequestForBranch(repoId, branch)) return true;
  return false;
}

function resolveBranchName(
  git: GitPort,
  repoId: string,
  externalRef: string | null,
  shortId: string,
  runNumber: number,
): string {
  // Step 1: JS-side normalization per spec §13. Already covers most cases,
  // but the spec's step 7 requires the real `git check-ref-format` gate as
  // defense-in-depth in case the rules above and git's own grammar drift.
  const baseSlug = computeBranchSlug(externalRef, shortId);
  const runSlug = runNumber <= 1 ? baseSlug : `${baseSlug}-r${runNumber}`;
  const preferred = git.safeBranchSlug(
    runSlug,
    shortId,
  );
  if (!isBranchTaken(git, repoId, preferred)) return preferred;
  // Step 2: collision suffix. Re-validate via the same gate — appending
  // `-<shortId>` cannot introduce ref-illegal chars (shortId is hex), but the
  // overall length might trip a check; safeBranchSlug is the single arbiter.
  const disambiguated = git.safeBranchSlug(`${preferred}-${shortId}`, shortId);
  if (!isBranchTaken(git, repoId, disambiguated)) return disambiguated;
  const branch = `${QUAY_BRANCH_PREFIX}${disambiguated}`;
  throw new QuayError(
    "branch_collision_unresolvable",
    `branch ${branch} is already taken`,
    { branch },
  );
}
