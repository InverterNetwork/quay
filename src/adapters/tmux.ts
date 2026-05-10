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
import { decodePaneStatus, EXIT_INFO_NONE } from "../core/exit_status.ts";
import type { PaneExitInfo, TmuxPort, TmuxSpawnInput } from "../ports/tmux.ts";

const PROMPT_FILE = ".quay-prompt.md";
const SESSION_LOG_FILE = ".quay-session.log";
// Tool-call trace produced by the agent's debug stream when the operator
// uses `--debug-file`. With the default agent invocation routing stdout
// to `.quay-usage.json` and debug output to this file, the pane log can
// stay empty for an entire run — so freshness must consider this file
// too or stale-kill fires on healthy long-running attempts.
const TOOL_TRACE_FILE = ".quay-tool-trace.log";
// Per-attempt exit-status marker written by the spawn wrapper. Holds the
// worker shell's `$?` as plain decimal text. Treated identically to
// other `.quay-*` files by the spawn preflight sweep.
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
    // Wrap the worker so the shell writes its terminal `$?` to
    // `<worktree>/.quay-exit-code` before the pane goes away. POSIX `$?`
    // for a child terminated by signal N is 128+N, so the single integer
    // captures both normal exits (0–127) and signaled exits (≥128); the
    // classifier decodes it. Two corner cases produce no marker file
    // (and thus a NULL/NULL row downstream): the agent_invocation uses
    // `exec` to replace the wrapper shell, or the wrapper itself is
    // killed before the trailing `printf` runs. We outer-`exec` into the
    // wrapper so the pane has a single shell process rather than two
    // nested ones — matching the prior session-exit semantics that
    // `has-session` liveness depends on.
    const exitCodeFile = join(input.worktreePath, EXIT_CODE_FILE);
    const wrapped = `${expanded}\nstatus=$?\nprintf '%d' "$status" > ${shellQuote(exitCodeFile)}\nexit "$status"`;
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

  getExitInfo(_sessionName: string, worktreePath: string): PaneExitInfo {
    // The spawn wrapper writes the worker shell's `$?` to
    // `<worktreePath>/.quay-exit-code` before the pane terminates. We
    // chose this over reading tmux's `#{pane_dead_status}` /
    // `#{pane_dead_signo}` formatters because tmux 3.6a on macOS
    // (and other versions) returns empty strings for signaled exits —
    // making native capture unreliable for the "killed by SIGKILL"
    // hypothesis the column exists to discriminate.
    const path = join(worktreePath, EXIT_CODE_FILE);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return EXIT_INFO_NONE;
    }
    const status = parseIntOrNull(raw);
    return decodePaneStatus(status, null);
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
    // The freshness signal is the maximum mtime across every observability
    // file the worker may be writing: the pane log captured by pipe-pane
    // and (since the default invocation pipes stdout/debug elsewhere) the
    // tool-trace file written by `--debug-file`. Without including the
    // trace, an attempt that produces only debug output stale-kills past
    // `staleness_threshold_seconds` even when actively making tool calls.
    // Empty / missing files contribute nothing; if no file has any bytes
    // yet, we fall back to spawned_at so the staleness window starts from
    // spawn rather than epoch.
    let freshestMs: number | null = null;
    for (const name of [SESSION_LOG_FILE, TOOL_TRACE_FILE]) {
      let stat;
      try {
        stat = statSync(join(worktreePath, name));
      } catch {
        continue;
      }
      if (stat.size === 0) continue;
      if (freshestMs === null || stat.mtimeMs > freshestMs) {
        freshestMs = stat.mtimeMs;
      }
    }
    if (freshestMs === null) return spawnedAt;
    return new Date(freshestMs).toISOString();
  }

}

// POSIX-shell single-quote escaping. Any single-quote in the input is closed,
// escaped with `'\''`, and reopened.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Parses a tmux format substitution into a number. Returns null for the
// empty string (older tmux that doesn't recognise the format key
// substitutes empty, not the literal `#{...}`) and for any non-numeric
// payload, so the decoder can treat "no observation" uniformly.
function parseIntOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!/^-?\d+$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 10);
}

// Files whose stale presence directly drives the bug the sweep exists to
// fix: `.quay-blocked.md` would be ingested as the new attempt's blocker;
// `.quay-session.log` would mix old bytes into the new attempt's log and
// skew the mtime-based freshness signal. A leftover `.quay-exit-code`
// would be misread as the current attempt's exit status — and in the
// exact silent-exit case the wrapper is built to diagnose, the wrapper
// never overwrites the file, so the previous attempt's `$?` would be
// stamped onto this attempt's `attempts.exit_code`/`exit_signal` columns
// and actively poison triage. Failing to remove any of these is treated as a hard
// spawn failure so the spawn-substrate-failed path takes over (same
// semantics as a `pipe-pane` failure) — silently proceeding would
// reintroduce the exact bugs this sweep prevents.
const SWEEP_FAIL_CLOSED = new Set([
  ".quay-blocked.md",
  ".quay-session.log",
  ".quay-exit-code",
]);

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
