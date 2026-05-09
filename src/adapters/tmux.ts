// Real Tmux adapter. Wraps `tmux new-session -d -s <session> 'exec sh -c
// "<agent_invocation>"'` so the tmux session disappears the moment the agent
// process exits, preserving liveness detection (spec §12).
//
// Prompt handling: `<worktree>/.quay-prompt.md` is written before spawn. The
// agent invocation is a template; `{prompt_file}` is replaced with the
// absolute path to the prompt file before being passed to the shell.
//
// Pane log capture: after `new-session`, the adapter runs
// `tmux pipe-pane -o "cat >> <worktree>/.quay-session.log"` (spec §12) so
// every byte the agent prints lands in a file the classifier and tick's
// stale check can read. The log file's mtime is the freshness signal: a
// worker that's actively producing output has a recent mtime; a hung worker
// (or one that died before tmux noticed) has an old mtime. Without this
// pipe, every long-running task gets stale-killed past the staleness
// threshold even when actively producing output.
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { TmuxPort, TmuxSpawnInput } from "../ports/tmux.ts";

const PROMPT_FILE = ".quay-prompt.md";
const SESSION_LOG_FILE = ".quay-session.log";
// Worker exit-code marker. The agent invocation is wrapped so the inner
// shell writes `$?` here after the agent exits and before the wrapper
// itself exits (which is what tears the pane down). Absence of this file
// after the session has died means the wrapper never reached the post-
// agent step — typically because the whole pane was killed by signal —
// which itself is signal worth surfacing.
const EXIT_CODE_FILE = ".quay-exit-code";
// Marker for direct children of the worktree root that belong to a previous
// Quay attempt. Anything matching this prefix is sweep-eligible at spawn
// time — see the spawn preflight for why.
const QUAY_STATE_PREFIX = ".quay-";
// Cap log artifact reads at a few MB so a runaway agent that never exits
// doesn't push gigabytes through the artifact store. The tail bias matches
// "what is the worker doing right now?" — the most recent output is what
// the classifier and operator care about.
const MAX_LOG_BYTES = 4 * 1024 * 1024;

export class TmuxAdapter implements TmuxPort {
  spawn(input: TmuxSpawnInput): void {
    // Spawn preflight: sweep direct children of the worktree whose names
    // start with `.quay-`. A leftover `.quay-blocked.md` from a previous
    // attempt would otherwise be ingested as the new attempt's blocker on
    // the next classifier read; a leftover `.quay-session.log` would mix
    // old bytes into the new attempt's log (and skew the freshness mtime
    // check, since we open the pipe-pane sink with `cat >>`). Scope is
    // tight — only direct children, only the `.quay-` prefix — so we never
    // touch anything the worker wrote under nested directories.
    sweepQuayState(input.worktreePath);

    const promptFile = join(input.worktreePath, PROMPT_FILE);
    writeFileSync(promptFile, input.promptContent);

    const expanded = input.agentInvocation.replaceAll(
      "{prompt_file}",
      shellQuote(promptFile),
    );
    // Wrap so the inner shell records the agent's exit status to
    // `<worktree>/.quay-exit-code` after the agent exits and before the
    // wrapper itself returns. The pane still dies once the wrapper
    // returns (`tmux has-session` liveness probe is preserved); the
    // small post-agent step adds milliseconds and converts an opaque
    // silent exit into a single-byte ground-truth artifact. POSIX `$?`
    // is the agent's literal exit status (0–255 for normal exit; 128+N
    // for signals) — adapter-side readers translate the 128+N range to
    // a signal name.
    //
    // `exec sh -c '...'` ensures only one wrapper shell is alive in the
    // pane at any time (tmux's outer sh exec's into our inner sh, which
    // runs the wrapped command and exits).
    const exitCodeFile = join(input.worktreePath, EXIT_CODE_FILE);
    const wrapped = `${expanded} ; printf %s "$?" > ${shellQuote(exitCodeFile)}`;
    const tmuxCommand = `exec sh -c ${shellQuote(wrapped)}`;

    // Step 1: create session with a placeholder command that keeps the
    // session alive while we wire pipe-pane. `cat` reads stdin (nobody is
    // typing in a detached session) and produces no output, so it stays
    // quiet until we respawn the pane in step 3.
    //
    // `env: process.env` is forwarded explicitly because Bun snapshots
    // env at startup. tmux populates the new session's environment from
    // its connecting client, so anything quay tick mints or refreshes at
    // runtime (GH_TOKEN, GITHUB_TOKEN, credential-helper sockets, etc.)
    // would otherwise be invisible to the agent — silent-exit territory.
    const result = Bun.spawnSync({
      cmd: [
        "tmux",
        "new-session",
        "-d",
        "-s",
        input.sessionName,
        "-c",
        input.worktreePath,
        "cat",
      ],
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(
        `tmux new-session for ${input.sessionName} failed (exit ${result.exitCode}): ${stderr.trim()}`,
      );
    }

    // Step 2: wire pipe-pane while the session is definitely alive.
    // Attaching the pipe before the agent starts means no agent output
    // escapes before the log sink is connected — this eliminates the
    // Linux race where a fast-exiting agent (Mode A) tears down the
    // server before pipe-pane attaches, and the race where the agent's
    // first printf lands before the pipe is wired (Mode B).
    //
    // The `-o` flag is the "open" side of the toggle. We target the
    // session's only pane with `<session>:<window>.<pane>` — the
    // canonical form for a freshly created `new-session -d`.
    const logPath = join(input.worktreePath, SESSION_LOG_FILE);
    const pipeCommand = `cat >> ${shellQuote(logPath)}`;
    const pipe = Bun.spawnSync({
      cmd: [
        "tmux",
        "pipe-pane",
        "-o",
        "-t",
        `${input.sessionName}:0.0`,
        pipeCommand,
      ],
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (pipe.exitCode !== 0) {
      // If pipe-pane fails the session exists but the freshness signal
      // that drives tick's stale-kill check would be lost. Surface this
      // as a hard spawn failure so the spawn-substrate-failed path takes
      // over.
      const stderr = new TextDecoder().decode(pipe.stderr);
      try {
        Bun.spawnSync({
          cmd: ["tmux", "kill-session", "-t", `=${input.sessionName}`],
          env: process.env,
          stdout: "ignore",
          stderr: "ignore",
        });
      } catch {}
      throw new Error(
        `tmux pipe-pane for ${input.sessionName} failed (exit ${pipe.exitCode}): ${stderr.trim()}`,
      );
    }

    // Step 3: replace the placeholder with the actual agent command.
    // `respawn-pane -k` kills the current process and starts a new one in
    // the same pane; the pipe-pane configuration is preserved on the pane
    // struct. When the agent exits, the pane and session die together —
    // keeping `tmux has-session` as a reliable liveness probe (spec §12).
    const launch = Bun.spawnSync({
      cmd: [
        "tmux",
        "respawn-pane",
        "-k",
        "-c",
        input.worktreePath,
        "-t",
        `${input.sessionName}:0.0`,
        tmuxCommand,
      ],
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (launch.exitCode !== 0) {
      const stderr = new TextDecoder().decode(launch.stderr);
      try {
        Bun.spawnSync({
          cmd: ["tmux", "kill-session", "-t", `=${input.sessionName}`],
          env: process.env,
          stdout: "ignore",
          stderr: "ignore",
        });
      } catch {}
      throw new Error(
        `tmux respawn-pane for ${input.sessionName} failed (exit ${launch.exitCode}): ${stderr.trim()}`,
      );
    }
  }

  isAlive(sessionName: string): boolean {
    const result = Bun.spawnSync({
      cmd: ["tmux", "has-session", "-t", `=${sessionName}`],
      env: process.env,
      stdout: "ignore",
      stderr: "ignore",
    });
    return result.exitCode === 0;
  }

  kill(sessionName: string): void {
    // Idempotent: kill-session against a non-existent session exits 1; we
    // don't care because the postcondition (session not alive) is met either
    // way.
    Bun.spawnSync({
      cmd: ["tmux", "kill-session", "-t", `=${sessionName}`],
      env: process.env,
      stdout: "ignore",
      stderr: "ignore",
    });
  }

  collectLog(_sessionName: string, worktreePath: string): string | null {
    // The pipe-pane configured at spawn writes every byte the agent prints
    // to <worktreePath>/.quay-session.log. Survives the session's death
    // (the file is independent of tmux state), so post-mortem classifier
    // and cancel-finalizer reads still work.
    const logPath = join(worktreePath, SESSION_LOG_FILE);
    if (!existsSync(logPath)) return null;
    let stat;
    try {
      stat = statSync(logPath);
    } catch {
      return null;
    }
    if (stat.size === 0) return null;
    try {
      if (stat.size <= MAX_LOG_BYTES) {
        return readFileSync(logPath, "utf8");
      }
      // Tail-read: bias toward the most recent output, which is what the
      // classifier and the operator actually want to see for "what was
      // this worker doing when it died?". `Bun.file().slice().arrayBuffer()`
      // returns a Promise, so calling it synchronously decoded as empty —
      // every >4MiB log was silently lost. Use Node's blocking
      // `openSync` + positional `readSync` instead.
      const fd = openSync(logPath, "r");
      try {
        const buf = Buffer.alloc(MAX_LOG_BYTES);
        const offset = stat.size - MAX_LOG_BYTES;
        let total = 0;
        while (total < MAX_LOG_BYTES) {
          const n = readSync(
            fd,
            buf,
            total,
            MAX_LOG_BYTES - total,
            offset + total,
          );
          if (n === 0) break;
          total += n;
        }
        return buf.subarray(0, total).toString("utf8");
      } finally {
        try {
          closeSync(fd);
        } catch {}
      }
    } catch {
      return null;
    }
  }

  logFreshness(
    _sessionName: string,
    worktreePath: string,
    spawnedAt: string,
  ): string {
    // The log mtime is the freshness signal: stale-kill fires when the
    // most recent output is older than `staleness_threshold_seconds`. For
    // a freshly spawned worker that hasn't written anything yet, no log
    // file exists; fall back to spawned_at so the freshness window starts
    // from spawn (not from epoch).
    const logPath = join(worktreePath, SESSION_LOG_FILE);
    let stat;
    try {
      stat = statSync(logPath);
    } catch {
      return spawnedAt;
    }
    // Empty log file (pipe-pane created it but nothing has been printed
    // yet): same case as "no log yet" — use spawned_at as the floor.
    if (stat.size === 0) return spawnedAt;
    return new Date(stat.mtimeMs).toISOString();
  }

  collectExitStatus(
    _sessionName: string,
    worktreePath: string,
  ): ExitStatus | null {
    // The spawn wrapper writes `$?` (the agent's exit status as the
    // shell saw it) to <worktreePath>/.quay-exit-code right before the
    // wrapper itself exits. Three cases at read time:
    //
    //   1. File present, parseable as 0–127 → clean exit with that code.
    //   2. File present, parseable as 128+N → the agent was killed by
    //      signal N. POSIX `$?` reports `128 + signum` for signaled
    //      children; we translate to a SIG<name> string.
    //   3. File absent or unparseable → return null. Absence typically
    //      means the *whole* pane was killed (cgroup reap, tmux kill,
    //      OOM) before the wrapper's post-agent step could run; the
    //      classifier surfaces that as no exit_status artifact, which
    //      itself discriminates "wrapper-observed exit" from "external
    //      kill" in triage.
    const path = join(worktreePath, EXIT_CODE_FILE);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8").trim();
    } catch {
      return null;
    }
    if (raw.length === 0) return null;
    const rawStatus = Number.parseInt(raw, 10);
    if (!Number.isFinite(rawStatus) || rawStatus < 0 || rawStatus > 255) {
      return null;
    }
    if (rawStatus >= 128 && rawStatus <= 128 + 64) {
      const signum = rawStatus - 128;
      return {
        rawStatus,
        exitCode: null,
        signalName: signalName(signum),
      };
    }
    return { rawStatus, exitCode: rawStatus, signalName: null };
  }
}

export interface ExitStatus {
  // Raw POSIX `$?` value (0–255). 0–127 is a normal exit code; 128+N
  // means "killed by signal N".
  rawStatus: number;
  // The agent's exit code, or null if the agent was killed by a signal.
  exitCode: number | null;
  // SIG<name> if killed by signal, else null. May be `SIG${signum}` if
  // the number is outside the lookup table (rare, but kept verbatim
  // rather than dropped so triage still has the raw integer).
  signalName: string | null;
}

// POSIX/Linux signal names. macOS overlaps for the common signals
// (SIGHUP/SIGINT/SIGQUIT/SIGILL/SIGTRAP/SIGABRT/SIGKILL/SIGSEGV/SIGPIPE/
// SIGALRM/SIGTERM); the few that diverge (SIGUSR1/2, SIGCHLD, SIGCONT,
// SIGSTOP, SIGTSTP) decode to their Linux meaning here, which matches
// the deployment target. For unknown numbers we return `SIG<n>` so the
// raw integer survives in triage.
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
  24: "SIGXCPU",
  25: "SIGXFSZ",
};

function signalName(signum: number): string {
  return SIGNAL_NAMES[signum] ?? `SIG${signum}`;
}

// POSIX-shell single-quote escaping. Any single-quote in the input is closed,
// escaped with `'\''`, and reopened.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Files whose stale presence directly drives the bug the sweep exists to
// fix: `.quay-blocked.md` would be ingested as the new attempt's blocker;
// `.quay-session.log` would mix old bytes into the new attempt's log and
// skew the mtime-based freshness signal. Failing to remove either of
// these is treated as a hard spawn failure so the spawn-substrate-failed
// path takes over (same semantics as a `pipe-pane` failure) — silently
// proceeding would reintroduce the exact bug this sweep prevents.
const SWEEP_FAIL_CLOSED = new Set([".quay-blocked.md", ".quay-session.log"]);

// Remove every direct child of `worktreePath` whose name starts with the
// `.quay-` prefix. The two files in `SWEEP_FAIL_CLOSED` are required
// removals (see comment above); other `.quay-*` entries are best-effort
// — a leftover forensic dump or future marker shouldn't refuse to spawn,
// since proceeding does not reintroduce the original bug for those.
//
// `readdirSync` failure (worktree missing / unreadable) returns early:
// the subsequent `writeFileSync(promptFile, ...)` will fail with the
// same root cause and produce a clearer error than this preflight could.
function sweepQuayState(worktreePath: string): void {
  let entries: string[];
  try {
    entries = readdirSync(worktreePath);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(QUAY_STATE_PREFIX)) continue;
    const path = join(worktreePath, name);
    try {
      // recursive+force in case a future feature drops a `.quay-*`
      // directory. For today's flat files, `force: true` makes us
      // idempotent against entries that were swept by a concurrent
      // process — those produce no error and are not mistaken for the
      // unremovable case below.
      rmSync(path, { recursive: true, force: true });
    } catch (err) {
      if (SWEEP_FAIL_CLOSED.has(name)) {
        throw new Error(
          `tmux spawn aborted: failed to sweep stale ${name} from ${worktreePath}: ${(err as Error).message}`,
        );
      }
      // Non-critical leak — continue sweeping siblings.
    }
  }
}
