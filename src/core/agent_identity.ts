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
// Invocation parsing mirrors a small shell subset: tokens respect single
// and double quotes, leading `VAR=value` env-var assignments are skipped
// to find the actual command word, and shell control characters
// (`<`, `>`, `|`, `&`, `;`) end tokenization since anything past them
// belongs to a different command. Wrappers like `env FOO=bar claude` or
// `nvm exec 18 claude` shift the recorded runtime to the wrapper binary
// (`env`, `nvm`) — that matches what the kernel actually execs but loses
// the underlying agent identity. Operators with non-trivial wrappers
// should treat the recorded value as best-effort.

const VERSION_PROBE_TIMEOUT_MS = 2000;
const MAX_VERSION_LENGTH = 256;

const probeCache = new Map<string, string>();

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
// by the exact `agent_invocation` string — operator config changes
// rarely, so steady-state cost is one probe per unique invocation per
// process lifetime.
export function probeAgentIdentity(agentInvocation: string): string {
  const cached = probeCache.get(agentInvocation);
  if (cached !== undefined) return cached;
  const identity = computeAgentIdentity(agentInvocation);
  probeCache.set(agentInvocation, identity);
  return identity;
}

function computeAgentIdentity(agentInvocation: string): string {
  const binary = parseAgentBinary(agentInvocation);
  if (binary === null) return "unknown/unknown/unknown";

  const runtime = baseName(binary);
  let version = "unknown";
  try {
    const result = Bun.spawnSync({
      cmd: [binary, "--version"],
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
