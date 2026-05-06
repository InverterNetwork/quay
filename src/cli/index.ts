#!/usr/bin/env bun
// Quay CLI entry. Wires real adapters and a shared SQLite DB under
// $QUAY_DATA_DIR (or ~/.quay), then hands argv to dispatch().
//
// Tests do NOT import this file: they call dispatch() directly with fakes.
// Keep this entry thin.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createArtifactStore } from "../artifacts/store.ts";
import { openDatabase } from "../db/connection.ts";
import { runMigrations } from "../db/migrate.ts";
import {
  GitHubCliAdapter,
  LinearAdapter,
  LocalGitAdapter,
  ShellCommandRunner,
  SlackAdapter,
  TmuxAdapter,
} from "../adapters/index.ts";
import { FileSupervisorLock } from "../core/supervisor_lock.ts";
import { SpawnedValidatorRunner } from "../core/validator_runner.ts";
import { SystemClock } from "../ports/clock.ts";
import { UuidIdGenerator } from "../ports/id_generator.ts";
import {
  adaptersConfigFromConfig,
  linearAdapterOptionsFromConfig,
  loadConfig,
  slackAdapterOptionsFromConfig,
  tickOptionsFromConfig,
} from "./config.ts";
import { dispatch, type CliDeps } from "./dispatch.ts";
import { handleValidateTicket } from "./validate_ticket.ts";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  // `quay validate-ticket` is contractually stateless (ticket-validation §4):
  // it reads JSON from stdin or a file, applies a TOML schema, and writes
  // JSON to stdout with a fixed exit-code surface. Routing it through full
  // CLI startup would couple a pure validator to deployment config and DB
  // migrations, so a bad ~/.quay/config.toml or unwritable data dir would
  // break validation. Short-circuit here before any of that runs.
  if (argv[0] === "validate-ticket") {
    const result = handleValidateTicket(
      argv.slice(1),
      {
        stdout: (c) => process.stdout.write(c as string | Uint8Array),
        stderr: (c) => process.stderr.write(c),
        stdin: () => readFileSync(0, "utf8"),
      },
      process.env,
    );
    return result.exitCode;
  }
  const { config } = loadConfig();
  const adaptersConfig = adaptersConfigFromConfig(config);
  // Spec §13: `data_dir` defaults to `~/.quay`. The QUAY_DATA_DIR env var
  // is the operator's runtime override (handy in tests / containers); the
  // config file's `data_dir` is the deployment-level default. Env wins.
  const dataDir =
    process.env.QUAY_DATA_DIR ??
    config.data_dir ??
    join(homedir(), ".quay");
  // Spec §13: `repos_root` defaults to `${data_dir}/repos`. The config
  // override is honored verbatim (operator-controlled absolute path), with
  // the same precedence as `worktree_root` — config wins over the derived
  // default; there is no env override for this knob.
  //
  // Consumer model: quay does NOT create an operator-configured `repos_root`.
  // If the operator explicitly sets `repos_root` in config, that directory must
  // already exist — a missing path indicates a misconfiguration (e.g. a typo'd
  // path), and silently materializing it would hide the error until a later
  // `bare_clone_missing`. The derived default (`${data_dir}/repos`) is still
  // mkdir'd because it's quay's own data dir.
  const reposRootIsDerived = config.repos_root === undefined;
  const reposRoot = config.repos_root ?? join(dataDir, "repos");
  // Spec §13: `worktree_root` defaults to `${data_dir}/worktrees`. The config
  // override is honored verbatim (operator-controlled absolute path), with
  // the same precedence as `tick_lock_path` — config wins over the derived
  // default; there is no env override for this knob.
  const worktreesRoot = config.worktree_root ?? join(dataDir, "worktrees");
  const artifactsRoot = join(dataDir, "artifacts");
  // Always mkdir quay-owned dirs. Only mkdir reposRoot when it is the derived
  // default; an explicitly configured path must already exist.
  const dirsQuayOwns = [dataDir, worktreesRoot, artifactsRoot];
  if (reposRootIsDerived) dirsQuayOwns.push(reposRoot);
  for (const d of dirsQuayOwns) {
    mkdirSync(d, { recursive: true });
  }
  if (!reposRootIsDerived && !existsSync(reposRoot)) {
    process.stderr.write(
      `${JSON.stringify({ error: "repos_root_missing", message: `repos_root "${reposRoot}" does not exist; quay does not create operator-configured paths. Create the directory yourself, then retry.` })}\n`,
    );
    return 2;
  }
  const db = openDatabase(join(dataDir, "quay.db"));
  const migrationsDir = resolveMigrationsDir();
  runMigrations(db, migrationsDir);
  const clock = new SystemClock();
  const ids = new UuidIdGenerator();
  const artifactStore = createArtifactStore({
    db,
    artifactRoot: artifactsRoot,
    clock,
  });

  const deps: CliDeps = {
    db,
    clock,
    ids,
    git: new LocalGitAdapter(reposRoot),
    github: new GitHubCliAdapter(reposRoot),
    tmux: new TmuxAdapter(),
    slack: new SlackAdapter(slackAdapterOptionsFromConfig(config)),
    linear: new LinearAdapter(linearAdapterOptionsFromConfig(config)),
    commandRunner: new ShellCommandRunner(),
    artifactStore,
    supervisorLock: new FileSupervisorLock(
      // Spec §11: `tick_lock_path` defaults to `${data_dir}/tick.lock`. Name
      // retained for compatibility; semantically the supervisor lock that
      // serializes every tmux/Slack/gh/branch side effect across processes.
      config.supervisor_lock_stale_seconds !== undefined
        ? {
            lockfilePath:
              config.tick_lock_path ?? join(dataDir, "tick.lock"),
            staleSeconds: config.supervisor_lock_stale_seconds,
          }
        : {
            lockfilePath:
              config.tick_lock_path ?? join(dataDir, "tick.lock"),
          },
    ),
    paths: { reposRoot, worktreesRoot, artifactsRoot },
    tickOptions: tickOptionsFromConfig(config),
    ...(config.retry_budget !== undefined
      ? { retryBudget: config.retry_budget }
      : {}),
    // The Linear adapter and validator runner are constructed
    // unconditionally; the dispatcher gates `--linear-issue` on
    // `adaptersConfig.linearEnabled`. Tokens resolve lazily on first use,
    // so a deployment that never enables Linear pays no cost for the
    // unused adapter object.
    validatorRunner: new SpawnedValidatorRunner(),
    adaptersConfig,
  };

  const io = {
    // process.stdout.write accepts both string and Uint8Array natively,
    // so we forward whatever dispatch hands us (the `artifact get` path
    // emits raw bytes to preserve binary / invalid-UTF-8 payloads — see
    // CliIO docs).
    stdout: (c: string | Uint8Array) => process.stdout.write(c),
    stderr: (c: string) => process.stderr.write(c),
    // `validate-ticket` is the only command that reads stdin. Synchronous
    // read from fd 0 is fine here — the CLI is one-shot and we have nothing
    // else to do until the input is consumed.
    stdin: () => readFileSync(0, "utf8"),
  };
  const result = await dispatch(argv, deps, io);
  return result.exitCode;
}

function resolveMigrationsDir(): string {
  // Resolve relative to repo root regardless of where the CLI was invoked.
  return fileURLToPath(new URL("../../migrations", import.meta.url));
}

main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(
    `${JSON.stringify({ error: "internal_error", message: err?.message ?? String(err) })}\n`,
  );
  process.exit(1);
});
