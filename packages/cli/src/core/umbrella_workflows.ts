import type { DB } from "../db/connection.ts";
import type { GitPort } from "../ports/git.ts";
import {
  computeBranchSlug,
  QUAY_BRANCH_PREFIX,
} from "./branch_slug.ts";
import { QuayError } from "./errors.ts";

export interface UmbrellaWorkflowInput {
  externalRef: string;
  baseBranch: string;
  featureBranch?: string | null;
}

export interface UmbrellaWorkflowRow {
  umbrella_workflow_id: number;
  external_ref: string;
  repo_id: string;
  base_branch: string;
  feature_branch: string;
  state: string;
  final_pr_task_id: string | null;
  final_pr_number: number | null;
  final_pr_url: string | null;
  created_at: string;
  updated_at: string;
}

export function deriveUmbrellaFeatureBranch(
  git: GitPort,
  externalRef: string,
): string {
  const slug = git.safeBranchSlug(
    `umbrella/${computeBranchSlug(externalRef, "umbrella")}`,
    "umbrella",
  );
  return `${QUAY_BRANCH_PREFIX}${slug}`;
}

export function createOrVerifyUmbrellaWorkflow(
  deps: { db: DB; git: GitPort },
  input: {
    repoId: string;
    externalRef: string;
    baseBranch: string;
    featureBranch?: string | null;
    now: string;
    ensureBranch?: boolean;
  },
): UmbrellaWorkflowRow {
  const featureBranch =
    input.featureBranch ?? deriveUmbrellaFeatureBranch(deps.git, input.externalRef);

  if (input.ensureBranch !== false) {
    deps.git.ensureRemoteBranchFromBase(
      input.repoId,
      featureBranch,
      input.baseBranch,
    );
  }

  const existing = lookupUmbrellaWorkflow(
    deps.db,
    input.repoId,
    input.externalRef,
  );
  if (existing !== null) {
    if (
      existing.base_branch !== input.baseBranch ||
      existing.feature_branch !== featureBranch
    ) {
      throw new QuayError(
        "umbrella_workflow_conflict",
        `umbrella workflow ${input.externalRef} already exists with different branch metadata`,
        {
          repo_id: input.repoId,
          external_ref: input.externalRef,
          existing_base_branch: existing.base_branch,
          requested_base_branch: input.baseBranch,
          existing_feature_branch: existing.feature_branch,
          requested_feature_branch: featureBranch,
        },
      );
    }
    return existing;
  }

  const row = deps.db
    .query<
      UmbrellaWorkflowRow,
      [string, string, string, string, string, string]
    >(
      `INSERT INTO umbrella_workflows (
         external_ref, repo_id, base_branch, feature_branch, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       RETURNING umbrella_workflow_id, external_ref, repo_id, base_branch,
                 feature_branch, state, final_pr_task_id, final_pr_number,
                 final_pr_url, created_at, updated_at`,
    )
    .get(
      input.externalRef,
      input.repoId,
      input.baseBranch,
      featureBranch,
      input.now,
      input.now,
    );
  if (!row) throw new Error("umbrella workflow insert returned no row");
  return row;
}

export function linkUmbrellaTask(
  db: DB,
  input: {
    umbrellaWorkflowId: number;
    taskId: string;
    externalRef: string;
    now: string;
  },
): void {
  db.query(
    `INSERT INTO umbrella_tasks (
       umbrella_workflow_id, task_id, external_ref, created_at
     ) VALUES (?, ?, ?, ?)`,
  ).run(
    input.umbrellaWorkflowId,
    input.taskId,
    input.externalRef,
    input.now,
  );
}

function lookupUmbrellaWorkflow(
  db: DB,
  repoId: string,
  externalRef: string,
): UmbrellaWorkflowRow | null {
  return (
    db
      .query<UmbrellaWorkflowRow, [string, string]>(
        `SELECT umbrella_workflow_id, external_ref, repo_id, base_branch,
                feature_branch, state, final_pr_task_id, final_pr_number,
                final_pr_url, created_at, updated_at
           FROM umbrella_workflows
          WHERE repo_id = ? AND external_ref = ?`,
      )
      .get(repoId, externalRef) ?? null
  );
}
