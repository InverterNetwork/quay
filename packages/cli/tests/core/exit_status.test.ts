import { expect, test } from "bun:test";
import { decodePaneStatus, signalName } from "../../src/core/exit_status.ts";

test("normal exit decodes status with no signal", () => {
  expect(decodePaneStatus(0, 0)).toEqual({ exitCode: 0, exitSignal: null });
  expect(decodePaneStatus(1, 0)).toEqual({ exitCode: 1, exitSignal: null });
  expect(decodePaneStatus(127, null)).toEqual({
    exitCode: 127,
    exitSignal: null,
  });
});

test("explicit signal number takes precedence over the status integer", () => {
  // Forward-compat path: a substrate that surfaces signo directly is
  // trusted over the wait-style status, which may be ambiguous (some
  // shells stash the agent's status before re-raising the signal).
  expect(decodePaneStatus(137, 9)).toEqual({
    exitCode: null,
    exitSignal: "SIGKILL",
  });
  expect(decodePaneStatus(130, 2)).toEqual({
    exitCode: null,
    exitSignal: "SIGINT",
  });
});

test("status ≥ 128 decodes as the corresponding signal", () => {
  // The wrapper writes the shell's `$?`, which is 128+N for a child
  // killed by signal N. This is the primary path used by the tmux
  // adapter today.
  expect(decodePaneStatus(137, null)).toEqual({
    exitCode: null,
    exitSignal: "SIGKILL",
  });
  expect(decodePaneStatus(130, null)).toEqual({
    exitCode: null,
    exitSignal: "SIGINT",
  });
  expect(decodePaneStatus(143, null)).toEqual({
    exitCode: null,
    exitSignal: "SIGTERM",
  });
});

test("signal numbers without a known name render as SIG<n>", () => {
  expect(signalName(99)).toBe("SIG99");
  expect(decodePaneStatus(null, 99)).toEqual({
    exitCode: null,
    exitSignal: "SIG99",
  });
});

test("returns NULL pair when status is unknown and signo is absent", () => {
  expect(decodePaneStatus(null, null)).toEqual({
    exitCode: null,
    exitSignal: null,
  });
  // Signo of 0 means "not signaled"; status null means "no observation".
  expect(decodePaneStatus(null, 0)).toEqual({
    exitCode: null,
    exitSignal: null,
  });
});
