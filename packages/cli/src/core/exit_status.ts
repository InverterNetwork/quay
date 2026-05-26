// Per-attempt OS-level exit status capture. Translates the worker
// shell's `$?` (recorded into `<worktree>/.quay-exit-code` by the spawn
// wrapper) into the (exit_code, exit_signal) pair stored on the
// attempts row.
//
// POSIX shells set `$?` to the child's exit code for normal exits
// (0–127) and to 128+N when the child was terminated by signal N — so
// a single integer on disk distinguishes "exit 0" from "killed by
// SIGKILL" (137). The decoder also accepts a separate signal number,
// kept for forward compatibility with substrate adapters that surface
// it directly (e.g. tmux's `#{pane_dead_signo}` on platforms where it
// works); the shipped tmux adapter passes only the file's status and
// leaves the signo argument null.

import { constants } from "node:os";
import type { PaneExitInfo } from "../ports/tmux.ts";

export const EXIT_INFO_NONE: PaneExitInfo = {
  exitCode: null,
  exitSignal: null,
};

// Decode tmux's reported pane death numbers into our (code, signal) pair.
// Both inputs are accepted as `null` to model older-tmux / unreadable
// substitutions — the resulting pair stays NULL/NULL so callers know we
// did not observe the death.
export function decodePaneStatus(
  status: number | null,
  signo: number | null,
): PaneExitInfo {
  if (signo !== null && signo > 0) {
    return { exitCode: null, exitSignal: signalName(signo) };
  }
  if (status === null) return EXIT_INFO_NONE;
  // Shell convention: child terminated by signal N reports `$? = 128 + N`.
  // Older tmux relays this raw status; we apply the same decode so the
  // result is identical across versions.
  if (status >= 128 && status <= 128 + 64) {
    return { exitCode: null, exitSignal: signalName(status - 128) };
  }
  return { exitCode: status, exitSignal: null };
}

// Build a signal-number → canonical-name map from node's per-platform
// signal constants. macOS and Linux disagree on several slots (SIGBUS,
// SIGSYS, SIGCHLD, SIGUSR1/2, SIGPWR) — hardcoding the Linux values
// would produce wrong names for half of them on macOS, exactly the
// platform the wrapper-shell `128+N` capture path was designed for. A
// signal not present in the platform table renders as `SIG<n>` so the
// column is never NULL for an observed signaled exit.
const SIGNAL_NAMES: Record<number, string> = (() => {
  const map: Record<number, string> = {};
  for (const [name, num] of Object.entries(constants.signals)) {
    if (typeof num !== "number") continue;
    // First name wins — node's table is single-valued per number on each
    // platform we care about, so this only matters for synonymous slots
    // and the ordering in node's iteration is stable across releases.
    if (map[num] === undefined) map[num] = name;
  }
  return map;
})();

export function signalName(signo: number): string {
  return SIGNAL_NAMES[signo] ?? `SIG${signo}`;
}
