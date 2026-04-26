// Slice 3 TmuxPort. Real implementation lives under src/adapters/ in slice 10.
//
// The real adapter writes <worktree>/.quay-prompt.md, runs tmux new-session,
// configures pane piping, and sends the agent invocation wrapped in
// `exec sh -c '...'` (per spec §12). For Slice 3 only `spawn` must be
// functional; `isAlive` and `kill` are stubbed in fakes pending Slice 4.
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
}
