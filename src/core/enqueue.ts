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
import { ensurePreambleIdForAttemptReason, loadPreambleBody } from "./preamble.ts";
import {
  composeWorkerPrompt,
  INITIAL_ATTEMPT_GUIDANCE,
} from "./worker_prompt.ts";
import {
  insertTaskGoal,
  parseWorkerExecution,
  type WorkerExecution,
} from "./goals.ts";

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
  })
  .strict();

export type EnqueueInput = z.infer<typeof enqueueInputSchema>;

export interface EnqueueResult {
  task_id: string;
  state: "queued";
  branch_name: string;
  tmux_id: string;
  worktree_path: string;
  attempt_id: number;
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

  const taskId = deps.ids.next();
  const effectiveBaseBranch = input.base_branch ?? repo.base_branch;
  const workerExecution: WorkerExecution = parseWorkerExecution(
    input.worker_execution,
  );
  const goalId = workerExecution === "goal" ? deps.ids.next() : null;
  const shortId = taskIdShort(taskId);
  const tmuxId = computeTmuxId(input.external_ref, shortId);
  const worktreePath = join(deps.paths.worktreesRoot, taskId);
  const retryBudget = deps.retryBudget ?? DEFAULT_RETRY_BUDGET;
  const agentSnapshot = resolveTaskAgentSnapshot(deps, repo.repo_id, {
    worker_agent: input.worker_agent ?? null,
    worker_model: input.worker_model ?? null,
    reviewer_agent: input.reviewer_agent ?? null,
    reviewer_model: input.reviewer_model ?? null,
  });

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
    const installResult = deps.commandRunner.run(repo.install_cmd, {
      cwd: worktreePath,
    });
    if (installResult.exitCode !== 0) {
      throw new QuayError(
        "bootstrap_failed",
        `install_cmd failed (exit ${installResult.exitCode}): ${installResult.stderr.trim()}`,
        {
          step: "install",
          exit_code: installResult.exitCode,
          stderr: installResult.stderr,
        },
      );
    }

    // Step 6: SQL transaction + artifact writes.
    const preambleId = ensurePreambleIdForAttemptReason(
      deps.db,
      deps.clock,
      "initial",
    );
    const preambleBody = loadPreambleBody(deps.db, preambleId);
    const now = deps.clock.nowISO();

    deps.db.exec("BEGIN");
    let attemptId = -1;
    try {
      deps.db
        .query(
          `INSERT INTO tasks (
             task_id, repo_id, external_ref, state, branch_name, base_branch, tmux_id, worktree_path,
             retry_budget, slack_thread_ref, authors_json, worker_execution,
             worker_agent, worker_model, reviewer_agent, reviewer_model,
             created_at, updated_at
           ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          taskId,
          repo.repo_id,
          input.external_ref ?? null,
          fullBranchName,
          effectiveBaseBranch,
          tmuxId,
          worktreePath,
          retryBudget,
          input.slack_thread_ref ?? null,
          input.authors_json ?? null,
          workerExecution,
          agentSnapshot.worker_agent,
          agentSnapshot.worker_model,
          agentSnapshot.reviewer_agent,
          agentSnapshot.reviewer_model,
          now,
          now,
        );

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
          [string, number, number, string, number, string | null]
        >(
          `INSERT INTO attempts (
             task_id, attempt_number, preamble_id, reason, consumed_budget, goal_id
           ) VALUES (?, ?, ?, ?, ?, ?)
           RETURNING attempt_id`,
        )
        .get(taskId, 1, preambleId, "initial", 1, goalId);
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
      state: "queued",
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

function resolveTaskAgentSnapshot(
  deps: EnqueueDeps,
  repoId: string,
  overrides: TaskAgentSnapshot,
): TaskAgentSnapshot {
  if (deps.agentResolver === undefined) return overrides;
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
): string {
  // Step 1: JS-side normalization per spec §13. Already covers most cases,
  // but the spec's step 7 requires the real `git check-ref-format` gate as
  // defense-in-depth in case the rules above and git's own grammar drift.
  const preferred = git.safeBranchSlug(
    computeBranchSlug(externalRef, shortId),
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
