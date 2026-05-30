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

export const UMBRELLA_EXPECTED_TASK_STATES = [
  "expected",
  "linked",
  "complete_without_quay",
] as const;
export type UmbrellaExpectedTaskState =
  (typeof UMBRELLA_EXPECTED_TASK_STATES)[number];

export const UMBRELLA_EXPECTED_TASK_COMPLETION_SOURCES = [
  "linear",
  "manual",
] as const;
export type UmbrellaExpectedTaskCompletionSource =
  (typeof UMBRELLA_EXPECTED_TASK_COMPLETION_SOURCES)[number];

export interface UmbrellaExpectedTaskRow {
  umbrella_expected_task_id: number;
  umbrella_workflow_id: number;
  external_ref: string;
  title: string | null;
  linear_issue_id: string | null;
  linear_issue_url: string | null;
  state: UmbrellaExpectedTaskState;
  completion_source: UmbrellaExpectedTaskCompletionSource | null;
  completion_reason: string | null;
  completed_at: string | null;
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
    if (input.ensureBranch !== false) {
      requireUmbrellaFeatureBranchExists(deps, existing);
    }
    return existing;
  }

  if (input.ensureBranch !== false) {
    deps.git.ensureRemoteBranchFromBase(
      input.repoId,
      featureBranch,
      input.baseBranch,
    );
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

export function requireUmbrellaFeatureBranchExists(
  deps: { git: GitPort },
  workflow: Pick<
    UmbrellaWorkflowRow,
    "repo_id" | "external_ref" | "base_branch" | "feature_branch"
  >,
): void {
  if (deps.git.hasRemoteBranch(workflow.repo_id, workflow.feature_branch)) {
    return;
  }
  throw new QuayError(
    "umbrella_feature_branch_missing",
    `umbrella workflow ${workflow.external_ref} feature branch ${workflow.feature_branch} is missing in repo ${workflow.repo_id}`,
    {
      repo_id: workflow.repo_id,
      external_ref: workflow.external_ref,
      base_branch: workflow.base_branch,
      feature_branch: workflow.feature_branch,
    },
  );
}

export function assertUmbrellaWorkflowBranchMetadata(
  workflow: UmbrellaWorkflowRow,
  input: {
    repoId: string;
    externalRef: string;
    baseBranch: string;
    featureBranch: string;
  },
): void {
  if (
    workflow.base_branch === input.baseBranch &&
    workflow.feature_branch === input.featureBranch
  ) {
    return;
  }
  throw new QuayError(
    "umbrella_workflow_conflict",
    `umbrella workflow ${input.externalRef} already exists with different branch metadata`,
    {
      repo_id: input.repoId,
      external_ref: input.externalRef,
      existing_base_branch: workflow.base_branch,
      requested_base_branch: input.baseBranch,
      existing_feature_branch: workflow.feature_branch,
      requested_feature_branch: input.featureBranch,
    },
  );
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

export function upsertUmbrellaExpectedTask(
  db: DB,
  input: {
    umbrellaWorkflowId: number;
    externalRef: string;
    title?: string | null;
    linearIssueId?: string | null;
    linearIssueUrl?: string | null;
    now: string;
  },
): UmbrellaExpectedTaskRow {
  const row = db
    .query<
      UmbrellaExpectedTaskRow,
      [
        number,
        string,
        string | null,
        string | null,
        string | null,
        string,
        string,
      ]
    >(
      `INSERT INTO umbrella_expected_tasks (
         umbrella_workflow_id, external_ref, title, linear_issue_id,
         linear_issue_url, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(umbrella_workflow_id, external_ref) DO UPDATE SET
         title = COALESCE(excluded.title, umbrella_expected_tasks.title),
         linear_issue_id = COALESCE(
           excluded.linear_issue_id,
           umbrella_expected_tasks.linear_issue_id
         ),
         linear_issue_url = COALESCE(
           excluded.linear_issue_url,
           umbrella_expected_tasks.linear_issue_url
         ),
         updated_at = excluded.updated_at
       RETURNING umbrella_expected_task_id, umbrella_workflow_id, external_ref,
                 title, linear_issue_id, linear_issue_url, state,
                 completion_source, completion_reason, completed_at,
                 created_at, updated_at`,
    )
    .get(
      input.umbrellaWorkflowId,
      input.externalRef,
      input.title ?? null,
      input.linearIssueId ?? null,
      input.linearIssueUrl ?? null,
      input.now,
      input.now,
    );
  if (!row) throw new Error("umbrella expected task insert returned no row");
  return row;
}

export function markUmbrellaExpectedTaskLinked(
  db: DB,
  input: {
    umbrellaWorkflowId: number;
    externalRef: string;
    now: string;
  },
): UmbrellaExpectedTaskRow {
  const current = requireUmbrellaExpectedTask(db, input);
  if (current.state === "complete_without_quay") {
    throw new QuayError(
      "validation_error",
      `umbrella subtask ${input.externalRef} is already complete without Quay and cannot be linked`,
      {
        umbrella_workflow_id: input.umbrellaWorkflowId,
        external_ref: input.externalRef,
        state: current.state,
      },
    );
  }
  if (current.state === "linked") return current;

  const row = db
    .query<UmbrellaExpectedTaskRow, [string, number, string]>(
      `UPDATE umbrella_expected_tasks
          SET state = 'linked',
              completion_source = NULL,
              completion_reason = NULL,
              completed_at = NULL,
              updated_at = ?
        WHERE umbrella_workflow_id = ?
          AND external_ref = ?
        RETURNING umbrella_expected_task_id, umbrella_workflow_id, external_ref,
                  title, linear_issue_id, linear_issue_url, state,
                  completion_source, completion_reason, completed_at,
                  created_at, updated_at`,
    )
    .get(input.now, input.umbrellaWorkflowId, input.externalRef);
  if (!row) {
    throw new QuayError(
      "umbrella_subtask_not_expected",
      `umbrella workflow ${input.umbrellaWorkflowId} does not expect subtask ${input.externalRef}`,
      {
        umbrella_workflow_id: input.umbrellaWorkflowId,
        external_ref: input.externalRef,
      },
    );
  }
  return row;
}

export function markUmbrellaExpectedTaskCompleteWithoutQuay(
  db: DB,
  input: {
    umbrellaWorkflowId: number;
    externalRef: string;
    completionSource: UmbrellaExpectedTaskCompletionSource;
    completionReason?: string | null;
    completedAt: string;
    now: string;
  },
): UmbrellaExpectedTaskRow {
  const current = requireUmbrellaExpectedTask(db, input);
  if (current.state === "linked") {
    throw new QuayError(
      "validation_error",
      `umbrella subtask ${input.externalRef} is already linked to a Quay task and cannot be marked complete_without_quay`,
      {
        umbrella_workflow_id: input.umbrellaWorkflowId,
        external_ref: input.externalRef,
        state: current.state,
      },
    );
  }

  const row = db
    .query<
      UmbrellaExpectedTaskRow,
      [
        UmbrellaExpectedTaskCompletionSource,
        string | null,
        string,
        string,
        number,
        string,
      ]
    >(
      `UPDATE umbrella_expected_tasks
          SET state = 'complete_without_quay',
              completion_source = ?,
              completion_reason = ?,
              completed_at = ?,
              updated_at = ?
        WHERE umbrella_workflow_id = ?
          AND external_ref = ?
        RETURNING umbrella_expected_task_id, umbrella_workflow_id, external_ref,
                  title, linear_issue_id, linear_issue_url, state,
                  completion_source, completion_reason, completed_at,
                  created_at, updated_at`,
    )
    .get(
      input.completionSource,
      input.completionReason ?? null,
      input.completedAt,
      input.now,
      input.umbrellaWorkflowId,
      input.externalRef,
    );
  if (!row) {
    throw new QuayError(
      "umbrella_subtask_not_expected",
      `umbrella workflow ${input.umbrellaWorkflowId} does not expect subtask ${input.externalRef}`,
      {
        umbrella_workflow_id: input.umbrellaWorkflowId,
        external_ref: input.externalRef,
      },
    );
  }
  return row;
}

export function listUmbrellaExpectedTasks(
  db: DB,
  umbrellaWorkflowId: number,
): UmbrellaExpectedTaskRow[] {
  return db
    .query<UmbrellaExpectedTaskRow, [number]>(
      `SELECT umbrella_expected_task_id, umbrella_workflow_id, external_ref,
              title, linear_issue_id, linear_issue_url, state,
              completion_source, completion_reason, completed_at,
              created_at, updated_at
         FROM umbrella_expected_tasks
        WHERE umbrella_workflow_id = ?
        ORDER BY external_ref`,
    )
    .all(umbrellaWorkflowId);
}

export function requireUmbrellaExpectedTask(
  db: DB,
  input: {
    umbrellaWorkflowId: number;
    externalRef: string;
  },
): UmbrellaExpectedTaskRow {
  const row =
    db
      .query<UmbrellaExpectedTaskRow, [number, string]>(
        `SELECT umbrella_expected_task_id, umbrella_workflow_id, external_ref,
                title, linear_issue_id, linear_issue_url, state,
                completion_source, completion_reason, completed_at,
                created_at, updated_at
           FROM umbrella_expected_tasks
          WHERE umbrella_workflow_id = ?
            AND external_ref = ?`,
      )
      .get(input.umbrellaWorkflowId, input.externalRef) ?? null;
  if (row !== null) return row;
  throw new QuayError(
    "umbrella_subtask_not_expected",
    `umbrella workflow ${input.umbrellaWorkflowId} does not expect subtask ${input.externalRef}`,
    {
      umbrella_workflow_id: input.umbrellaWorkflowId,
      external_ref: input.externalRef,
    },
  );
}

export function lookupUmbrellaWorkflow(
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
