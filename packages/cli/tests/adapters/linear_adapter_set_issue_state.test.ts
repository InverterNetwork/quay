// Real LinearAdapter tests for `setIssueState`. Drives the adapter against
// an injected synchronous transport — no network, no `LINEAR_API_KEY` env
// requirement, no child process. Pins:
//   - read-then-write call shape (issue refs query → team states query →
//     issueUpdate mutation)
//   - idempotent skip when the issue is already at the target state
//   - per-team workflow-state cache survives across calls
//   - per-issue local cache short-circuits repeat writes of the same state
//   - 404 on the issue refs read is a quiet no-op (ticket deleted upstream)
//   - 5xx / non-success mutation responses surface as `adapter_error`
//   - missing workflow-state name surfaces as `unknown_state`

import { afterEach, beforeEach, expect, test } from "bun:test";
import { QuayError } from "../../src/core/errors.ts";
import {
  LinearAdapter,
  type LinearTransport,
  type LinearTransportRequest,
  type LinearTransportResponse,
} from "../../src/adapters/linear.ts";

interface CapturedRequest extends LinearTransportRequest {
  parsedBody: { query: string; variables: Record<string, unknown> };
}

interface RecorderHandle {
  requests: CapturedRequest[];
  transport: LinearTransport;
}

function recorder(
  responder: (req: CapturedRequest) => LinearTransportResponse,
): RecorderHandle {
  const requests: CapturedRequest[] = [];
  const transport: LinearTransport = (req) => {
    const parsed = JSON.parse(req.body) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const captured: CapturedRequest = { ...req, parsedBody: parsed };
    requests.push(captured);
    return responder(captured);
  };
  return { requests, transport };
}

function jsonResponse(
  body: Record<string, unknown>,
  status = 200,
): LinearTransportResponse {
  return { status, headers: {}, body: JSON.stringify(body) };
}

// Convenience: route the captured request to the right canned response
// based on which query string fragment is present. The adapter sends three
// distinct documents (GetIssueStateRefs, GetTeamStates, UpdateIssueState),
// so a single mode-dispatch responder mirrors the production wire log.
type Mode = "refs" | "states" | "mutate";

function modeOf(req: CapturedRequest): Mode {
  const q = req.parsedBody.query;
  if (q.includes("GetIssueStateRefs")) return "refs";
  if (q.includes("GetTeamStates")) return "states";
  if (q.includes("UpdateIssueState")) return "mutate";
  throw new Error(`unrecognized query: ${q.slice(0, 60)}`);
}

let savedApiKey: string | undefined;
beforeEach(() => {
  savedApiKey = process.env.LINEAR_API_KEY;
});
afterEach(() => {
  if (savedApiKey === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = savedApiKey;
});

// Tests -----------------------------------------------------------------

test("test_linear_adapter_set_issue_state_happy_path", async () => {
  // Read returns "Triage" (state-id S_TRI); target is "In Progress" (S_IP).
  // Expectation: refs read → states read → issueUpdate mutation with
  // S_IP, with `success: true`.
  const handle = recorder((req) => {
    switch (modeOf(req)) {
      case "refs":
        return jsonResponse({
          data: {
            issue: {
              state: { id: "S_TRI", name: "Triage" },
              team: { id: "T_AST" },
            },
          },
        });
      case "states":
        return jsonResponse({
          data: {
            team: {
              states: {
                nodes: [
                  { id: "S_TRI", name: "Triage" },
                  { id: "S_IP", name: "In Progress" },
                  { id: "S_WAIT", name: "Waiting" },
                  { id: "S_CAN", name: "Canceled" },
                ],
              },
            },
          },
        });
      case "mutate":
        return jsonResponse({ data: { issueUpdate: { success: true } } });
    }
  });
  const adapter = new LinearAdapter({
    token: "test-token",
    transport: handle.transport,
  });

  await adapter.setIssueState("ENG-1234", "In Progress");

  expect(handle.requests).toHaveLength(3);
  expect(modeOf(handle.requests[0]!)).toBe("refs");
  expect(modeOf(handle.requests[1]!)).toBe("states");
  expect(modeOf(handle.requests[2]!)).toBe("mutate");
  expect(handle.requests[2]!.parsedBody.variables).toEqual({
    id: "ENG-1234",
    stateId: "S_IP",
  });
});

test("test_linear_adapter_set_issue_state_skips_when_already_at_target", async () => {
  // Read returns the same state we'd write. The adapter MUST skip the
  // mutation — that's the idempotency contract.
  const handle = recorder((req) => {
    switch (modeOf(req)) {
      case "refs":
        return jsonResponse({
          data: {
            issue: {
              state: { id: "S_IP", name: "In Progress" },
              team: { id: "T_AST" },
            },
          },
        });
      case "states":
        return jsonResponse({
          data: {
            team: {
              states: {
                nodes: [{ id: "S_IP", name: "In Progress" }],
              },
            },
          },
        });
      case "mutate":
        throw new Error("mutation must not run on idempotent-skip path");
    }
  });
  const adapter = new LinearAdapter({
    token: "test-token",
    transport: handle.transport,
  });

  await adapter.setIssueState("ENG-1234", "In Progress");

  const modes = handle.requests.map(modeOf);
  expect(modes).toEqual(["refs", "states"]);
});

test("test_linear_adapter_set_issue_state_short_circuits_repeat_writes", async () => {
  // A second write of the same target state on the same issue must skip
  // the entire read-then-write round-trip — that's the per-issue local
  // cache that protects spawn retries.
  const handle = recorder((req) => {
    switch (modeOf(req)) {
      case "refs":
        return jsonResponse({
          data: {
            issue: {
              state: { id: "S_TRI", name: "Triage" },
              team: { id: "T_AST" },
            },
          },
        });
      case "states":
        return jsonResponse({
          data: {
            team: {
              states: {
                nodes: [
                  { id: "S_TRI", name: "Triage" },
                  { id: "S_IP", name: "In Progress" },
                ],
              },
            },
          },
        });
      case "mutate":
        return jsonResponse({ data: { issueUpdate: { success: true } } });
    }
  });
  const adapter = new LinearAdapter({
    token: "test-token",
    transport: handle.transport,
  });

  await adapter.setIssueState("ENG-1234", "In Progress");
  const requestsAfterFirst = handle.requests.length;
  await adapter.setIssueState("ENG-1234", "In Progress");
  expect(handle.requests.length).toBe(requestsAfterFirst);
});

test("test_linear_adapter_set_issue_state_caches_team_states_across_calls", async () => {
  // Two consecutive calls against issues from the SAME team should issue
  // exactly one GetTeamStates query — the per-team cache is a fixed
  // process-lifetime contract.
  const handle = recorder((req) => {
    switch (modeOf(req)) {
      case "refs":
        return jsonResponse({
          data: {
            issue: {
              state: { id: "S_TRI", name: "Triage" },
              team: { id: "T_AST" },
            },
          },
        });
      case "states":
        return jsonResponse({
          data: {
            team: {
              states: {
                nodes: [
                  { id: "S_TRI", name: "Triage" },
                  { id: "S_IP", name: "In Progress" },
                ],
              },
            },
          },
        });
      case "mutate":
        return jsonResponse({ data: { issueUpdate: { success: true } } });
    }
  });
  const adapter = new LinearAdapter({
    token: "test-token",
    transport: handle.transport,
  });

  await adapter.setIssueState("ENG-1234", "In Progress");
  await adapter.setIssueState("AST-200", "In Progress");

  const stateModeCount = handle.requests.filter(
    (r) => modeOf(r) === "states",
  ).length;
  expect(stateModeCount).toBe(1);
});

test("test_linear_adapter_set_issue_state_unknown_state_throws_unknown_state", async () => {
  // The team's workflow states don't include the requested name. Surfaces
  // as `unknown_state` so the sync helper can downgrade to a warning.
  const handle = recorder((req) => {
    switch (modeOf(req)) {
      case "refs":
        return jsonResponse({
          data: {
            issue: {
              state: { id: "S_TRI", name: "Triage" },
              team: { id: "T_AST" },
            },
          },
        });
      case "states":
        return jsonResponse({
          data: {
            team: {
              states: {
                nodes: [{ id: "S_TRI", name: "Triage" }],
              },
            },
          },
        });
      case "mutate":
        throw new Error("mutation must not run when state name is unknown");
    }
  });
  const adapter = new LinearAdapter({
    token: "test-token",
    transport: handle.transport,
  });

  let caught: unknown;
  try {
    await adapter.setIssueState("ENG-1234", "In Progress");
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(QuayError);
  expect((caught as QuayError).code).toBe("unknown_state");
});

test("test_linear_adapter_set_issue_state_no_op_on_404", async () => {
  // The refs read returns 404 (ticket deleted on Linear's side). The
  // adapter returns silently — no team query, no mutation.
  const handle = recorder(() => ({
    status: 404,
    headers: {},
    body: "{}",
  }));
  const adapter = new LinearAdapter({
    token: "test-token",
    transport: handle.transport,
  });

  await adapter.setIssueState("ENG-1234", "In Progress");
  expect(handle.requests).toHaveLength(1);
  expect(modeOf(handle.requests[0]!)).toBe("refs");
});

test("test_linear_adapter_set_issue_state_5xx_on_mutation_throws_adapter_error", async () => {
  // A 5xx on the mutation must propagate as `adapter_error` so callers
  // (the sync helper) see a structured failure rather than a silent
  // success.
  const handle = recorder((req) => {
    switch (modeOf(req)) {
      case "refs":
        return jsonResponse({
          data: {
            issue: {
              state: { id: "S_TRI", name: "Triage" },
              team: { id: "T_AST" },
            },
          },
        });
      case "states":
        return jsonResponse({
          data: {
            team: {
              states: {
                nodes: [
                  { id: "S_TRI", name: "Triage" },
                  { id: "S_IP", name: "In Progress" },
                ],
              },
            },
          },
        });
      case "mutate":
        return { status: 502, headers: {}, body: "bad gateway" };
    }
  });
  const adapter = new LinearAdapter({
    token: "test-token",
    transport: handle.transport,
  });

  let caught: unknown;
  try {
    await adapter.setIssueState("ENG-1234", "In Progress");
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(QuayError);
  expect((caught as QuayError).code).toBe("adapter_error");
  expect((caught as QuayError).details?.adapter).toBe("linear");
});

test("test_linear_adapter_set_issue_state_mutation_returns_success_false_throws", async () => {
  // Linear's contract: `issueUpdate.success === false` means the mutation
  // didn't take effect. Surface as `adapter_error`.
  const handle = recorder((req) => {
    switch (modeOf(req)) {
      case "refs":
        return jsonResponse({
          data: {
            issue: {
              state: { id: "S_TRI", name: "Triage" },
              team: { id: "T_AST" },
            },
          },
        });
      case "states":
        return jsonResponse({
          data: {
            team: {
              states: {
                nodes: [
                  { id: "S_TRI", name: "Triage" },
                  { id: "S_IP", name: "In Progress" },
                ],
              },
            },
          },
        });
      case "mutate":
        return jsonResponse({ data: { issueUpdate: { success: false } } });
    }
  });
  const adapter = new LinearAdapter({
    token: "test-token",
    transport: handle.transport,
  });

  let caught: unknown;
  try {
    await adapter.setIssueState("ENG-1234", "In Progress");
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(QuayError);
  expect((caught as QuayError).code).toBe("adapter_error");
});
