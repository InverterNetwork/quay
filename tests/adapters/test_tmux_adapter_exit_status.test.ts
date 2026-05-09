// The TmuxAdapter wraps `agentInvocation` so the inner shell records
// the agent's exit status to `<worktree>/.quay-exit-code` before the
// pane dies. `collectExitStatus` reads that file and returns the
// shell's `$?` decoded into either a clean exit code or a SIG<name>.
//
// Three behaviors verified here:
//   1. A clean `exit 0` produces `{ rawStatus: 0, exitCode: 0,
//      signalName: null }`.
//   2. A non-zero `exit 7` produces `exitCode: 7`.
//   3. An agent killed by signal (`kill -KILL $$` from inside the
//      agent) produces `exitCode: null, signalName: "SIGKILL"` because
//      POSIX `$?` reports `128 + signum` for signaled children.
//   4. No `.quay-exit-code` file ever written → `null`. This is the
//      "wrapper itself was reaped" case the silent-exit triage path
//      relies on as a discriminator.
//
// A separate test pins the env-forwarding fix: a value placed in
// `process.env` after the runtime starts must be visible inside the
// agent's pane. Without `env: process.env` on the underlying
// `Bun.spawnSync`, Bun's startup snapshot would shadow the live env
// and the assertion would fail.
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { TmuxAdapter } from "../../src/adapters/tmux.ts";

const tmuxAvailable = (() => {
  const have =
    Bun.spawnSync({
      cmd: ["sh", "-c", "command -v tmux >/dev/null 2>&1"],
      stdout: "ignore",
      stderr: "ignore",
    }).exitCode === 0;
  if (!have) return false;
  const probeSession = `quay-tmux-probe-${Math.random().toString(36).slice(2, 10)}`;
  const created = Bun.spawnSync({
    cmd: ["tmux", "new-session", "-d", "-s", probeSession, "true"],
    stdout: "ignore",
    stderr: "ignore",
  });
  if (created.exitCode !== 0) return false;
  Bun.spawnSync({
    cmd: ["tmux", "kill-session", "-t", probeSession],
    stdout: "ignore",
    stderr: "ignore",
  });
  return true;
})();

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {}
  }
});

function tempWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "quay-tmux-exit-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function uniqueSession(suffix: string): string {
  const r = Math.random().toString(36).slice(2, 10);
  const session = `quay-test-${suffix}-${r}`;
  cleanups.push(() => {
    Bun.spawnSync({
      cmd: ["tmux", "kill-session", "-t", session],
      stdout: "ignore",
      stderr: "ignore",
    });
  });
  return session;
}

async function waitFor<T>(
  predicate: () => T | null | false,
  timeoutMs: number,
  intervalMs = 50,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value as T;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const t = tmuxAvailable ? test : test.skip;

t("collectExitStatus reports rawStatus=0 / exitCode=0 for a clean exit", async () => {
  const adapter = new TmuxAdapter();
  const worktreePath = tempWorktree();
  const sessionName = uniqueSession("exit-clean");

  adapter.spawn({
    sessionName,
    worktreePath,
    promptContent: "ignored",
    agentInvocation: "true",
  });

  const exitFile = join(worktreePath, ".quay-exit-code");
  const wrote = await waitFor(
    () => existsSync(exitFile) && statSync(exitFile).size > 0,
    3000,
  );
  expect(wrote).toBe(true);

  const status = adapter.collectExitStatus(sessionName, worktreePath);
  expect(status).toEqual({ rawStatus: 0, exitCode: 0, signalName: null });
});

t("collectExitStatus reports the literal exit code for a non-zero exit", async () => {
  const adapter = new TmuxAdapter();
  const worktreePath = tempWorktree();
  const sessionName = uniqueSession("exit-nonzero");

  // `exit 7` directly in agent_invocation would terminate the wrapper
  // shell itself before it could write the exit-code file (because
  // tmux runs the wrapped command in a single shell). A real worker
  // is its own process, so the wrapper observes its exit normally;
  // model that here with a subshell.
  adapter.spawn({
    sessionName,
    worktreePath,
    promptContent: "ignored",
    agentInvocation: "sh -c 'exit 7'",
  });

  const exitFile = join(worktreePath, ".quay-exit-code");
  const wrote = await waitFor(
    () => existsSync(exitFile) && statSync(exitFile).size > 0,
    3000,
  );
  expect(wrote).toBe(true);

  const status = adapter.collectExitStatus(sessionName, worktreePath);
  expect(status).toEqual({ rawStatus: 7, exitCode: 7, signalName: null });
});

t("collectExitStatus decodes 128+N as a signal name", async () => {
  const adapter = new TmuxAdapter();
  const worktreePath = tempWorktree();
  const sessionName = uniqueSession("exit-signal");

  // The agent self-signals so the inner shell observes 128+9 in `$?`.
  // (`kill -KILL $$` would also kill the wrapper because it's the same
  // shell process; chain via a subshell so only the inner agent dies
  // and the wrapper survives to write the exit-code file.)
  adapter.spawn({
    sessionName,
    worktreePath,
    promptContent: "ignored",
    agentInvocation: "sh -c 'kill -KILL $$'",
  });

  const exitFile = join(worktreePath, ".quay-exit-code");
  const wrote = await waitFor(
    () => existsSync(exitFile) && statSync(exitFile).size > 0,
    3000,
  );
  expect(wrote).toBe(true);

  const status = adapter.collectExitStatus(sessionName, worktreePath);
  expect(status).not.toBeNull();
  expect(status!.exitCode).toBeNull();
  expect(status!.signalName).toBe("SIGKILL");
  expect(status!.rawStatus).toBe(128 + 9);
});

test("collectExitStatus returns null when no exit-code file exists", () => {
  const adapter = new TmuxAdapter();
  const worktreePath = mkdtempSync(join(tmpdir(), "quay-tmux-exit-missing-"));
  cleanups.push(() => rmSync(worktreePath, { recursive: true, force: true }));
  expect(adapter.collectExitStatus("never-existed", worktreePath)).toBeNull();
});

t("env: process.env propagates a runtime-set variable into the agent pane", async () => {
  // Bun snapshots PATH (and possibly more) at startup unless the caller
  // forwards `env: process.env`. A tick that mints credentials at
  // runtime would otherwise spawn tmux with a stale env, leaving the
  // agent without the GH_TOKEN/HTTP-credentials it needs — the
  // hypothesized AST-100 silent-exit shape. We assert by setting a var
  // post-startup, having the agent read it, and checking the value
  // landed in the pane log.
  const marker = `QUAY_AST100_PROBE_${Math.random().toString(36).slice(2, 10)}`;
  process.env.QUAY_AST100_PROBE = marker;
  cleanups.push(() => {
    delete process.env.QUAY_AST100_PROBE;
  });

  const adapter = new TmuxAdapter();
  const worktreePath = tempWorktree();
  const sessionName = uniqueSession("env");
  const logPath = join(worktreePath, ".quay-session.log");

  adapter.spawn({
    sessionName,
    worktreePath,
    promptContent: "ignored",
    // Print the env var the wrapper inherited; sleep so the pane stays
    // alive long enough for pipe-pane to flush.
    agentInvocation: 'printf "PROBE=%s\\n" "$QUAY_AST100_PROBE"; sleep 1',
  });

  const wrote = await waitFor(
    () => existsSync(logPath) && statSync(logPath).size > 0,
    3000,
  );
  expect(wrote).toBe(true);

  const log = adapter.collectLog(sessionName, worktreePath);
  expect(log).not.toBeNull();
  expect(log!).toContain(`PROBE=${marker}`);
});
