// Per-attempt OS-level exit capture: the real adapter wraps the agent
// invocation so the worker shell writes its `$?` to
// `<worktree>/.quay-exit-code` before the pane terminates.
// `getExitInfo` reads that file and decodes 128+N as a signal name.
// We picked the wrapper over reading tmux's `#{pane_dead_status}` /
// `#{pane_dead_signo}` because tmux 3.6a (current macOS) does not
// surface either format for signal-terminated panes — the file-based
// path works on every tmux version we care about.
import { mkdtempSync, rmSync } from "node:fs";
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

t("test_tmux_adapter_captures_exit_code_for_clean_exit", async () => {
  const adapter = new TmuxAdapter();
  const worktreePath = tempWorktree();
  const sessionName = uniqueSession("exit-clean");

  // `sh -c 'exit 0'` exits cleanly with status 0.
  adapter.spawn({
    sessionName,
    worktreePath,
    promptContent: "ignored",
    agentInvocation: "sh -c 'exit 0'",
  });

  const dead = await waitFor(() => !adapter.isAlive(sessionName), 3000);
  expect(dead).toBe(true);

  const info = adapter.getExitInfo(sessionName, worktreePath);
  expect(info.exitCode).toBe(0);
  expect(info.exitSignal).toBeNull();
});

t("test_tmux_adapter_captures_nonzero_exit_code", async () => {
  const adapter = new TmuxAdapter();
  const worktreePath = tempWorktree();
  const sessionName = uniqueSession("exit-nonzero");

  adapter.spawn({
    sessionName,
    worktreePath,
    promptContent: "ignored",
    agentInvocation: "sh -c 'exit 42'",
  });

  const dead = await waitFor(() => !adapter.isAlive(sessionName), 3000);
  expect(dead).toBe(true);

  const info = adapter.getExitInfo(sessionName, worktreePath);
  expect(info.exitCode).toBe(42);
  expect(info.exitSignal).toBeNull();
});

t("test_tmux_adapter_captures_signal_when_agent_killed", async () => {
  const adapter = new TmuxAdapter();
  const worktreePath = tempWorktree();
  const sessionName = uniqueSession("exit-signal");

  // Long-running agent; we'll SIGKILL the agent process (a child of the
  // wrapper shell). The wrapper survives, sees `$? = 128 + 9 = 137`, and
  // writes that value to the marker file. Killing the wrapper itself
  // would skip the post-block — the file would never be written and the
  // captured pair would stay NULL/NULL, which is the documented limit
  // of this approach.
  adapter.spawn({
    sessionName,
    worktreePath,
    promptContent: "ignored",
    agentInvocation: "sleep 30",
  });

  const becameAlive = await waitFor(() => adapter.isAlive(sessionName), 1000);
  expect(becameAlive).toBe(true);

  // Find the wrapper sh's pid via tmux, then SIGKILL its child (`sleep`).
  const pidProbe = Bun.spawnSync({
    cmd: [
      "tmux",
      "display-message",
      "-p",
      "-t",
      `=${sessionName}:0.0`,
      "#{pane_pid}",
    ],
    stdout: "pipe",
    stderr: "ignore",
  });
  expect(pidProbe.exitCode).toBe(0);
  const wrapperPid = Number.parseInt(
    new TextDecoder().decode(pidProbe.stdout).trim(),
    10,
  );
  expect(Number.isFinite(wrapperPid)).toBe(true);

  // Find the child via `pgrep -P <wrapper>`. On a freshly spawned pane
  // there is exactly one child (the agent), so the first line is fine.
  const child = Bun.spawnSync({
    cmd: ["pgrep", "-P", String(wrapperPid)],
    stdout: "pipe",
    stderr: "ignore",
  });
  expect(child.exitCode).toBe(0);
  const childPid = Number.parseInt(
    new TextDecoder().decode(child.stdout).trim().split("\n")[0]!,
    10,
  );
  expect(Number.isFinite(childPid)).toBe(true);
  Bun.spawnSync({ cmd: ["kill", "-KILL", String(childPid)] });

  const dead = await waitFor(() => !adapter.isAlive(sessionName), 3000);
  expect(dead).toBe(true);

  const info = adapter.getExitInfo(sessionName, worktreePath);
  expect(info.exitCode).toBeNull();
  expect(info.exitSignal).toBe("SIGKILL");
});
