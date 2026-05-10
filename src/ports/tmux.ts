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

export interface ExitStatus {
  // Raw POSIX `$?` value (0–255). 0–127 is a normal exit code; 128+N
  // means "killed by signal N".
  rawStatus: number;
  // The agent's exit code, or null if the agent was killed by a signal.
  exitCode: number | null;
  // SIG<name> if killed by signal, else null.
  signalName: string | null;
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
  // Best-effort: returns the agent's exit status as captured by the
  // spawn wrapper into `<worktreePath>/.quay-exit-code`. Null when the
  // file is absent or unparseable — typically because the wrapper itself
  // was killed (whole pane reaped, tmux kill, OOM) before reaching the
  // post-agent step. Absence vs. presence is the discriminator the
  // silent-exit triage path needs.
  collectExitStatus(
    sessionName: string,
    worktreePath: string,
  ): ExitStatus | null;
}
