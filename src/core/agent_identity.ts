// Per-attempt agent identity capture. Snapshots `<runtime>/<runtime_version>/<model_id>`
// into `attempts.agent_identity` so retro analysis can slice by which agent
// runtime executed an attempt (e.g. preamble v2 vs v1 on the *same* model).
//
// v1 captures runtime + version by probing the binary's `--version`. The
// model id is left as `unknown` until a JSON usage envelope (planned in a
// follow-up) provides it directly. The probe is best-effort: any failure
// (binary missing, non-zero exit, hang, parse error) collapses to
// `<binary>/unknown/unknown` so the column is never NULL after a successful
// spawn — which is what makes "is the spawn observability wired?" a
// non-NULL check rather than a content match.
//
// Caching: probes are memoised by invocation string AND keyed by the
// resolved binary's mtime. Repeat probes within a tick are a single
// stat() call, but a binary upgrade (npm/brew install while quay is
// running) flips the mtime and the next probe re-spawns `--version` to
// pick up the new build.
//
// Invocation parsing mirrors a small shell subset: tokens respect single
// and double quotes, leading `VAR=value` env-var assignments are skipped
// to find the actual command word, and shell control characters
// (`<`, `>`, `|`, `&`, `;`) end tokenization since anything past them
// belongs to a different command. Wrappers like `env FOO=bar claude` or
// `nvm exec 18 claude` shift the recorded runtime to the wrapper binary
// (`env`, `nvm`) — that matches what the kernel actually execs but loses
// the underlying agent identity. Operators with non-trivial wrappers
// should treat the recorded value as best-effort.

import { statSync } from "node:fs";

const VERSION_PROBE_TIMEOUT_MS = 2000;
const MAX_VERSION_LENGTH = 256;

interface CacheEntry {
  identity: string;
  // Resolved absolute path of the binary at probe time. Null when the
  // invocation didn't yield a parseable command word, or when neither
  // an absolute path nor PATH lookup found the binary.
  binaryPath: string | null;
  // mtime (in ms since epoch) of `binaryPath` at probe time. Null when
  // we couldn't stat the file; treated as a single distinct value so
  // unstattable→unstattable hits the cache and "appeared on PATH" or
  // "got upgraded" both miss it.
  mtimeMs: number | null;
}

const probeCache = new Map<string, CacheEntry>();

// Extract the binary the shell would exec from an `agent_invocation`
// template. Returns null when the invocation is empty, contains only
// env-var assignments, or starts with a shell construct we don't parse.
export function parseAgentBinary(agentInvocation: string): string | null {
  const tokens = tokenize(agentInvocation);
  for (const tok of tokens) {
    if (isEnvAssignment(tok)) continue;
    return tok;
  }
  return null;
}

// Probe `<binary> --version` and return `<runtime>/<version>/<model>`.
// Always returns a non-empty string. Hangs are bounded by an internal
// timeout so a misbehaving binary cannot stall the spawn path. Memoised
// by `agent_invocation` keyed on the resolved binary path AND its mtime,
// so a binary upgrade between probes invalidates the cache and re-runs
// `--version` against the new build.
export function probeAgentIdentity(agentInvocation: string): string {
  const binary = parseAgentBinary(agentInvocation);
  const binaryPath = binary !== null ? resolveBinaryPath(binary) : null;
  let mtimeMs: number | null = null;
  if (binaryPath !== null) {
    try {
      mtimeMs = statSync(binaryPath).mtimeMs;
    } catch {
      mtimeMs = null;
    }
  }
  const cached = probeCache.get(agentInvocation);
  if (
    cached !== undefined &&
    cached.binaryPath === binaryPath &&
    cached.mtimeMs === mtimeMs
  ) {
    return cached.identity;
  }
  const identity = computeAgentIdentity(binary, binaryPath);
  probeCache.set(agentInvocation, { identity, binaryPath, mtimeMs });
  return identity;
}

function computeAgentIdentity(
  binary: string | null,
  binaryPath: string | null,
): string {
  if (binary === null) return "unknown/unknown/unknown";

  // Probe via the resolved absolute path when available, so the binary
  // we stat (above, for cache keying) is the one we actually exec.
  // Otherwise fall back to the literal token and let Bun resolve it via
  // PATH — same behaviour as before, used when Bun.which returned null.
  const runtime = baseName(binary);
  let version = "unknown";
  try {
    const result = Bun.spawnSync({
      cmd: [binaryPath ?? binary, "--version"],
      stdout: "pipe",
      stderr: "pipe",
      timeout: VERSION_PROBE_TIMEOUT_MS,
    });
    if (result.exitCode === 0) {
      const parsed = parseVersionOutput(
        new TextDecoder().decode(result.stdout),
      );
      if (parsed !== null) version = parsed;
    }
  } catch {
    // Binary not on PATH, EACCES, internal spawn error — treat as unknown.
  }
  return `${runtime}/${version}/unknown`;
}

// Resolve to an absolute path so the cache key tracks a stable inode and
// the stat we use for mtime targets the same file the spawn will exec.
// Absolute paths pass through; relative tokens go through Bun.which (the
// same PATH resolution Bun.spawnSync would do). Returns null when no
// binary on the current PATH matches — we still probe in that case (to
// preserve the "binary missing → unknown/unknown/unknown" outcome) but
// can't key the cache by mtime.
function resolveBinaryPath(binary: string): string | null {
  if (binary.startsWith("/")) return binary;
  return Bun.which(binary);
}

function baseName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

// Most CLIs print one line: `claude 2.1.132`, `bun 1.1.30`, `node v22.10.0`.
// Some print multiple lines (`bash --version`); the first non-empty line is
// the canonical one. Collapses internal whitespace so the result is a
// single grep-friendly token, and truncates so a misbehaving binary that
// floods stdout cannot bloat the row.
function parseVersionOutput(stdout: string): string | null {
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const collapsed = line.replace(/\s+/g, " ");
    return collapsed.length > MAX_VERSION_LENGTH
      ? collapsed.slice(0, MAX_VERSION_LENGTH)
      : collapsed;
  }
  return null;
}

function isEnvAssignment(token: string): boolean {
  // POSIX env-var assignment: NAME=VALUE where NAME starts with a letter
  // or underscore and contains only letters/digits/underscores. Shell
  // recognises these as assignments only when they precede the command
  // word; the caller's loop enforces that ordering.
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

// Small POSIX-shell tokenizer: just enough to find the command word for
// the probe. Stops at the first shell control character (`<>|&;`) since
// anything after belongs to a different command and is irrelevant. Does
// NOT expand env vars or globs — `$VAR` and `*` survive verbatim into the
// emitted token. That's fine: the probe falls back to `unknown` if the
// resulting token isn't a real binary on PATH.
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let buf = "";
  let inToken = false;
  let quote: '"' | "'" | null = null;

  const flush = () => {
    if (inToken) {
      tokens.push(buf);
      buf = "";
      inToken = false;
    }
  };

  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quote !== null) {
      if (c === quote) {
        quote = null;
        continue;
      }
      if (c === "\\" && quote === '"' && i + 1 < input.length) {
        const next = input[i + 1]!;
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          buf += next;
          i++;
          continue;
        }
      }
      buf += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      inToken = true;
      continue;
    }
    if (c === "\\" && i + 1 < input.length) {
      buf += input[i + 1];
      i++;
      inToken = true;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      flush();
      continue;
    }
    if (c === "<" || c === ">" || c === "|" || c === "&" || c === ";") {
      flush();
      return tokens;
    }
    buf += c;
    inToken = true;
  }
  flush();
  return tokens;
}

// Test-only: drop the memoised probe results. Lets a test that wants to
// observe a fresh probe (e.g. after changing PATH) re-run it.
export function __resetAgentIdentityCacheForTests(): void {
  probeCache.clear();
}
