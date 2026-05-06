export type QuayErrorCode =
  | "validation_error"
  | "duplicate_repo"
  | "unknown_repo"
  | "repo_archived"
  | "repo_has_active_tasks"
  | "branch_collision_unresolvable"
  | "bare_clone_missing"
  | "bootstrap_failed"
  | "ticket_block_invalid"
  | "ticket_not_actionable"
  | "ticket_not_found"
  | "adapter_not_enabled"
  | "adapter_not_configured"
  | "adapter_error";

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
