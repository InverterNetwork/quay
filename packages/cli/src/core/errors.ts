export type QuayErrorCode =
  | "validation_error"
  | "duplicate_repo"
  | "unknown_repo"
  | "repo_archived"
  | "repo_has_active_tasks"
  | "branch_collision_unresolvable"
  | "bare_clone_missing"
  | "bootstrap_failed"
  | "dependency_not_tracked"
  | "umbrella_not_enqueued"
  | "umbrella_workflow_conflict"
  | "umbrella_subtask_not_expected"
  | "missing_agent_capability"
  | "ticket_block_invalid"
  | "ticket_not_actionable"
  | "ticket_not_found"
  | "adapter_not_enabled"
  | "adapter_not_configured"
  | "adapter_error"
  | "stale_revision"
  | "unsupported_change"
  | "apply_failed"
  // Raised by the Linear adapter when the configured state-name map
  // references a workflow state that doesn't exist on the issue's team.
  // Caught upstream by `syncLinearState` and downgraded to a warning.
  | "unknown_state";

export class QuayError extends Error {
  override readonly name = "QuayError";
  constructor(
    readonly code: QuayErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
