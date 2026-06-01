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
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { decodePaneStatus, EXIT_INFO_NONE } from "../core/exit_status.ts";
import type { PaneExitInfo, TmuxPort, TmuxSpawnInput } from "../ports/tmux.ts";

const PROMPT_FILE = ".quay-prompt.md";
const SESSION_LOG_FILE = ".quay-session.log";
const SPAWN_ADMIN_DIR = ".quay-spawn";
const CODEX_SOURCE_HOME_ENV = "QUAY_CODEX_SOURCE_HOME";
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
    const tmuxEnv = buildSpawnEnv(input.env);
    prepareCodexHome(tmuxEnv);
    installGhWrapperIfTokened(input, tmuxEnv);
    const paneEnvPrefix = buildPaneEnvPrefix(input, tmuxEnv);

    const promptFile = join(input.worktreePath, PROMPT_FILE);
    writeFileSync(promptFile, input.promptContent);

    const expanded = input.agentInvocation.replaceAll(
      "{prompt_file}",
      shellQuote(promptFile),
    );
    // Pane-local env loaders: for each requested env file, `$(cat <path>)`
    // strips trailing newlines naturally, so a token file written as
    // `printf "%s\n" "$tok" > $f` round-trips cleanly. We refuse to
    // proceed with an empty value because exporting `GH_TOKEN=""` would
    // turn into a confusing `gh: not authenticated` instead of a clear
    // operator-facing error in the pane log.
    const envFilePrefix = buildEnvFilePrefix(input.envFiles);
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
    const wrapped = `${paneEnvPrefix}${envFilePrefix}${expanded}\nstatus=$?\nprintf '%d' "$status" > ${shellQuote(exitCodeFile)}\nexit "$status"`;
    const tmuxCommand = `exec sh -c ${shellQuote(wrapped)}`;

    // Step 1: create session with a placeholder command that keeps the
    // session alive while we wire pipe-pane. `cat` reads stdin (nobody is
    // typing in a detached session) and produces no output, so it stays
    // quiet until we respawn the pane in step 3.
    //
    // The current process env plus per-spawn overrides are forwarded
    // explicitly because Bun snapshots env at startup. tmux populates the
    // new session's environment from its connecting client, so anything
    // quay tick mints or refreshes at runtime (GH_TOKEN, GITHUB_TOKEN,
    // credential-helper sockets, etc.) would otherwise be invisible to the
    // agent — silent-exit territory.
    //
    // Per-spawn secrets are NOT injected via `-e KEY=VAL` here: tmux argv
    // is observable on the host (`ps`) for the lifetime of the spawn, so
    // any token value placed there could be read by an unrelated user
    // before the spawn returns. `envFiles` instead embeds a `cat <path>`
    // into the pane wrapper (built above), so only the path lands in
    // argv — never the secret value.
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
      env: tmuxEnv,
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
      env: tmuxEnv,
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
          env: tmuxEnv,
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
      env: tmuxEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (launch.exitCode !== 0) {
      const stderr = new TextDecoder().decode(launch.stderr);
      try {
        Bun.spawnSync({
          cmd: ["tmux", "kill-session", "-t", `=${input.sessionName}`],
          env: tmuxEnv,
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

function buildSpawnEnv(
  overrides: Record<string, string | undefined> | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (overrides === undefined) return env;
  for (const [name, value] of Object.entries(overrides)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      throw new Error(
        `tmux env: name ${JSON.stringify(name)} is not a valid POSIX env var`,
      );
    }
    if (value === undefined) {
      delete env[name];
    } else {
      env[name] = value;
    }
  }
  return env;
}

function buildPaneEnvPrefix(
  input: TmuxSpawnInput,
  env: NodeJS.ProcessEnv,
): string {
  const adminDir = spawnAdminDir(input);
  mkdirSync(adminDir, { recursive: true, mode: 0o700 });
  chmodSync(adminDir, 0o700);
  const envPath = join(adminDir, "pane-env.sh");
  const lines = [
    "# sourced by Quay's tmux pane wrapper",
    "unset GH_TOKEN GITHUB_TOKEN QUAY_WORKER_GH_TOKEN QUAY_REVIEWER_GH_TOKEN",
  ];
  for (const [name, value] of Object.entries(env).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) continue;
    if (
      name === "GH_TOKEN" ||
      name === "GITHUB_TOKEN" ||
      name === "QUAY_WORKER_GH_TOKEN" ||
      name === "QUAY_REVIEWER_GH_TOKEN"
    ) {
      continue;
    }
    if (value === undefined) continue;
    lines.push(`export ${name}=${shellQuote(value)}`);
  }
  const tokenFile = resolveGhTokenFile(input, env);
  const hasGhTokenEnvFile =
    input.envFiles?.some((entry) => entry.name === "GH_TOKEN") === true;
  if (tokenFile !== null && !hasGhTokenEnvFile) {
    lines.push(`token="$(cat ${shellQuote(tokenFile)})"`);
    lines.push(
      'if [ -z "$token" ]; then echo "quay: gh token file is missing or empty" >&2; exit 75; fi',
    );
    lines.push('export GH_TOKEN="$token"');
    lines.push("unset token");
  }
  writeFileSync(envPath, `${lines.join("\n")}\n`, { mode: 0o600 });
  chmodSync(envPath, 0o600);
  return `. ${shellQuote(envPath)}\n`;
}

function installGhWrapperIfTokened(
  input: TmuxSpawnInput,
  env: NodeJS.ProcessEnv,
): void {
  const tokenFile = resolveGhTokenFile(input, env);
  if (tokenFile === null) return;

  const adminDir = spawnAdminDir(input);
  const binDir = join(adminDir, "bin");
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  chmodSync(binDir, 0o700);

  const ghPath = join(binDir, "gh");
  const realGh = resolveCommandOnPath("gh", env.PATH);
  const body =
    realGh === null
      ? [
          "#!/bin/sh",
          'echo "quay: gh wrapper could not find gh on PATH before wrapper install" >&2',
          "exit 127",
          "",
        ].join("\n")
      : [
          "#!/bin/sh",
          `token="$(cat ${shellQuote(tokenFile)})"`,
          'if [ -z "$token" ]; then echo "quay: gh token file is missing or empty" >&2; exit 75; fi',
          `exec env GH_TOKEN="$token" GITHUB_TOKEN= ${shellQuote(realGh)} "$@"`,
          "",
        ].join("\n");
  writeFileSync(ghPath, body, { mode: 0o700 });
  chmodSync(ghPath, 0o700);

  env.PATH = env.PATH ? `${binDir}:${env.PATH}` : binDir;
}

function resolveGhTokenFile(
  input: TmuxSpawnInput,
  env: NodeJS.ProcessEnv,
): string | null {
  const fromEnvFile = input.envFiles?.find((entry) => entry.name === "GH_TOKEN");
  if (fromEnvFile !== undefined) return fromEnvFile.path;

  const token = nonEmpty(env.GH_TOKEN) ?? nonEmpty(env.GITHUB_TOKEN);
  if (token === null) return null;

  const adminDir = spawnAdminDir(input);
  mkdirSync(adminDir, { recursive: true, mode: 0o700 });
  chmodSync(adminDir, 0o700);
  const path = join(adminDir, "gh-token");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function spawnAdminDir(input: TmuxSpawnInput): string {
  const hash = createHash("sha256")
    .update(input.sessionName)
    .update("\0")
    .update(input.worktreePath)
    .digest("hex");
  return join(dirname(input.worktreePath), SPAWN_ADMIN_DIR, hash);
}

function prepareCodexHome(env: NodeJS.ProcessEnv): void {
  if (env[CODEX_SOURCE_HOME_ENV] === undefined) return;
  const codexHome = nonEmpty(env.CODEX_HOME);
  if (codexHome === null) {
    delete env[CODEX_SOURCE_HOME_ENV];
    return;
  }
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  chmodSync(codexHome, 0o700);

  const sourceHome = nonEmpty(env[CODEX_SOURCE_HOME_ENV]);
  delete env[CODEX_SOURCE_HOME_ENV];
  if (sourceHome !== null && sourceHome !== codexHome && existsSync(sourceHome)) {
    seedCodexHome(sourceHome, codexHome);
  }
  mkdirSync(join(codexHome, "shell_snapshots"), { recursive: true, mode: 0o700 });
  chmodSync(join(codexHome, "shell_snapshots"), 0o700);
}

function seedCodexHome(sourceHome: string, codexHome: string): void {
  let entries: string[];
  try {
    entries = readdirSync(sourceHome);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "shell_snapshots") continue;
    const sourcePath = join(sourceHome, name);
    const targetPath = join(codexHome, name);
    if (existsSync(targetPath)) continue;
    try {
      symlinkSync(sourcePath, targetPath);
    } catch {
      copyCodexHomeEntry(sourcePath, targetPath);
    }
  }
}

function copyCodexHomeEntry(sourcePath: string, targetPath: string): void {
  try {
    const stat = lstatSync(sourcePath);
    cpSync(sourcePath, targetPath, {
      recursive: stat.isDirectory(),
      force: false,
      errorOnExist: false,
      verbatimSymlinks: true,
    });
  } catch {}
}

function nonEmpty(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveCommandOnPath(
  command: string,
  pathValue: string | undefined,
): string | null {
  if (command.includes("/")) return isExecutable(command) ? command : null;
  for (const dir of (pathValue ?? "").split(":")) {
    if (dir.length === 0) continue;
    const candidate = join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Build a POSIX-shell prefix that reads each envFile inline and exports
// it as the requested variable. Command substitution (`$(cat ...)`)
// strips trailing newlines, so a `printf "%s\n" "$tok" > $f` round-trips
// cleanly. The empty-value guard refuses to proceed with an empty export
// because `gh: not authenticated` is a much less obvious failure mode
// than a wrapper-emitted error in the pane log. Exit 75 (EX_TEMPFAIL)
// signals "try again later" — the operator's token-refresher will write
// a fresh file and the next reviewer attempt will succeed. Variable
// names are validated to a conservative `[A-Z_][A-Z0-9_]*` set; a
// caller passing a name that fails the check is a programmer error and
// throwing here is more discoverable than silently producing a wrapper
// that exports a malformed identifier.
function buildEnvFilePrefix(
  envFiles: Array<{ name: string; path: string }> | undefined,
): string {
  if (!envFiles || envFiles.length === 0) return "";
  const lines: string[] = [];
  for (const { name, path } of envFiles) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      throw new Error(
        `tmux envFiles: name ${JSON.stringify(name)} is not a valid POSIX env var`,
      );
    }
    const quotedPath = shellQuote(path);
    lines.push(`export ${name}="$(cat ${quotedPath})"`);
    lines.push(
      `if [ -z "$${name}" ]; then echo "quay: env file ${quotedPath} is missing or empty" >&2; exit 75; fi`,
    );
  }
  return `${lines.join("\n")}\n`;
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
