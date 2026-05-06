import { QuayError } from "../../../src/core/errors.ts";
import type {
  LinearIssue,
  LinearPort,
} from "../../../src/ports/linear.ts";

type FakeLinearState =
  | { kind: "issue"; issue: LinearIssue }
  | { kind: "draft" }
  | { kind: "5xx"; message?: string }
  | { kind: "429"; retryAfter: number | null };

export class FakeLinearAdapter implements LinearPort {
  getIssueCalls: string[] = [];

  private states = new Map<string, FakeLinearState>();

  // Test helpers --------------------------------------------------------

  // Configure a found issue. Identifier defaults to `issue.identifier`.
  setIssue(issue: LinearIssue, identifier?: string): void {
    const key = identifier ?? issue.identifier;
    this.states.set(key, { kind: "issue", issue });
  }

  // Identifiers without an explicit state default to "not found" → null.
  // This helper exists so tests reading like a script can opt in explicitly.
  setNotFound(identifier: string): void {
    this.states.delete(identifier);
  }

  setDraft(identifier: string): void {
    this.states.set(identifier, { kind: "draft" });
  }

  set5xx(identifier: string, message?: string): void {
    const state: FakeLinearState =
      message === undefined ? { kind: "5xx" } : { kind: "5xx", message };
    this.states.set(identifier, state);
  }

  set429(identifier: string, retryAfterSeconds: number | null): void {
    this.states.set(identifier, { kind: "429", retryAfter: retryAfterSeconds });
  }

  // Port impl -----------------------------------------------------------

  getIssue(identifier: string): LinearIssue | null {
    this.getIssueCalls.push(identifier);
    const state = this.states.get(identifier);
    if (!state) return null;
    switch (state.kind) {
      case "issue":
        return state.issue;
      case "draft":
        throw new QuayError(
          "ticket_not_actionable",
          `Linear issue ${identifier} is a draft`,
          { identifier },
        );
      case "5xx":
        throw new QuayError(
          "adapter_error",
          state.message ?? `Linear ${identifier}: 5xx from upstream`,
          { adapter: "linear", retryable: false },
        );
      case "429":
        throw new QuayError(
          "adapter_error",
          `Linear ${identifier}: rate-limited (429)`,
          {
            adapter: "linear",
            retryable: true,
            retry_after: state.retryAfter,
          },
        );
    }
  }
}
