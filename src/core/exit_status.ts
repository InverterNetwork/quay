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

// POSIX signal numbers we expect to encounter from a worker process.
// Numbers follow the Linux/macOS POSIX layout where they overlap; the
// few divergent slots (SIGUSR1/2, SIGSTOP/TSTP) match on both. A signal
// we don't recognise renders as `SIG<n>` so the column is never NULL
// for an observed signaled exit.
const SIGNAL_NAMES: Record<number, string> = {
  1: "SIGHUP",
  2: "SIGINT",
  3: "SIGQUIT",
  4: "SIGILL",
  5: "SIGTRAP",
  6: "SIGABRT",
  7: "SIGBUS",
  8: "SIGFPE",
  9: "SIGKILL",
  10: "SIGUSR1",
  11: "SIGSEGV",
  12: "SIGUSR2",
  13: "SIGPIPE",
  14: "SIGALRM",
  15: "SIGTERM",
  17: "SIGCHLD",
  18: "SIGCONT",
  19: "SIGSTOP",
  20: "SIGTSTP",
  21: "SIGTTIN",
  22: "SIGTTOU",
  24: "SIGXCPU",
  25: "SIGXFSZ",
  26: "SIGVTALRM",
  27: "SIGPROF",
  28: "SIGWINCH",
  29: "SIGIO",
  30: "SIGPWR",
  31: "SIGSYS",
};

export function signalName(signo: number): string {
  return SIGNAL_NAMES[signo] ?? `SIG${signo}`;
}
