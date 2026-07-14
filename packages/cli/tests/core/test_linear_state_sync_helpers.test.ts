// Focused unit tests for the Linear-sync infrastructure pieces:
//   - `pickLinearAdapter` gates on `adaptersConfig.linearEnabled` so
//     deployments with the adapter constructed but not opted-in stay
//     read-only.
//   - `LinearSyncQueue` schedules writebacks without awaiting (so the
//     supervisor lock isn't held for the Linear round-trip) but `drain()`
//     blocks until they're observable.
//   - `syncLinearState` dedupes stderr warnings per (identifier, stateName)
//     so a Linear outage doesn't flood the operator's log.

import { afterEach, expect, test } from "bun:test";
import { LinearSyncQueue, resetLinearSyncWarnings, syncLinearState } from "../../src/core/linear_state_sync.ts";
import { pickLinearAdapter } from "../../src/cli/dispatch.ts";
import { FakeLinearAdapter } from "../support/fakes/linear.ts";
import type { CliDeps } from "../../src/cli/dispatch.ts";

afterEach(() => {
  resetLinearSyncWarnings();
});

function depsWith(opts: {
  linear?: FakeLinearAdapter;
  linearEnabled?: boolean;
  slackEnabled?: boolean;
  withAdaptersConfig?: boolean;
}): CliDeps {
  // Only the fields pickLinearAdapter inspects are populated; the rest are
  // cast through `unknown` because the real CliDeps shape is huge and the
  // gate doesn't care.
  const partial: Partial<CliDeps> = {};
  if (opts.linear !== undefined) partial.linear = opts.linear;
  if (opts.withAdaptersConfig !== false) {
    partial.adaptersConfig = {
      linearEnabled: opts.linearEnabled === true,
      slackEnabled: opts.slackEnabled === true,
    };
  }
  return partial as CliDeps;
}

test("test_pick_linear_adapter_returns_port_when_enabled", () => {
  const fake = new FakeLinearAdapter();
  const deps = depsWith({ linear: fake, linearEnabled: true });
  expect(pickLinearAdapter(deps)).toBe(fake);
});

test("test_pick_linear_adapter_returns_undefined_when_disabled", () => {
  const fake = new FakeLinearAdapter();
  const deps = depsWith({ linear: fake, linearEnabled: false });
  expect(pickLinearAdapter(deps)).toBeUndefined();
});

test("test_pick_linear_adapter_returns_undefined_when_port_absent", () => {
  const deps = depsWith({ linearEnabled: true });
  expect(pickLinearAdapter(deps)).toBeUndefined();
});

test("test_pick_linear_adapter_returns_undefined_when_adapters_config_absent", () => {
  const fake = new FakeLinearAdapter();
  const deps = depsWith({ linear: fake, withAdaptersConfig: false });
  expect(pickLinearAdapter(deps)).toBeUndefined();
});

test("test_linear_sync_queue_drains_pending_writes", async () => {
  const fake = new FakeLinearAdapter();
  const queue = new LinearSyncQueue(fake);
  queue.enqueue("ENG-1", "In Progress");
  queue.enqueue("ENG-2", "Waiting");
  await queue.drain();
  expect(fake.setIssueStateCalls).toEqual([
    { identifier: "ENG-1", stateName: "In Progress" },
    { identifier: "ENG-2", stateName: "Waiting" },
  ]);
});

test("test_linear_sync_queue_does_not_block_on_enqueue", async () => {
  // The queue must start the HTTP round-trip immediately (so it overlaps
  // with the rest of the lock-held work) but `enqueue` itself returns
  // synchronously. We simulate slow Linear with a never-resolving promise
  // and observe that enqueue returns before the promise settles.
  let resolveSetState: () => void = () => undefined;
  const slowLinear = {
    async getIssue() {
      throw new Error("not used");
    },
    async getBlockedByRelations() {
      throw new Error("not used");
    },
    async getIssueHierarchy() {
      throw new Error("not used");
    },
    setIssueState: () => new Promise<void>((r) => (resolveSetState = r)),
    async updateIssueBody() {
      throw new Error("not used");
    },
  };
  const queue = new LinearSyncQueue(slowLinear);
  // Enqueue is sync — this line returns before `setIssueState` resolves.
  queue.enqueue("ENG-1", "In Progress");
  // drain() awaits, so resolve the underlying promise concurrently.
  const drained = queue.drain();
  resolveSetState();
  await drained;
});

test("test_linear_sync_queue_drains_empty_without_awaiting", async () => {
  const queue = new LinearSyncQueue(undefined);
  // An empty drain resolves immediately — no setIssueState was ever called.
  await queue.drain();
});

test("test_sync_linear_state_warns_once_per_identifier_state_pair", async () => {
  const fake = new FakeLinearAdapter();
  fake.failNextSetIssueState(new Error("Linear is down"));
  fake.failNextSetIssueState(new Error("Linear is down"));

  // Capture stderr writes for the duration of this test.
  const originalWrite = process.stderr.write.bind(process.stderr);
  const written: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    await syncLinearState(fake, "ENG-1", "In Progress");
    await syncLinearState(fake, "ENG-1", "In Progress");
  } finally {
    process.stderr.write = originalWrite;
  }

  const warnings = written.filter((w) => w.startsWith("[linear-sync]"));
  expect(warnings).toHaveLength(1);
});
