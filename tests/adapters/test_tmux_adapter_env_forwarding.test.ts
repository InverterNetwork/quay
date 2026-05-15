// Bun snapshots PATH (and possibly more) at startup unless the caller
// forwards `env: process.env`. A tick that mints credentials at
// runtime would otherwise spawn tmux with a stale env, leaving the
// agent without the GH_TOKEN/HTTP-credentials it needs. We assert by
// setting a var post-startup, having the agent read it, and checking
// the value landed in the pane log.
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { TmuxAdapter } from "../../src/adapters/tmux.ts";
import { REVIEWER_GH_TOKEN_ENV } from "../../src/core/tick.ts";

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

t("envFiles loads per-spawn secrets into the pane without touching argv", async () => {
  // The reviewer spawn path uses envFiles to hand the pane a distinct
  // GH_TOKEN. The value is read inside the pane via `$(cat <path>)`, so
  // only the path is visible in argv — `ps` on the host can never see
  // the token bytes. Verify the pane actually receives the value and
  // that the trailing newline from the file is stripped (POSIX command
  // substitution behavior).
  const adapter = new TmuxAdapter();
  const worktreePath = tempWorktree();
  const sessionName = uniqueSession("env-file");
  const logPath = join(worktreePath, ".quay-session.log");
  const marker = `gh_file_${Math.random().toString(36).slice(2, 10)}`;
  const tokenPath = join(worktreePath, "reviewer-gh-token");
  writeFileSync(tokenPath, `${marker}\n`);

  adapter.spawn({
    sessionName,
    worktreePath,
    promptContent: "ignored",
    agentInvocation: 'printf "GH=[%s]\\n" "$GH_TOKEN"; sleep 1',
    envFiles: [{ name: "GH_TOKEN", path: tokenPath }],
  });

  const wrote = await waitFor(
    () => existsSync(logPath) && statSync(logPath).size > 0,
    3000,
  );
  expect(wrote).toBe(true);

  const log = adapter.collectLog(sessionName, worktreePath);
  expect(log).not.toBeNull();
  // Brackets prove the trailing newline was stripped by `$(...)`.
  expect(log!).toContain(`GH=[${marker}]`);
});

t("envFiles wrapper fails loudly when the file is empty at pane-start", async () => {
  // Defense in depth: tick.ts preflights existence and non-empty, but
  // an operator's token-refresher could truncate the file between
  // preflight and pane exec. The wrapper must surface that as a clear
  // pane log entry rather than letting the agent see GH_TOKEN="" and
  // failing later with `gh: not authenticated`.
  const adapter = new TmuxAdapter();
  const worktreePath = tempWorktree();
  const sessionName = uniqueSession("env-file-empty");
  const logPath = join(worktreePath, ".quay-session.log");
  const tokenPath = join(worktreePath, "reviewer-gh-token");
  writeFileSync(tokenPath, "");

  adapter.spawn({
    sessionName,
    worktreePath,
    promptContent: "ignored",
    agentInvocation: 'printf "should not run\\n"; sleep 1',
    envFiles: [{ name: "GH_TOKEN", path: tokenPath }],
  });

  const wrote = await waitFor(
    () => existsSync(logPath) && statSync(logPath).size > 0,
    3000,
  );
  expect(wrote).toBe(true);

  const log = adapter.collectLog(sessionName, worktreePath);
  expect(log).not.toBeNull();
  expect(log!).toContain("is missing or empty");
  expect(log!).not.toContain("should not run");
});

t("env overrides replace GH_TOKEN and remove reviewer source env", async () => {
  process.env.GH_TOKEN = "ghs_worker_from_parent";
  process.env.GITHUB_TOKEN = "ghs_worker_github_from_parent";
  process.env[REVIEWER_GH_TOKEN_ENV] = "ghs_reviewer_source_parent";
  cleanups.push(() => {
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env[REVIEWER_GH_TOKEN_ENV];
  });

  const adapter = new TmuxAdapter();
  const worktreePath = tempWorktree();
  const sessionName = uniqueSession("env-override");
  const logPath = join(worktreePath, ".quay-session.log");

  adapter.spawn({
    sessionName,
    worktreePath,
    promptContent: "ignored",
    agentInvocation: `printf "GH=[%s] GITHUB=[%s] SRC=[%s]\\n" "$GH_TOKEN" "$GITHUB_TOKEN" "$${REVIEWER_GH_TOKEN_ENV}"; sleep 1`,
    env: {
      GH_TOKEN: "ghs_reviewer_for_pane",
      GITHUB_TOKEN: undefined,
      [REVIEWER_GH_TOKEN_ENV]: undefined,
    },
  });

  const wrote = await waitFor(
    () => existsSync(logPath) && statSync(logPath).size > 0,
    3000,
  );
  expect(wrote).toBe(true);

  const log = adapter.collectLog(sessionName, worktreePath);
  expect(log).not.toBeNull();
  expect(log!).toContain("GH=[ghs_reviewer_for_pane] GITHUB=[] SRC=[]");
});
