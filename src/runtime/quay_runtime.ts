import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createArtifactStore } from "../artifacts/store.ts";
import {
  EMBEDDED_MIGRATIONS,
  QUAY_VERSION,
} from "../build/embedded.generated.ts";
import {
  adaptersConfigFromConfig,
  linearAdapterOptionsFromConfig,
  loadConfig,
  slackAdapterOptionsFromConfig,
  tickOptionsFromConfig,
  type QuayConfig,
} from "../cli/config.ts";
import { resolveDataDir } from "../cli/data_dir.ts";
import type { CliDeps, CliPaths } from "../cli/dispatch.ts";
import { openDatabase, type DB } from "../db/connection.ts";
import { runMigrations, type Migration } from "../db/migrate.ts";
import {
  GitHubCliAdapter,
  LinearAdapter,
  LocalGitAdapter,
  ShellCommandRunner,
  SlackAdapter,
  TmuxAdapter,
} from "../adapters/index.ts";
import { createAgentResolver } from "../core/agents.ts";
import { FileSupervisorLock } from "../core/supervisor_lock.ts";
import { createRepoService, type RepoService } from "../core/repos/service.ts";
import { createTagService, type TagService } from "../core/tags/service.ts";
import { SpawnedValidatorRunner } from "../core/validator_runner.ts";
import { SystemClock } from "../ports/clock.ts";
import { UuidIdGenerator } from "../ports/id_generator.ts";

export class QuayRuntimeStartupError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly details: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    opts: { exitCode?: number; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "QuayRuntimeStartupError";
    this.code = code;
    this.exitCode = opts.exitCode ?? 1;
    this.details = opts.details ?? {};
  }

  toPayload(): Record<string, unknown> {
    return { error: this.code, message: this.message, ...this.details };
  }
}

export interface QuayRuntime {
  version: string;
  config: QuayConfig;
  configPath: string | null;
  dataDir: string;
  paths: CliPaths;
  db: DB;
  repoService: RepoService;
  tagService: TagService;
  cliDeps: CliDeps;
  close: () => void;
}

export interface CreateQuayRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  migrations?: readonly Migration[];
  version?: string;
}

export function createQuayRuntime(
  opts: CreateQuayRuntimeOptions = {},
): QuayRuntime {
  const env = opts.env ?? process.env;
  const home = opts.homeDir ?? homedir();
  const migrations = opts.migrations ?? EMBEDDED_MIGRATIONS;
  const version = opts.version ?? QUAY_VERSION;
  const { config, configPath } = loadConfig({ env, homeDir: home });
  const adaptersConfig = adaptersConfigFromConfig(config);
  const dataDir = resolveDataDir(env, config.data_dir, home);

  const reposRootIsDerived = config.repos_root === undefined;
  const reposRoot = config.repos_root ?? join(dataDir, "repos");
  const worktreesRoot = config.worktree_root ?? join(dataDir, "worktrees");
  const artifactsRoot = join(dataDir, "artifacts");

  const dirsQuayOwns = [dataDir, worktreesRoot, artifactsRoot];
  if (reposRootIsDerived) dirsQuayOwns.push(reposRoot);
  for (const d of dirsQuayOwns) {
    mkdirSync(d, { recursive: true });
  }
  if (!reposRootIsDerived && !existsSync(reposRoot)) {
    throw new QuayRuntimeStartupError(
      "repos_root_missing",
      `repos_root "${reposRoot}" does not exist; quay does not create operator-configured paths. Create the directory yourself, then retry.`,
      { exitCode: 2, details: { repos_root: reposRoot } },
    );
  }

  const db = openDatabase(join(dataDir, "quay.db"));
  runMigrations(db, migrations);
  const clock = new SystemClock();
  const ids = new UuidIdGenerator();
  const artifactStore = createArtifactStore({
    db,
    artifactRoot: artifactsRoot,
    clock,
  });
  const repoService = createRepoService({ db, clock });
  const tagService = createTagService({ db, clock, repoService });
  const agentResolver = createAgentResolver({ db, config });
  const paths = { reposRoot, worktreesRoot, artifactsRoot };
  const tickOptions = tickOptionsFromConfig(config);

  const cliDeps: CliDeps = {
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
    paths,
    tickOptions,
    adaptersConfig,
    repoService,
    tagService,
    agentResolver,
    validatorRunner: new SpawnedValidatorRunner(),
  };
  if (config.retry_budget !== undefined) {
    cliDeps.retryBudget = config.retry_budget;
  }

  return {
    version,
    config,
    configPath,
    dataDir,
    paths,
    db,
    repoService,
    tagService,
    cliDeps,
    close: () => db.close(),
  };
}
