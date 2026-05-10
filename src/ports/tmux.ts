// TmuxPort. Real implementation lives under src/adapters/ in slice 10.
//
// The real adapter writes <worktree>/.quay-prompt.md, runs tmux new-session,
// configures pane piping to <worktree>/.quay-session.log, and sends the
// agent invocation wrapped in `exec sh -c '...'` (per spec §12). Slice 4
// wires up isAlive/kill/collectLog for the dead-worker classifier and
// spawn-window recovery.
//
// `worktreePath` is threaded through `collectLog`/`logFreshness` because the
// log file lives at `<worktreePath>/.quay-session.log` and must be readable
// even AFTER the tmux session is gone (the classifier and the cancel
// finalizer both read it post-kill). Querying tmux for the session's start
// directory after the session has exited would be too late.
export interface TmuxSpawnInput {
  sessionName: string;
  worktreePath: string;
  promptContent: string;
  agentInvocation: string;
}

export interface TmuxPort {
  spawn(input: TmuxSpawnInput): void;
  isAlive(sessionName: string): boolean;
  kill(sessionName: string): void;
  // Best-effort: returns the buffered tmux pane log for the named session
  // (read from `<worktreePath>/.quay-session.log`), or null if no log is
  // available (session never logged, log file missing, etc). The classifier
  // persists the returned bytes as a `session_log` artifact.
  collectLog(sessionName: string, worktreePath: string): string | null;
  // Returns the latest log-write timestamp for a session. For a freshly
  // spawned worker that has not yet written log bytes, implementations
  // return spawned_at — that's the floor used by tick's stale-kill check.
  logFreshness(
    sessionName: string,
    worktreePath: string,
    spawnedAt: string,
  ): string;
  // Returns the OS-level exit observation for a worker whose pane has
  // died. The real adapter wraps the agent invocation so the worker's
  // shell writes its `$?` to `<worktreePath>/.quay-exit-code` before the
  // pane terminates; the value (a wait-style status that encodes
  // signaled exits as 128+signum) is read here. Both fields are null
  // when the file is absent, malformed, or never written (e.g. the
  // agent invocation `exec`'d itself, replacing the wrapper).
  getExitInfo(sessionName: string, worktreePath: string): PaneExitInfo;
}

export interface PaneExitInfo {
  exitCode: number | null;
  exitSignal: string | null;
}
