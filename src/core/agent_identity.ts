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

const VERSION_PROBE_TIMEOUT_MS = 2000;

// Extract the binary name from an `agent_invocation` template. The template
// is a shell command line (`{prompt_file}` is the only substitution); the
// binary is the first whitespace-separated token. Strips wrapping quotes —
// `"path with spaces/claude" -p` → `path with spaces/claude`. Returns null
// when the invocation is empty or contains only whitespace.
export function parseAgentBinary(agentInvocation: string): string | null {
  const trimmed = agentInvocation.trim();
  if (trimmed.length === 0) return null;
  const first = trimmed.split(/\s+/, 1)[0]!;
  if (first.length >= 2 && (first.startsWith('"') || first.startsWith("'"))) {
    const last = first[first.length - 1];
    if (last === first[0]) return first.slice(1, -1);
  }
  return first;
}

// Probe `<binary> --version` and return `<runtime>/<version>/<model>`.
// Always returns a non-empty string. Hangs are bounded by an internal
// timeout so a misbehaving binary cannot stall the spawn path.
export function probeAgentIdentity(agentInvocation: string): string {
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
// single grep-friendly token.
function parseVersionOutput(stdout: string): string | null {
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    return line.replace(/\s+/g, " ");
  }
  return null;
}
