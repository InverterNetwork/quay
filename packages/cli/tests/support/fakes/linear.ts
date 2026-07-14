import { QuayError } from "../../../src/core/errors.ts";
import type {
  LinearBlockedByRelation,
  LinearIssueHierarchy,
  LinearIssue,
  LinearPort,
} from "../../../src/ports/linear.ts";

type FakeLinearState =
  | { kind: "issue"; issue: LinearIssue }
  | { kind: "draft" }
  | { kind: "5xx"; message?: string }
  | { kind: "429"; retryAfter: number | null };

export interface FakeLinearStateChange {
  identifier: string;
  stateName: string;
}

export interface FakeLinearBodyUpdate {
  identifier: string;
  body: string;
}

export class FakeLinearAdapter implements LinearPort {
  getIssueCalls: string[] = [];
  getBlockedByRelationsCalls: string[] = [];
  getIssueHierarchyCalls: string[] = [];
  // Every accepted, non-idempotent setIssueState call lands here in arrival
  // order so tests can assert on the writeback shape AND the absence of
  // duplicate writes when idempotency should have suppressed the call.
  setIssueStateCalls: FakeLinearStateChange[] = [];
  updateIssueBodyCalls: FakeLinearBodyUpdate[] = [];

  private states = new Map<string, FakeLinearState>();
  private blockedByRelations = new Map<string, LinearBlockedByRelation[]>();
  private issueHierarchies = new Map<string, LinearIssueHierarchy>();
  // Tracks the "current Linear state" the fake reports for an identifier.
  // Drives idempotency: a `setIssueState` call whose stateName matches the
  // current value records nothing on `setIssueStateCalls` (skip), mirroring
  // the real adapter's read-before-write behaviour.
  private currentStates = new Map<string, string>();
  // Errors queued via `failNextSetIssueState` are consumed in FIFO order;
  // calls past the queued count succeed normally. A queue (vs. a single
  // field) so two failures-in-a-row stay observable rather than silently
  // collapsing into one.
  private setIssueStateErrors: Error[] = [];

  // Test helpers --------------------------------------------------------

  // Configure a found issue. Identifier defaults to `issue.identifier`.
  setIssue(issue: LinearIssue, identifier?: string): void {
    const key = identifier ?? issue.identifier;
    this.states.set(key, { kind: "issue", issue });
  }

  setBlockedByRelations(
    identifier: string,
    relations: LinearBlockedByRelation[],
  ): void {
    this.blockedByRelations.set(identifier, relations);
  }

  setIssueHierarchy(identifier: string, hierarchy: LinearIssueHierarchy): void {
    this.issueHierarchies.set(identifier, hierarchy);
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

  // Seed the fake's view of an issue's current Linear workflow state. Tests
  // that exercise the idempotent-skip branch call this with the same name
  // they later pass to setIssueState.
  setCurrentState(identifier: string, stateName: string): void {
    this.currentStates.set(identifier, stateName);
  }

  // Queue an error to throw on the next `setIssueState` call. Lets tests
  // pin the best-effort warn-and-continue contract without piggybacking on
  // the `getIssue` error states (which would also poison reads).
  failNextSetIssueState(err: Error): void {
    this.setIssueStateErrors.push(err);
  }

  // Drop the recorded setIssueState log; useful between phases of a
  // multi-step test (e.g. seed the fake state, ignore the setup writes,
  // then assert on the writes from the step under test).
  resetSetIssueStateCalls(): void {
    this.setIssueStateCalls.length = 0;
  }

  // Port impl -----------------------------------------------------------

  async getIssue(identifier: string): Promise<LinearIssue | null> {
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

  async getBlockedByRelations(
    identifier: string,
  ): Promise<LinearBlockedByRelation[]> {
    this.getBlockedByRelationsCalls.push(identifier);
    return this.blockedByRelations.get(identifier) ?? [];
  }

  async getIssueHierarchy(identifier: string): Promise<LinearIssueHierarchy> {
    this.getIssueHierarchyCalls.push(identifier);
    return this.issueHierarchies.get(identifier) ?? {
      parent: null,
      children: [],
    };
  }

  async setIssueState(identifier: string, stateName: string): Promise<void> {
    const queuedError = this.setIssueStateErrors.shift();
    if (queuedError !== undefined) throw queuedError;
    const current = this.currentStates.get(identifier);
    if (current === stateName) return;
    this.currentStates.set(identifier, stateName);
    this.setIssueStateCalls.push({ identifier, stateName });
  }

  async updateIssueBody(identifier: string, body: string): Promise<void> {
    this.updateIssueBodyCalls.push({ identifier, body });
    const state = this.states.get(identifier);
    if (state?.kind === "issue") {
      this.states.set(identifier, {
        kind: "issue",
        issue: { ...state.issue, body },
      });
    }
  }
}
