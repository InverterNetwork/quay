// Bun snapshots PATH (and possibly more) at startup unless the caller
// forwards `env: process.env`. A tick that mints credentials at
// runtime would otherwise spawn tmux with a stale env, leaving the
// agent without the GH_TOKEN/HTTP-credentials it needs. We assert by
// setting a var post-startup, having the agent read it, and checking
// the value landed in the pane log.
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
  const dir = mkdtempSync(join(tmpdir(), "quay-tmux-env-"));
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

t("env: process.env propagates a runtime-set variable into the agent pane", async () => {
  const marker = `QUAY_ENV_FORWARD_PROBE_${Math.random().toString(36).slice(2, 10)}`;
  process.env.QUAY_ENV_FORWARD_PROBE = marker;
  cleanups.push(() => {
    delete process.env.QUAY_ENV_FORWARD_PROBE;
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
    agentInvocation: 'printf "PROBE=%s\\n" "$QUAY_ENV_FORWARD_PROBE"; sleep 1',
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

t("extraEnv injects per-spawn variables into the agent pane", async () => {
  // The reviewer spawn path uses extraEnv to hand the pane a distinct
  // GH_TOKEN without affecting other panes under the same tmux server.
  // The `-e` flag is the only mechanism that's reliable across tmux
  // versions regardless of `update-environment`, so verify the pane
  // actually sees the value.
  const adapter = new TmuxAdapter();
  const worktreePath = tempWorktree();
  const sessionName = uniqueSession("env-extra");
  const logPath = join(worktreePath, ".quay-session.log");
  const marker = `gh_extra_${Math.random().toString(36).slice(2, 10)}`;

  adapter.spawn({
    sessionName,
    worktreePath,
    promptContent: "ignored",
    agentInvocation: 'printf "GH=%s\\n" "$GH_TOKEN"; sleep 1',
    extraEnv: { GH_TOKEN: marker },
  });

  const wrote = await waitFor(
    () => existsSync(logPath) && statSync(logPath).size > 0,
    3000,
  );
  expect(wrote).toBe(true);

  const log = adapter.collectLog(sessionName, worktreePath);
  expect(log).not.toBeNull();
  expect(log!).toContain(`GH=${marker}`);
});
