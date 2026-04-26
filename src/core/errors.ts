export type QuayErrorCode =
  | "validation_error"
  | "duplicate_repo"
  | "unknown_repo"
  | "repo_archived";

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
