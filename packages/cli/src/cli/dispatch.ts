// CLI dispatcher. Thin layer over core service API. Output shape is the
// product contract: read commands emit deterministic JSON on stdout; write
// errors emit `{error: ...}` on stderr with non-zero exit.
//
// Production wiring (real adapters) lives in src/cli/index.ts. This module
// stays free of adapter construction so tests can drive it with fakes.
//
// Command surface tracks spec §10. The flag-based forms (e.g.
// `--repo <id> --brief-file <path>`) are the documented interface. A
// `--input <json>` escape hatch is also accepted on write commands so tests
// and tooling can hand a structured payload directly.

import { readFileSync, writeFileSync } from "node:fs";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { DB } from "../db/connection.ts";
import type { QuayConfig } from "./config.ts";
import type { Clock } from "../ports/clock.ts";
import type { CommandRunner } from "../ports/command_runner.ts";
import type { GitPort } from "../ports/git.ts";
import type { GitHubPort } from "../ports/github.ts";
import type { IdGenerator } from "../ports/id_generator.ts";
import type { LinearPort } from "../ports/linear.ts";
import type { SlackPort } from "../ports/slack.ts";
import type { TmuxPort } from "../ports/tmux.ts";
import { enqueue, type EnqueueDeps } from "../core/enqueue.ts";
import { createDeploymentSettingsService } from "../core/deployment_settings.ts";
import type { ValidatorRunner } from "../core/validator_runner.ts";
import { loadConfigFromPath } from "./config.ts";
import { handleEnqueueLinearIssue } from "./enqueue_linear_issue.ts";
import type { RepoService } from "../core/repos/service.ts";
import {
  buildAgentSelection,
  validateAgentSelection,
  type AgentResolver,
} from "../core/agents.ts";
import type { TagService, TagVocab } from "../core/tags/service.ts";
import { mergeVocab } from "../core/tags/merge.ts";
import { parseImportToml, planImport } from "../core/tags/import_toml.ts";
import { QuayError } from "../core/errors.ts";
import type { PreambleKind } from "../core/preamble.ts";
import {
  assertReviewerGuidanceProtocolSafe,
  createRepoGuidance,
  createPreamble,
  getPreamble,
  latestRepoGuidance,
  listPreambles,
  listRepoGuidance,
  type RepoGuidanceRole,
} from "../core/preamble.ts";
import {
  cancel_task,
  type CancelDeps,
  type CancelResult,
} from "../core/cancel.ts";
import {
  task_retarget,
  type RetargetDeps,
} from "../core/retarget.ts";
import {
  recreate_task_worktree,
  type RecreateWorktreeDeps,
} from "../core/recreate_worktree.ts";
import {
  claim_task,
  release_claim,
  submit_brief,
  escalate_human,
  record_human_reply,
  type ClaimDeps,
  type SubmitBriefDeps,
  type EscalateHumanDeps,
  type RecordHumanReplyDeps,
  type ServiceResult,
} from "../core/claims.ts";
import {
  listOrchestratorHandoffs,
  type OrchestratorHandoffStatus,
} from "../core/orchestrator_handoffs.ts";
import {
  claimOutboxItem,
  completeOutboxItem,
  failOutboxItem,
  listDeliveryOutboxItems,
  listOutboxItems,
  type OutboxHandlerClass,
  type OutboxStatus,
} from "../core/outbox.ts";
import { tick_once, type TickDeps, type TickOptions } from "../core/tick.ts";
import type { SupervisorLock } from "../core/supervisor_lock.ts";
import { toCliError, serviceErrorToCli } from "./errors.ts";
import { getTask, listTasks } from "./format.ts";
import {
  HELP_HINT,
  commandHelp,
  isHelpToken,
  topLevelHelp,
  wantsHelp,
} from "./help.ts";
import type { CliIO } from "./io.ts";
import {
  adoptPr,
  AdoptPrError,
  enterReview,
  EnterReviewError,
  type AdoptPrResult,
  type EnterReviewResult,
} from "../core/pr_review.ts";

export interface CliPaths {
  reposRoot: string;
  worktreesRoot: string;
  artifactsRoot: string;
}

export interface CliDeps {
  db: DB;
  clock: Clock;
  ids: IdGenerator;
  git: GitPort;
  github: GitHubPort;
  tmux: TmuxPort;
  slack: SlackPort;
  commandRunner: CommandRunner;
  artifactStore: ArtifactStore;
  supervisorLock: SupervisorLock;
  paths: CliPaths;
  config?: QuayConfig;
  tickOptions?: TickOptions;
  // Spec §13: `retry_budget` is a deployment-level knob (default 5). When
  // the operator overrides it in `~/.quay/config.toml`, the production CLI
  // forwards it here so enqueue copies the configured value into
  // `tasks.retry_budget` instead of the EnqueueDeps default.
  retryBudget?: number;
  // Adapters spec §4 / §8: the Linear adapter and validator runner are
  // optional — deployments without `[adapters.linear].enabled` never touch
  // them. The dispatcher fails closed (usage error) when `--linear-issue`
  // is invoked without these wired.
  linear?: LinearPort;
  validatorRunner?: ValidatorRunner;
  adaptersConfig?: { linearEnabled: boolean; slackEnabled: boolean };
  repoService: RepoService;
  tagService: TagService;
  // Resolver for the deployment's `[agents]` block. Worker/reviewer
  // spawn paths use it to look up the invocation string by
  // (repo_id, role); the repo-add/update CLI handlers consult its
  // `registeredAgents()` to reject overrides naming an unregistered
  // entry. The dispatcher constructs the resolver from `CliDeps.config`
  // at startup; tests inject a fake.
  agentResolver: AgentResolver;
}

export interface DispatchResult {
  exitCode: number;
}

export async function dispatch(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): Promise<DispatchResult> {
  // Bare `quay` with no args: surface help on stderr (operator-friendly) and
  // exit non-zero so wrapping scripts still fail closed. We deliberately drop
  // the previous `usage_error: no command provided` JSON envelope here — there
  // was no command to envelope in the first place, and showing the command
  // list is more useful than a one-liner error for an interactive user.
  if (argv.length === 0) {
    io.stderr(topLevelHelp());
    return { exitCode: 1 };
  }

  const [head, ...rest] = argv;
  // Explicit top-level help.
  //
  //   quay --help / -h / help              → top-level overview, stdout.
  //   quay help <cmd> [<sub>] [...]        → per-command help for that path,
  //                                          mirroring `git help log`.
  //
  // Per-command `<cmd> --help` invocations fall through to the relevant
  // handler so each one can short-circuit to its own usage block.
  if (isHelpToken(head as string)) {
    if (rest.length === 0) {
      io.stdout(topLevelHelp());
      return { exitCode: 0 };
    }
    if (head === "help") {
      // Fall back to top-level help if the path isn't registered, rather
      // than emit a confusing `usage_error: no help for: ...`.
      const block = commandHelp(rest);
      if (block !== null) {
        io.stdout(block);
        return { exitCode: 0 };
      }
      io.stdout(topLevelHelp());
      return { exitCode: 0 };
    }
  }
  try {
    // Per-command --help: route to the relevant handler so each one can
    // short-circuit to its own usage block on stdout.
    switch (head) {
      case "task":
        return await handleTask(rest, deps, io);
      case "tick":
        return await handleTick(rest, deps, io);
      case "handoff":
        return handleHandoff(rest, deps, io);
      case "outbox":
        return await handleOutbox(rest, deps, io);
      case "enqueue":
        return await handleEnqueue(rest, deps, io);
      case "rerun":
        return await handleRerun(rest, deps, io);
      case "review-pr":
        return handleReviewPr(rest, deps, io);
      case "adopt-pr":
        return await handleAdoptPr(rest, deps, io);
      case "unadopt":
        return await handleUnadopt(rest, deps, io);
      case "repo":
        return handleRepo(rest, deps, io);
      case "preamble":
        return handlePreamble(rest, deps, io);
      case "tags":
        return handleTags(rest, deps, io);
      case "settings":
        return handleSettings(rest, deps, io);
      case "cancel":
        return await handleCancel(rest, deps, io);
      case "submit-brief":
        return await handleSubmitBrief(rest, deps, io);
      case "escalate-human":
        return await handleEscalateHuman(rest, deps, io);
      case "record-human-reply":
        return await handleRecordHumanReply(rest, deps, io);
      case "artifact":
        return handleArtifact(rest, deps, io);
      default:
        // Preserve the structured-error envelope so machine consumers
        // (hermes-agent etc.) keep parsing as before; tack on a one-line
        // human hint on the next line.
        io.stderr(
          `${JSON.stringify({ error: "usage_error", message: `unknown command: ${head}`, command: head })}\n`,
        );
        io.stderr(HELP_HINT);
        return { exitCode: 1 };
    }
  } catch (err) {
    const payload = toCliError(err);
    io.stderr(`${JSON.stringify(payload)}\n`);
    return { exitCode: 1 };
  }
}

function handlePreamble(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  if (argv.length === 0) {
    return writeErrorWithUsage(
      io,
      ["preamble"],
      "usage_error",
      "preamble subcommand required",
    );
  }
  const [sub, ...rest] = argv;
  if (isHelpToken(sub as string)) return printHelp(io, ["preamble"]);
  switch (sub) {
    case "list":
      if (wantsHelp(rest)) return printHelp(io, ["preamble", "list"]);
      return handlePreambleList(rest, deps, io);
    case "show":
      if (wantsHelp(rest)) return printHelp(io, ["preamble", "show"]);
      return handlePreambleShow(rest, deps, io);
    case "create":
      if (wantsHelp(rest)) return printHelp(io, ["preamble", "create"]);
      return handlePreambleCreate(rest, deps, io);
    default:
      return writeErrorWithUsage(
        io,
        ["preamble"],
        "usage_error",
        `unknown preamble subcommand: ${sub}`,
      );
  }
}

function handlePreambleList(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  const validation = validateFlags(argv, { valued: ["--kind"] });
  if (!validation.ok) {
    return writeError(io, "usage_error", validation.message, validation.details);
  }
  const kindRaw = readFlag(argv, "--kind");
  const kind = kindRaw === null
    ? undefined
    : parsePreambleKind(kindRaw, io);
  if (kind === null) return { exitCode: 1 };
  io.stdout(`${JSON.stringify(listPreambles(deps.db, kind))}\n`);
  return { exitCode: 0 };
}

function handlePreambleShow(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  const validation = validateFlags(argv, { valued: ["--id"] });
  if (!validation.ok) {
    return writeError(io, "usage_error", validation.message, validation.details);
  }
  const rawId = readFlag(argv, "--id") ?? positional(argv);
  if (rawId === null) {
    return writeError(io, "usage_error", "preamble show requires <preamble_id>");
  }
  const parsed = parsePositiveIntArg(rawId, "preamble show", "preamble_id");
  if (!parsed.ok) return writeError(io, "usage_error", parsed.message);
  const row = getPreamble(deps.db, parsed.value);
  if (row === null) {
    return writeError(io, "not_found", `preamble ${parsed.value} not found`, {
      preamble_id: parsed.value,
    });
  }
  io.stdout(`${JSON.stringify(row)}\n`);
  return { exitCode: 0 };
}

function parsePreambleKind(raw: string, io: CliIO): PreambleKind | null {
  if (raw === "code" || raw === "review") return raw;
  writeError(io, "usage_error", `preamble kind must be code or review (got ${raw})`, {
    kind: raw,
  });
  return null;
}

function handlePreambleCreate(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  const validation = validateFlags(argv, {
    valued: ["--kind", "--body-file", "--body"],
  });
  if (!validation.ok) {
    return writeError(io, "usage_error", validation.message, validation.details);
  }
  const kindRaw = readFlag(argv, "--kind");
  if (kindRaw === null) {
    return writeError(io, "usage_error", "preamble create requires --kind <code|review>");
  }
  const kind = parsePreambleKind(kindRaw, io);
  if (kind === null) return { exitCode: 1 };

  const bodyFlag = readFlag(argv, "--body");
  const bodyFile = readFlag(argv, "--body-file");
  if ((bodyFlag === null && bodyFile === null) || (bodyFlag !== null && bodyFile !== null)) {
    return writeError(
      io,
      "usage_error",
      "preamble create requires exactly one of --body or --body-file",
    );
  }
  let body: string;
  if (bodyFlag !== null) {
    body = bodyFlag;
  } else if (bodyFile === "-") {
    if (io.stdin === undefined) {
      return writeError(io, "usage_error", "stdin is not available");
    }
    body = io.stdin();
  } else {
    const fileRead = tryReadFile(bodyFile as string);
    if (!fileRead.ok) return writeError(io, "usage_error", fileRead.message);
    body = fileRead.value;
  }
  const row = createPreamble(deps.db, deps.clock, kind, body);
  io.stdout(`${JSON.stringify(row)}\n`);
  return { exitCode: 0 };
}

function writeError(
  io: CliIO,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): DispatchResult {
  io.stderr(`${JSON.stringify({ error: code, message, ...details })}\n`);
  return { exitCode: 1 };
}

function writeErrorWithExit(
  io: CliIO,
  exitCode: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): DispatchResult {
  io.stderr(`${JSON.stringify({ error: code, message, ...details })}\n`);
  return { exitCode };
}

// Like `writeError`, but additionally renders the per-command usage block on
// stderr after the JSON envelope. The structured envelope still parses as
// JSON (it's the first line); the human-readable block follows.
function writeErrorWithUsage(
  io: CliIO,
  helpPath: string[],
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): DispatchResult {
  io.stderr(`${JSON.stringify({ error: code, message, ...details })}\n`);
  const block = commandHelp(helpPath);
  if (block !== null) io.stderr(`\n${block}`);
  return { exitCode: 1 };
}

function handleHandoff(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  if (argv.length === 0) {
    return writeErrorWithUsage(
      io,
      ["handoff"],
      "usage_error",
      "handoff subcommand required",
    );
  }
  const [sub, ...rest] = argv;
  if (isHelpToken(sub as string)) return printHelp(io, ["handoff"]);
  switch (sub) {
    case "list":
      if (wantsHelp(rest)) return printHelp(io, ["handoff", "list"]);
      return handleHandoffList(rest, deps, io);
    default:
      return writeErrorWithUsage(
        io,
        ["handoff"],
        "usage_error",
        `unknown handoff subcommand: ${sub}`,
      );
  }
}

function handleHandoffList(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  const validation = validateFlags(argv, {
    valued: ["--status", "--task"],
    boolean: ["--include-ineligible"],
  });
  if (!validation.ok) {
    return writeError(io, "usage_error", validation.message, validation.details);
  }
  const rawStatus = readFlag(argv, "--status") ?? "pending";
  if (!isHandoffStatus(rawStatus)) {
    return writeError(
      io,
      "usage_error",
      `handoff list --status must be pending, claimed, completed, or cancelled (got ${rawStatus})`,
      { status: rawStatus },
    );
  }
  const filters: {
    status: OrchestratorHandoffStatus;
    taskId?: string;
    eligibleAtOrBefore: string;
    includeIneligible: boolean;
  } = {
    status: rawStatus,
    eligibleAtOrBefore: deps.clock.nowISO(),
    includeIneligible: argv.includes("--include-ineligible"),
  };
  const taskId = readFlag(argv, "--task");
  if (taskId !== null) filters.taskId = taskId;
  const rows = listOrchestratorHandoffs(deps.db, filters);
  io.stdout(`${JSON.stringify(rows)}\n`);
  return { exitCode: 0 };
}

function isHandoffStatus(s: string): s is OrchestratorHandoffStatus {
  return (
    s === "pending" ||
    s === "claimed" ||
    s === "completed" ||
    s === "cancelled"
  );
}

async function handleOutbox(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): Promise<DispatchResult> {
  if (argv.length === 0) {
    return writeErrorWithUsage(
      io,
      ["outbox"],
      "usage_error",
      "outbox subcommand required",
    );
  }
  const [sub, ...rest] = argv;
  if (isHelpToken(sub as string)) return printHelp(io, ["outbox"]);
  switch (sub) {
    case "list":
      if (wantsHelp(rest)) return printHelp(io, ["outbox", "list"]);
      return handleOutboxList(rest, deps, io);
    case "claim":
      if (wantsHelp(rest)) return printHelp(io, ["outbox", "claim"]);
      return handleOutboxClaim(rest, deps, io);
    case "complete":
      if (wantsHelp(rest)) return printHelp(io, ["outbox", "complete"]);
      return handleOutboxComplete(rest, deps, io);
    case "fail":
      if (wantsHelp(rest)) return printHelp(io, ["outbox", "fail"]);
      return handleOutboxFail(rest, deps, io);
    default:
      return writeErrorWithUsage(
        io,
        ["outbox"],
        "usage_error",
        `unknown outbox subcommand: ${sub}`,
      );
  }
}

function handleOutboxList(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  const validation = validateFlags(argv, {
    valued: ["--status", "--task", "--kind", "--handler-class"],
    boolean: ["--include-ineligible"],
  });
  if (!validation.ok) {
    return writeError(io, "usage_error", validation.message, validation.details);
  }
  const rawStatus = readFlag(argv, "--status") ?? "pending";
  if (!isOutboxStatus(rawStatus)) {
    return writeError(
      io,
      "usage_error",
      `outbox list --status must be pending, claimed, completed, or cancelled (got ${rawStatus})`,
      { status: rawStatus },
    );
  }
  const rawHandlerClass = readFlag(argv, "--handler-class");
  if (rawHandlerClass !== null && !isOutboxHandlerClass(rawHandlerClass)) {
    return writeError(
      io,
      "usage_error",
      `outbox list --handler-class must be workflow_intervention or delivery (got ${rawHandlerClass})`,
      { handler_class: rawHandlerClass },
    );
  }
  const filters: {
    status: OutboxStatus;
    taskId?: string;
    kind?: string;
    handlerClass?: OutboxHandlerClass;
    eligibleAtOrBefore: string;
    includeIneligible: boolean;
  } = {
    status: rawStatus,
    handlerClass: rawHandlerClass ?? "delivery",
    eligibleAtOrBefore: deps.clock.nowISO(),
    includeIneligible: argv.includes("--include-ineligible"),
  };
  const taskId = readFlag(argv, "--task");
  if (taskId !== null) filters.taskId = taskId;
  const kind = readFlag(argv, "--kind");
  if (kind !== null) filters.kind = kind;
  const rows = rawHandlerClass === null
    ? listDeliveryOutboxItems(deps.db, filters)
    : listOutboxItems(deps.db, filters);
  io.stdout(`${JSON.stringify(rows)}\n`);
  return { exitCode: 0 };
}

function handleOutboxClaim(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  const validation = validateFlags(argv, {
    valued: ["--claim-id"],
  });
  if (!validation.ok) {
    return writeError(io, "usage_error", validation.message, validation.details);
  }
  const parsed = parsePositiveIntArg(positional(argv), "outbox claim");
  if (!parsed.ok) return writeError(io, "usage_error", parsed.message);
  const claimId = readFlag(argv, "--claim-id") ?? undefined;
  const input: { outboxItemId: number; claimId?: string } = {
    outboxItemId: parsed.value,
  };
  if (claimId !== undefined) input.claimId = claimId;
  return emitServiceResult(
    claimOutboxItem(
      { db: deps.db, clock: deps.clock },
      input,
    ),
    io,
  );
}

function handleOutboxComplete(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  const validation = validateFlags(argv, {
    valued: ["--claim-id"],
  });
  if (!validation.ok) {
    return writeError(io, "usage_error", validation.message, validation.details);
  }
  const parsed = parsePositiveIntArg(positional(argv), "outbox complete");
  const claimId = readFlag(argv, "--claim-id");
  if (!parsed.ok || !claimId) {
    return writeError(
      io,
      "usage_error",
      !parsed.ok
        ? parsed.message
        : "outbox complete requires <outbox_item_id> --claim-id <id>",
    );
  }
  return emitServiceResult(
    completeOutboxItem(
      { db: deps.db, clock: deps.clock },
      { outboxItemId: parsed.value, claimId },
    ),
    io,
  );
}

function handleOutboxFail(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  const validation = validateFlags(argv, {
    valued: ["--claim-id", "--error", "--next-eligible-at"],
  });
  if (!validation.ok) {
    return writeError(io, "usage_error", validation.message, validation.details);
  }
  const parsed = parsePositiveIntArg(positional(argv), "outbox fail");
  const claimId = readFlag(argv, "--claim-id");
  const lastError = readFlag(argv, "--error");
  if (!parsed.ok || !claimId || !lastError) {
    return writeError(
      io,
      "usage_error",
      !parsed.ok
        ? parsed.message
        : "outbox fail requires <outbox_item_id> --claim-id <id> --error <message>",
    );
  }
  return emitServiceResult(
    failOutboxItem(
      { db: deps.db, clock: deps.clock },
      {
        outboxItemId: parsed.value,
        claimId,
        lastError,
        nextEligibleAt: readFlag(argv, "--next-eligible-at"),
      },
    ),
    io,
  );
}

function isOutboxStatus(s: string): s is OutboxStatus {
  return (
    s === "pending" ||
    s === "claimed" ||
    s === "completed" ||
    s === "cancelled"
  );
}

function isOutboxHandlerClass(s: string): s is OutboxHandlerClass {
  return s === "workflow_intervention" || s === "delivery";
}

async function handleTask(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): Promise<DispatchResult> {
  if (argv.length === 0) {
    // Bare `quay task`: keep the structured envelope (machine consumers may
    // still rely on it) but show the noun's usage block on the next line.
    return writeErrorWithUsage(
      io,
      ["task"],
      "usage_error",
      "task subcommand required",
    );
  }
  const [sub, ...rest] = argv;
  // `quay task --help` (or `-h` / `help`) prints the noun's usage on stdout.
  if (isHelpToken(sub as string)) return printHelp(io, ["task"]);
  // Per-subcommand --help is recognised by the leaf handlers via wantsHelp().
  switch (sub) {
    case "list":
      if (wantsHelp(rest)) return printHelp(io, ["task", "list"]);
      return handleTaskList(rest, deps, io);
    case "get":
      if (wantsHelp(rest)) return printHelp(io, ["task", "get"]);
      return handleTaskGet(rest, deps, io);
    case "events":
      if (wantsHelp(rest)) return printHelp(io, ["task", "events"]);
      return handleTaskEvents(rest, deps, io);
    case "claim":
      if (wantsHelp(rest)) return printHelp(io, ["task", "claim"]);
      return handleClaim(rest, deps, io);
    case "release-claim":
      if (wantsHelp(rest)) return printHelp(io, ["task", "release-claim"]);
      return handleReleaseClaim(rest, deps, io);
    case "retarget":
      if (wantsHelp(rest)) return printHelp(io, ["task", "retarget"]);
      return await handleTaskRetarget(rest, deps, io);
    case "recreate-worktree":
      if (wantsHelp(rest)) return printHelp(io, ["task", "recreate-worktree"]);
      return await handleTaskRecreateWorktree(rest, deps, io);
    default:
      // A typo'd subcommand benefits from the noun's usage block as much as
      // a missing one — surface it on stderr alongside the structured envelope.
      return writeErrorWithUsage(
        io,
        ["task"],
        "usage_error",
        `unknown task subcommand: ${sub}`,
      );
  }
}

async function handleTaskRecreateWorktree(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): Promise<DispatchResult> {
  const validation = validateFlags(argv, {
    boolean: ["--yes", "--force"],
  });
  if (!validation.ok) {
    return writeError(io, "usage_error", validation.message, validation.details);
  }
  const taskId = positional(argv);
  if (!taskId) {
    return writeError(
      io,
      "usage_error",
      "task recreate-worktree requires <task_id>",
    );
  }
  const recreateDeps: RecreateWorktreeDeps = {
    db: deps.db,
    clock: deps.clock,
    git: deps.git,
    commandRunner: deps.commandRunner,
    supervisorLock: deps.supervisorLock,
  };
  return emitServiceResult(
    await recreate_task_worktree(recreateDeps, {
      taskId,
      yes: argv.includes("--yes"),
      force: argv.includes("--force"),
    }),
    io,
  );
}

async function handleTaskRetarget(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): Promise<DispatchResult> {
  const validation = validateFlags(argv, {
    boolean: ["--yes"],
    valued: ["--repo", "--base-branch"],
  });
  if (!validation.ok) {
    return writeError(io, "usage_error", validation.message, validation.details);
  }
  const taskId = positional(argv);
  if (!taskId) {
    return writeError(io, "usage_error", "task retarget requires <task_id>");
  }
  const targetRepo = readFlag(argv, "--repo");
  if (targetRepo === null) {
    return writeError(io, "usage_error", "task retarget requires --repo <target_repo>");
  }
  const retargetDeps: RetargetDeps = {
    db: deps.db,
    clock: deps.clock,
    ids: deps.ids,
    git: deps.git,
    tmux: deps.tmux,
    commandRunner: deps.commandRunner,
    artifactStore: deps.artifactStore,
    supervisorLock: deps.supervisorLock,
    paths: deps.paths,
    agentResolver: deps.agentResolver,
    referenceReposRoot: deps.tickOptions?.referenceReposRoot,
  };
  const input: { taskId: string; targetRepo: string; baseBranch?: string; yes: boolean } = {
    taskId,
    targetRepo,
    yes: argv.includes("--yes"),
  };
  const baseBranch = readFlag(argv, "--base-branch");
  if (baseBranch !== null) input.baseBranch = baseBranch;
  return emitServiceResult(await task_retarget(retargetDeps, input), io);
}

// Common "explicit --help" path for any command/subcommand: prints to stdout,
// exits 0. Returns a no-op `{exitCode: 1}` if the path isn't registered, but
// this should never fire in practice (the path is always one we control).
function printHelp(io: CliIO, path: string[]): DispatchResult {
  const block = commandHelp(path);
  if (block === null) {
    return writeError(io, "usage_error", `no help for: ${path.join(" ")}`);
  }
  io.stdout(block);
  return { exitCode: 0 };
}

function handleTaskList(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  const states = collectFlagValues(argv, "--state");
  const repo = readFlag(argv, "--repo");
  const externalRef = readFlag(argv, "--external-ref");
  const rows = listTasks(deps.db).filter((r) => {
    if (states.length > 0 && !states.includes(r.state)) return false;
    if (repo !== null && r.repo_id !== repo) return false;
    if (externalRef !== null && r.external_ref !== externalRef) return false;
    return true;
  });
  io.stdout(`${JSON.stringify(rows)}\n`);
  return { exitCode: 0 };
}

function handleTaskGet(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  const taskId = positional(argv);
  if (!taskId) {
    return writeError(io, "usage_error", "task get requires <task_id>");
  }
  const payload = getTask(deps.db, taskId);
  if (!payload) {
    return writeError(io, "unknown_task", `task ${taskId} not found`, {
      task_id: taskId,
    });
  }
  io.stdout(`${JSON.stringify(payload)}\n`);
  return { exitCode: 0 };
}

interface EventRow {
  event_id: number;
  task_id: string;
  work_item_id: string | null;
  run_number: number | null;
  superseded_by_run: string | null;
  attempt_id: number | null;
  event_type: string;
  from_state: string | null;
  to_state: string | null;
  payload_artifact_id: number | null;
  occurred_at: string;
}

function handleTaskEvents(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  const taskId = positional(argv);
  if (!taskId) {
    return writeError(io, "usage_error", "task events requires <task_id>");
  }
  // `task events` returns the full append-only log, oldest first, so callers
  // can stream/replay transitions without reconciling reverse-order results.
  const events = deps.db
    .query<EventRow, [string]>(
      `SELECT e.event_id, e.task_id, t.work_item_id, t.run_number,
              (
                SELECT successor.task_id
                  FROM tasks successor
                 WHERE successor.supersedes_task_id = e.task_id
                 ORDER BY successor.run_number DESC, successor.created_at DESC, successor.task_id DESC
                 LIMIT 1
              ) AS superseded_by_run,
              e.attempt_id, e.event_type, e.from_state, e.to_state,
              e.payload_artifact_id, e.occurred_at
         FROM events e
         JOIN tasks t ON t.task_id = e.task_id
        WHERE e.task_id = ?
        ORDER BY e.occurred_at ASC, e.event_id ASC`,
    )
    .all(taskId);
  io.stdout(`${JSON.stringify(events)}\n`);
  return { exitCode: 0 };
}

async function handleTick(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): Promise<DispatchResult> {
  if (wantsHelp(argv)) return printHelp(io, ["tick"]);
  const tickDeps: TickDeps = pickTickDeps(deps);
  // The agent resolver lives on `deps` because the repo CLI handlers
  // also need it for override validation, but `tick_once` reads it off
  // `TickOptions`. We merge it in here so a deployment's `[agents]`
  // block is honoured without `index.ts` having to know about
  // `TickOptions`.
  const tickOptions: TickOptions = {
    ...(deps.tickOptions ?? {}),
    agentResolver: deps.agentResolver,
  };
  const results = await tick_once(tickDeps, tickOptions);
  for (const r of results) {
    io.stdout(`${JSON.stringify(r)}\n`);
  }
  return { exitCode: 0 };
}

async function handleEnqueue(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): Promise<DispatchResult> {
  if (wantsHelp(argv)) return printHelp(io, ["enqueue"]);
  const validation = validateFlags(argv, {
    boolean: [
      "--request-pr-screenshots",
      "--require-pr-screenshots",
      "--as-normal-task",
    ],
    valued: [
      "--input",
      "--repo",
      "--brief-file",
      "--base-branch",
      "--ticket-snapshot-file",
      "--external-ref",
      "--slack-thread-ref",
      "--worker-execution",
      "--worker-agent",
      "--worker-model",
      "--reviewer-agent",
      "--reviewer-model",
      "--linear-issue",
      "--tag",
    ],
  });
  if (!validation.ok) {
    return writeError(io, "usage_error", validation.message, validation.details);
  }
  // --linear-issue routes to the adapter-driven flow (spec §8). Mutually
  // exclusive flags are rejected before any adapter / DB call so a bad
  // invocation (e.g. caller passes both forms) costs nothing.
  const linearIssue = readFlag(argv, "--linear-issue");
  if (linearIssue !== null) {
    return handleEnqueueLinearIssueFlow(argv, deps, io, linearIssue);
  }

  const json = tryParseJsonFlag(argv);
  if (!json.ok) return writeError(io, "usage_error", json.message);
  let input: Record<string, unknown>;
  if (json.value !== undefined) {
    input = json.value as Record<string, unknown>;
  } else {
    // Spec §10: enqueue takes flag-based inputs.
    const repoId = readFlag(argv, "--repo");
    if (repoId === null) {
      return writeError(io, "usage_error", "enqueue requires --repo <id>");
    }
    const briefPath = readFlag(argv, "--brief-file");
    if (briefPath === null) {
      return writeError(io, "usage_error", "enqueue requires --brief-file <path>");
    }
    const ticketPath = readFlag(argv, "--ticket-snapshot-file");
    const externalRef = readFlag(argv, "--external-ref");
    const slackThreadRef = readFlag(argv, "--slack-thread-ref");
    const workerAgent = readFlag(argv, "--worker-agent");
    const workerModel = readFlag(argv, "--worker-model");
    const reviewerAgent = readFlag(argv, "--reviewer-agent");
    const reviewerModel = readFlag(argv, "--reviewer-model");
    const workerExecution = readFlag(argv, "--worker-execution");
    const baseBranch = readFlag(argv, "--base-branch");
    const requestPrScreenshots = argv.includes("--request-pr-screenshots");
    const requirePrScreenshots = argv.includes("--require-pr-screenshots");
    const tags = collectFlagValues(argv, "--tag");
    const briefRead = tryReadFile(briefPath);
    if (!briefRead.ok) return writeError(io, "usage_error", briefRead.message);
    input = { repo_id: repoId, brief: briefRead.value };
    if (ticketPath !== null) {
      const t = tryReadFile(ticketPath);
      if (!t.ok) return writeError(io, "usage_error", t.message);
      input.ticket_snapshot = t.value;
    }
    if (externalRef !== null) input.external_ref = externalRef;
    if (slackThreadRef !== null) input.slack_thread_ref = slackThreadRef;
    if (baseBranch !== null) input.base_branch = baseBranch;
    if (requestPrScreenshots) input.request_pr_screenshots = true;
    if (requirePrScreenshots) input.require_pr_screenshots = true;
    const agentErr = validateTaskSelectionOverrides(
      {
        worker_agent: workerAgent,
        worker_model: workerModel,
        reviewer_agent: reviewerAgent,
        reviewer_model: reviewerModel,
      },
      deps.agentResolver,
      io,
    );
    if (agentErr !== null) return agentErr;
    if (workerAgent !== null) input.worker_agent = workerAgent;
    if (workerModel !== null) input.worker_model = workerModel;
    if (reviewerAgent !== null) input.reviewer_agent = reviewerAgent;
    if (reviewerModel !== null) input.reviewer_model = reviewerModel;
    if (workerExecution !== null) {
      if (workerExecution !== "oneshot" && workerExecution !== "goal") {
        return writeError(
          io,
          "usage_error",
          `--worker-execution must be oneshot or goal (got ${workerExecution})`,
          { worker_execution: workerExecution },
        );
      }
      input.worker_execution = workerExecution;
    }
    if (tags.length > 0) input.tags = tags;
  }
  const enqueueDeps: EnqueueDeps = {
    db: deps.db,
    clock: deps.clock,
    ids: deps.ids,
    git: deps.git,
    commandRunner: deps.commandRunner,
    artifactStore: deps.artifactStore,
    paths: deps.paths,
    agentResolver: deps.agentResolver,
    referenceReposRoot: deps.tickOptions?.referenceReposRoot,
  };
  if (deps.retryBudget !== undefined) {
    enqueueDeps.retryBudget = deps.retryBudget;
  }
  const result = enqueue(enqueueDeps, input);
  io.stdout(`${JSON.stringify(result)}\n`);
  return { exitCode: 0 };
}

function handleReviewPr(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  if (wantsHelp(argv)) return printHelp(io, ["review-pr"]);
  const validation = validateFlags(argv, {
    valued: ["--pr", "--head-sha", "--tag", "--reviewer-agent", "--reviewer-model"],
  });
  if (!validation.ok) {
    return writeErrorWithExit(
      io,
      2,
      "usage_error",
      validation.message,
      validation.details,
    );
  }
  const prArg = readFlag(argv, "--pr");
  if (prArg === null) {
    return writeErrorWithExit(
      io,
      2,
      "usage_error",
      "review-pr requires --pr <repo>:<num>",
    );
  }
  const parsedPr = parsePrIdentifier(prArg);
  if (parsedPr === null) {
    return writeErrorWithExit(
      io,
      2,
      "usage_error",
      `--pr must be <repo>:<num> (got ${prArg})`,
      { pr: prArg },
    );
  }
  const repoId = resolveRepoIdForPr(deps.db, parsedPr.repo);
  if (repoId === null) {
    return writeErrorWithExit(
      io,
      2,
      "repo_not_configured",
      `repo "${parsedPr.repo}" is not configured`,
      { repo: parsedPr.repo },
    );
  }
  const headSha = readFlag(argv, "--head-sha");
  let result: EnterReviewResult;
  try {
    const input: {
      repoId: string;
      prNumber: number;
      headSha?: string;
      tags: string[];
      reviewerEnabled: boolean;
      gateQuayOwnedDone: boolean;
      reviewerAgent?: string;
      reviewerModel?: string;
      referenceReposRoot?: string | undefined;
      ciIgnorePolicy?: TickOptions["ciIgnorePolicy"] | undefined;
    } = {
      repoId,
      prNumber: parsedPr.prNumber,
      tags: collectFlagValues(argv, "--tag"),
      reviewerEnabled: deps.tickOptions?.reviewerEnabled === true,
      gateQuayOwnedDone: deps.tickOptions?.gateQuayOwnedDone === true,
      referenceReposRoot: deps.tickOptions?.referenceReposRoot,
      ciIgnorePolicy: deps.tickOptions?.ciIgnorePolicy,
    };
    if (headSha !== null) input.headSha = headSha;
    const reviewerAgent = readFlag(argv, "--reviewer-agent");
    const reviewerModel = readFlag(argv, "--reviewer-model");
    const agentErr = validateTaskSelectionOverrides(
      { reviewer_agent: reviewerAgent, reviewer_model: reviewerModel },
      deps.agentResolver,
      io,
    );
    if (agentErr !== null) return agentErr;
    if (reviewerAgent !== null) input.reviewerAgent = reviewerAgent;
    if (reviewerModel !== null) input.reviewerModel = reviewerModel;
    result = enterReview(
      {
        db: deps.db,
        clock: deps.clock,
        github: deps.github,
        artifactStore: deps.artifactStore,
        tmux: deps.tmux,
        paths: { worktreesRoot: deps.paths.worktreesRoot },
        agentResolver: deps.agentResolver,
      },
      input,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof EnterReviewError) {
      if (err.kind === "reviewer_disabled") {
        return writeErrorWithExit(io, 2, "reviewer_disabled", message);
      }
      return writeErrorWithExit(io, 3, "pr_not_found", message, { pr: prArg });
    }
    return writeErrorWithExit(io, 4, "quay_error", message);
  }
  io.stdout(`${JSON.stringify(result)}\n`);
  return { exitCode: 0 };
}

async function handleAdoptPr(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): Promise<DispatchResult> {
  if (wantsHelp(argv)) return printHelp(io, ["adopt-pr"]);
  const validation = validateFlags(argv, { valued: ["--pr"] });
  if (!validation.ok) {
    return writeErrorWithExit(
      io,
      2,
      "usage_error",
      validation.message,
      validation.details,
    );
  }
  const prArg = readFlag(argv, "--pr");
  if (prArg === null) {
    return writeErrorWithExit(
      io,
      2,
      "usage_error",
      "adopt-pr requires --pr <repo>:<num>",
    );
  }
  const parsedPr = parsePrIdentifier(prArg);
  if (parsedPr === null) {
    return writeErrorWithExit(
      io,
      2,
      "usage_error",
      `--pr must be <repo>:<num> (got ${prArg})`,
      { pr: prArg },
    );
  }
  const repoId = resolveRepoIdForPr(deps.db, parsedPr.repo);
  if (repoId === null) {
    return writeErrorWithExit(
      io,
      2,
      "repo_not_configured",
      `repo "${parsedPr.repo}" is not configured`,
      { repo: parsedPr.repo },
    );
  }

  let result: AdoptPrResult;
  try {
    result = await deps.supervisorLock.run(() =>
      adoptPr(
        {
          db: deps.db,
          clock: deps.clock,
          github: deps.github,
          git: deps.git,
          commandRunner: deps.commandRunner,
          tmux: deps.tmux,
          artifactStore: deps.artifactStore,
          paths: deps.paths,
          agentResolver: deps.agentResolver,
          reviewerEnabled: deps.tickOptions?.reviewerEnabled === true,
          gateQuayOwnedDone: deps.tickOptions?.gateQuayOwnedDone === true,
          referenceReposRoot: deps.tickOptions?.referenceReposRoot,
        },
        { repoId, prNumber: parsedPr.prNumber },
      ),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof AdoptPrError) {
      if (err.kind === "pr_not_found") {
        return writeErrorWithExit(io, 3, "pr_not_found", message, { pr: prArg });
      }
      return writeErrorWithExit(io, 4, err.kind, message, { pr: prArg });
    }
    return writeErrorWithExit(io, 4, "quay_error", message);
  }
  io.stdout(`${JSON.stringify(result)}\n`);
  return { exitCode: 0 };
}

async function handleUnadopt(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): Promise<DispatchResult> {
  if (wantsHelp(argv)) return printHelp(io, ["unadopt"]);
  const validation = validateFlags(argv, { valued: ["--pr"] });
  if (!validation.ok) {
    return writeErrorWithExit(
      io,
      2,
      "usage_error",
      validation.message,
      validation.details,
    );
  }

  const prArg = readFlag(argv, "--pr");
  const taskArg = positional(argv);
  if (prArg !== null && taskArg !== null) {
    return writeErrorWithExit(
      io,
      2,
      "usage_error",
      "unadopt accepts either --pr <repo>:<num> or <task_id>, not both",
    );
  }
  if (prArg === null && taskArg === null) {
    return writeErrorWithExit(
      io,
      2,
      "usage_error",
      "unadopt requires --pr <repo>:<num> or <task_id>",
    );
  }

  const target = prArg !== null
    ? resolveUnadoptTargetByPr(deps.db, prArg)
    : resolveUnadoptTargetByTask(deps.db, taskArg as string);
  if (!target.ok) {
    return writeErrorWithExit(
      io,
      target.exitCode,
      target.error,
      target.message,
      target.details,
    );
  }
  if (target.value.authoring_mode !== "adopted_external_pr") {
    return writeErrorWithExit(
      io,
      4,
      "not_adopted",
      `task ${target.value.task_id} is not an adopted PR task`,
      {
        task_id: target.value.task_id,
        authoring_mode: target.value.authoring_mode,
      },
    );
  }

  const cancelDeps: CancelDeps = {
    db: deps.db,
    clock: deps.clock,
    git: deps.git,
    github: deps.github,
    tmux: deps.tmux,
    artifactStore: deps.artifactStore,
    supervisorLock: deps.supervisorLock,
  };
  const cancelLinear = pickLinearAdapter(deps);
  if (cancelLinear !== undefined) cancelDeps.linear = cancelLinear;
  const result: CancelResult = await cancel_task(cancelDeps, {
    taskId: target.value.task_id,
  });
  if (!result.ok) return emitServiceResult(result, io);

  io.stdout(
    `${JSON.stringify({
      ok: true,
      task_id: result.value.task_id,
      state: result.value.state,
      outcome: result.value.outcome === "already_cancelled"
        ? "already_unadopted"
        : "unadopted",
      unadopted: true,
      pr: target.value.pr_number === null
        ? null
        : `${target.value.repo_id}:${target.value.pr_number}`,
      branch_name: target.value.branch_name,
      message:
        "Quay has stood down from this adopted PR; the human-owned remote branch was preserved.",
    })}\n`,
  );
  return { exitCode: 0 };
}

async function handleEnqueueLinearIssueFlow(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
  identifier: string,
): Promise<DispatchResult> {
  // Spec §8 / §17: --linear-issue is mutually exclusive with --brief-file,
  // --external-ref, --slack-thread-ref. The adapter derives those latter two
  // from the Linear ticket, and accepting overrides on this path would
  // create a two-sources-of-truth trap. Reject before any side effect.
  const conflicts = ["--brief-file", "--external-ref", "--slack-thread-ref"];
  for (const flag of conflicts) {
    if (readFlag(argv, flag) !== null) {
      return writeError(
        io,
        "usage_error",
        `--linear-issue is mutually exclusive with ${flag}`,
        { conflicting_flag: flag },
      );
    }
  }
  // --repo is optional on the --linear-issue path; when absent the target repo
  // is read from the ticket's validated `repo` field. An explicit --repo wins.
  const repoId = readFlag(argv, "--repo");
  const baseBranch = readFlag(argv, "--base-branch");
  const cliTags = collectFlagValues(argv, "--tag");
  const agentErr = validateTaskSelectionOverrides(
    {
      worker_agent: readFlag(argv, "--worker-agent"),
      worker_model: readFlag(argv, "--worker-model"),
      reviewer_agent: readFlag(argv, "--reviewer-agent"),
      reviewer_model: readFlag(argv, "--reviewer-model"),
    },
    deps.agentResolver,
    io,
  );
  if (agentErr !== null) return agentErr;
  if (
    deps.linear === undefined ||
    deps.validatorRunner === undefined ||
    deps.adaptersConfig === undefined
  ) {
    return writeError(
      io,
      "adapter_not_enabled",
      "[adapters.linear] is not configured for this deployment",
      { adapter: "linear" },
    );
  }
  const enqueueDeps: EnqueueDeps = {
    db: deps.db,
    clock: deps.clock,
    ids: deps.ids,
    git: deps.git,
    commandRunner: deps.commandRunner,
    artifactStore: deps.artifactStore,
    paths: deps.paths,
    agentResolver: deps.agentResolver,
    referenceReposRoot: deps.tickOptions?.referenceReposRoot,
  };
  if (deps.retryBudget !== undefined) {
    enqueueDeps.retryBudget = deps.retryBudget;
  }
  return handleEnqueueLinearIssue(
    {
      repoId,
      identifier,
      cliTags,
      baseBranch,
      requestPrScreenshots: argv.includes("--request-pr-screenshots"),
      requirePrScreenshots: argv.includes("--require-pr-screenshots"),
      asNormalTask: argv.includes("--as-normal-task"),
      workerAgent: readFlag(argv, "--worker-agent"),
      workerModel: readFlag(argv, "--worker-model"),
      reviewerAgent: readFlag(argv, "--reviewer-agent"),
      reviewerModel: readFlag(argv, "--reviewer-model"),
      rerun: false,
    },
    {
      enqueueDeps,
      linear: deps.linear,
      slack: deps.slack,
      validatorRunner: deps.validatorRunner,
      adaptersConfig: deps.adaptersConfig,
    },
    io,
  );
}

async function handleRerun(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): Promise<DispatchResult> {
  if (wantsHelp(argv)) return printHelp(io, ["rerun"]);
  const validation = validateFlags(argv, {
    boolean: [
      "--request-pr-screenshots",
      "--require-pr-screenshots",
      "--as-normal-task",
    ],
    valued: [
      "--linear-issue",
      "--repo",
      "--base-branch",
      "--worker-agent",
      "--worker-model",
      "--reviewer-agent",
      "--reviewer-model",
      "--tag",
    ],
  });
  if (!validation.ok) {
    return writeError(io, "usage_error", validation.message, validation.details);
  }
  const flagIdentifier = readFlag(argv, "--linear-issue");
  const identifier = flagIdentifier ?? positional(argv);
  if (identifier === null) {
    return writeError(
      io,
      "usage_error",
      "rerun requires --linear-issue <id> or <id>",
    );
  }
  if (
    deps.linear === undefined ||
    deps.validatorRunner === undefined ||
    deps.adaptersConfig === undefined
  ) {
    return writeError(
      io,
      "adapter_not_enabled",
      "[adapters.linear] is not configured for this deployment",
      { adapter: "linear" },
    );
  }
  const agentErr = validateTaskSelectionOverrides(
    {
      worker_agent: readFlag(argv, "--worker-agent"),
      worker_model: readFlag(argv, "--worker-model"),
      reviewer_agent: readFlag(argv, "--reviewer-agent"),
      reviewer_model: readFlag(argv, "--reviewer-model"),
    },
    deps.agentResolver,
    io,
  );
  if (agentErr !== null) return agentErr;
  const enqueueDeps: EnqueueDeps = {
    db: deps.db,
    clock: deps.clock,
    ids: deps.ids,
    git: deps.git,
    commandRunner: deps.commandRunner,
    artifactStore: deps.artifactStore,
    paths: deps.paths,
    agentResolver: deps.agentResolver,
    referenceReposRoot: deps.tickOptions?.referenceReposRoot,
  };
  if (deps.retryBudget !== undefined) {
    enqueueDeps.retryBudget = deps.retryBudget;
  }
  return handleEnqueueLinearIssue(
    {
      repoId: readFlag(argv, "--repo"),
      identifier,
      cliTags: collectFlagValues(argv, "--tag"),
      baseBranch: readFlag(argv, "--base-branch"),
      requestPrScreenshots: argv.includes("--request-pr-screenshots"),
      requirePrScreenshots: argv.includes("--require-pr-screenshots"),
      asNormalTask: argv.includes("--as-normal-task"),
      workerAgent: readFlag(argv, "--worker-agent"),
      workerModel: readFlag(argv, "--worker-model"),
      reviewerAgent: readFlag(argv, "--reviewer-agent"),
      reviewerModel: readFlag(argv, "--reviewer-model"),
      rerun: true,
    },
    {
      enqueueDeps,
      linear: deps.linear,
      slack: deps.slack,
      validatorRunner: deps.validatorRunner,
      adaptersConfig: deps.adaptersConfig,
    },
    io,
  );
}

function handleRepo(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  if (argv.length === 0) {
    return writeErrorWithUsage(
      io,
      ["repo"],
      "usage_error",
      "repo subcommand required",
    );
  }
  const [sub, ...rest] = argv;
  if (isHelpToken(sub as string)) return printHelp(io, ["repo"]);
  const service = deps.repoService;
  switch (sub) {
    case "add":
      if (wantsHelp(rest)) return printHelp(io, ["repo", "add"]);
      return handleRepoAdd(rest, service, deps.agentResolver, io);
    case "update":
      if (wantsHelp(rest)) return printHelp(io, ["repo", "update"]);
      return handleRepoUpdate(rest, service, deps.agentResolver, io);
    case "remove": {
      if (wantsHelp(rest)) return printHelp(io, ["repo", "remove"]);
      const repoId = positional(rest);
      if (!repoId) {
        return writeError(io, "usage_error", "repo remove requires <repo_id>");
      }
      const row = service.remove(repoId);
      io.stdout(`${JSON.stringify(row)}\n`);
      return { exitCode: 0 };
    }
    case "list":
      if (wantsHelp(rest)) return printHelp(io, ["repo", "list"]);
      return handleRepoList(rest, service, io);
    case "export":
      if (wantsHelp(rest)) return printHelp(io, ["repo", "export"]);
      return handleRepoExport(rest, service, deps.db, io);
    case "import":
      if (wantsHelp(rest)) return printHelp(io, ["repo", "import"]);
      return handleRepoImport(rest, service, deps.db, io);
    case "set-tags":
      if (wantsHelp(rest)) return printHelp(io, ["repo", "set-tags"]);
      return handleRepoSetTags(rest, deps.tagService, io);
    case "unset-tags":
      if (wantsHelp(rest)) return printHelp(io, ["repo", "unset-tags"]);
      return handleRepoUnsetTags(rest, deps.tagService, io);
    case "get-tags":
      if (wantsHelp(rest)) return printHelp(io, ["repo", "get-tags"]);
      return handleRepoGetTags(rest, deps.tagService, io);
    case "apply-tags":
      if (wantsHelp(rest)) return printHelp(io, ["repo", "apply-tags"]);
      return handleRepoApplyTags(rest, deps.tagService, io);
    case "guidance-get":
      if (wantsHelp(rest)) return printHelp(io, ["repo", "guidance-get"]);
      return handleRepoGuidanceGet(rest, deps.db, io);
    case "guidance-set":
      if (wantsHelp(rest)) return printHelp(io, ["repo", "guidance-set"]);
      return handleRepoGuidanceSet(rest, deps.db, deps.clock, io);
    default:
      // Mirror bare `quay repo`: structured envelope plus the noun's usage
      // block so a typo gets the same recovery hint as the missing-sub case.
      return writeErrorWithUsage(
        io,
        ["repo"],
        "usage_error",
        `unknown repo subcommand: ${sub}`,
      );
  }
}

const REPO_FLAGS: Array<{ flag: string; key: string }> = [
  { flag: "--id", key: "repo_id" },
  { flag: "--url", key: "repo_url" },
  { flag: "--base-branch", key: "base_branch" },
  { flag: "--package-manager", key: "package_manager" },
  { flag: "--install-cmd", key: "install_cmd" },
  { flag: "--test-cmd", key: "test_cmd" },
  { flag: "--ci-workflow-name", key: "ci_workflow_name" },
  { flag: "--contribution-guide-path", key: "contribution_guide_path" },
  { flag: "--agent-worker", key: "agent_worker" },
  { flag: "--agent-reviewer", key: "agent_reviewer" },
  { flag: "--model-worker", key: "model_worker" },
  { flag: "--model-reviewer", key: "model_reviewer" },
  { flag: "--preamble-worker", key: "preamble_worker" },
  { flag: "--preamble-reviewer", key: "preamble_reviewer" },
];

// On `repo update`, an empty string for a repo override means "clear it" and
// fall back to the deployment/global default. We translate that here
// rather than burdening every call site, and only on update (add does
// not accept clearing a field that was never set).
function normalizeRepoOverrideClearing(
  patch: Record<string, string>,
): Record<string, string | null> {
  const out: Record<string, string | null> = { ...patch };
  for (const key of [
    "agent_worker",
    "agent_reviewer",
    "model_worker",
    "model_reviewer",
    "preamble_worker",
    "preamble_reviewer",
  ] as const) {
    if (out[key] === "") out[key] = null;
  }
  return out;
}

function validateAgentOverrides(
  input: { agent_worker?: string | null; agent_reviewer?: string | null },
  resolver: AgentResolver,
  io: CliIO,
): DispatchResult | null {
  const registered = new Set(resolver.registeredAgents());
  for (const key of ["agent_worker", "agent_reviewer"] as const) {
    const v = input[key];
    if (typeof v === "string" && !registered.has(v)) {
      return writeError(
        io,
        "usage_error",
        `${key.replace("_", "-")}: agent "${v}" is not registered in [agents.invocations]; known: ${[...registered].sort().join(", ")}`,
        { agent: v, registered: [...registered].sort() },
      );
    }
  }
  return null;
}

function validateTaskSelectionOverrides(
  input: {
    worker_agent?: string | null;
    worker_model?: string | null;
    reviewer_agent?: string | null;
    reviewer_model?: string | null;
  },
  resolver: AgentResolver,
  io: CliIO,
): DispatchResult | null {
  const registered = new Set(resolver.registeredAgents());
  for (const key of ["worker_agent", "reviewer_agent"] as const) {
    const v = input[key];
    if (typeof v === "string" && !registered.has(v)) {
      return writeError(
        io,
        "usage_error",
        `${key.replace("_", "-")}: agent "${v}" is not registered in [agents.invocations]; known: ${[...registered].sort().join(", ")}`,
        { agent: v, registered: [...registered].sort() },
      );
    }
  }
  for (const key of ["worker_model", "reviewer_model"] as const) {
    const v = input[key];
    if (v !== undefined && v !== null && v.trim() === "") {
      return writeError(
        io,
        "usage_error",
        `${key.replace("_", "-")} must not be empty`,
        { flag: `--${key.replace("_", "-")}` },
      );
    }
  }
  return null;
}

function handleRepoAdd(
  argv: string[],
  service: RepoService,
  resolver: AgentResolver,
  io: CliIO,
): DispatchResult {
  const json = tryParseJsonFlag(argv);
  if (!json.ok) return writeError(io, "usage_error", json.message);
  const input = json.value !== undefined ? json.value : flagsToObject(argv, REPO_FLAGS);
  const overrideErr = validateAgentOverrides(
    input as { agent_worker?: string; agent_reviewer?: string },
    resolver,
    io,
  );
  if (overrideErr !== null) return overrideErr;
  const row = service.add(input);
  io.stdout(`${JSON.stringify(row)}\n`);
  return { exitCode: 0 };
}

function handleRepoUpdate(
  argv: string[],
  service: RepoService,
  resolver: AgentResolver,
  io: CliIO,
): DispatchResult {
  const repoId = readFlag(argv, "--id") ?? positional(argv);
  if (!repoId) {
    return writeError(io, "usage_error", "repo update requires --id <repo_id>");
  }
  const json = tryParseJsonFlag(argv);
  if (!json.ok) return writeError(io, "usage_error", json.message);
  // `--agent-worker ""` on the flag form means "clear the override and
  // fall back to the deployment default". JSON callers express the
  // same with an explicit `null` and don't go through the empty-string
  // shim. Validation runs after the rewrite so it never rejects "".
  const patch = json.value !== undefined
    ? (json.value as Record<string, unknown>)
    : (normalizeRepoOverrideClearing(
        flagsToObject(
          argv,
          REPO_FLAGS.filter((f) => f.flag !== "--id"),
        ),
      ) as Record<string, unknown>);
  const overrideErr = validateAgentOverrides(
    patch as { agent_worker?: string | null; agent_reviewer?: string | null },
    resolver,
    io,
  );
  if (overrideErr !== null) return overrideErr;
  const row = service.update(repoId, patch);
  io.stdout(`${JSON.stringify(row)}\n`);
  return { exitCode: 0 };
}

function parseRepoGuidanceRole(raw: string, io: CliIO): RepoGuidanceRole | null {
  if (raw === "worker" || raw === "reviewer") return raw;
  writeError(io, "usage_error", `repo guidance role must be worker or reviewer (got ${raw})`, {
    role: raw,
  });
  return null;
}

function handleRepoGuidanceGet(
  argv: string[],
  db: DB,
  io: CliIO,
): DispatchResult {
  const validation = validateFlags(argv, { valued: ["--role"], boolean: ["--history"] });
  if (!validation.ok) return writeError(io, "usage_error", validation.message, validation.details);
  const repoId = positional(argv);
  if (!repoId) return writeError(io, "usage_error", "repo guidance-get requires <repo_id>");
  const roleRaw = readFlag(argv, "--role");
  const role = roleRaw === null ? null : parseRepoGuidanceRole(roleRaw, io);
  if (roleRaw !== null && role === null) return { exitCode: 1 };
  const rows = argv.includes("--history")
    ? listRepoGuidance(db, repoId, role ?? undefined)
    : role === null
      ? {
          worker: latestRepoGuidance(db, repoId, "worker"),
          reviewer: latestRepoGuidance(db, repoId, "reviewer"),
        }
      : latestRepoGuidance(db, repoId, role);
  io.stdout(`${JSON.stringify(rows)}\n`);
  return { exitCode: 0 };
}

function handleRepoGuidanceSet(
  argv: string[],
  db: DB,
  clock: Clock,
  io: CliIO,
): DispatchResult {
  const validation = validateFlags(argv, {
    valued: ["--role", "--body", "--body-file"],
  });
  if (!validation.ok) return writeError(io, "usage_error", validation.message, validation.details);
  const repoId = positional(argv);
  if (!repoId) return writeError(io, "usage_error", "repo guidance-set requires <repo_id>");
  const roleRaw = readFlag(argv, "--role");
  if (roleRaw === null) {
    return writeError(io, "usage_error", "repo guidance-set requires --role <worker|reviewer>");
  }
  const role = parseRepoGuidanceRole(roleRaw, io);
  if (role === null) return { exitCode: 1 };
  const bodyRead = readBodyArg(argv, io, "repo guidance-set");
  if (!bodyRead.ok) return writeError(io, "usage_error", bodyRead.message);
  const row = createRepoGuidance(db, clock, { repoId, role, body: bodyRead.value });
  io.stdout(`${JSON.stringify(row)}\n`);
  return { exitCode: 0 };
}

function readBodyArg(
  argv: string[],
  io: CliIO,
  command: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const bodyFlag = readFlag(argv, "--body");
  const bodyFile = readFlag(argv, "--body-file");
  if ((bodyFlag === null && bodyFile === null) || (bodyFlag !== null && bodyFile !== null)) {
    return { ok: false, message: `${command} requires exactly one of --body or --body-file` };
  }
  if (bodyFlag !== null) return { ok: true, value: bodyFlag };
  if (bodyFile === "-") {
    if (io.stdin === undefined) return { ok: false, message: "stdin is not available" };
    return { ok: true, value: io.stdin() };
  }
  const fileRead = tryReadFile(bodyFile as string);
  return fileRead.ok ? { ok: true, value: fileRead.value } : fileRead;
}

function handleRepoList(
  argv: string[],
  service: RepoService,
  io: CliIO,
): DispatchResult {
  const validation = validateFlags(argv, { boolean: ["--active"] });
  if (!validation.ok) {
    return writeError(io, "usage_error", validation.message, validation.details);
  }
  const activeOnly = argv.includes("--active");
  io.stdout(`${JSON.stringify(service.list({ activeOnly }))}\n`);
  return { exitCode: 0 };
}

function handleRepoExport(
  argv: string[],
  service: RepoService,
  db: DB,
  io: CliIO,
): DispatchResult {
  const validation = validateFlags(argv, {
    boolean: ["--active"],
    valued: ["--out"],
  });
  if (!validation.ok) {
    return writeError(io, "usage_error", validation.message, validation.details);
  }
  const out = readFlag(argv, "--out");
  const activeOnly = argv.includes("--active");
  const rows = service.list({ activeOnly });
  const exportedRows = rows.map((row) => withExportedPreambleRecords(db, row));
  const body = JSON.stringify(exportedRows);
  if (out !== null) {
    try {
      writeFileSync(out, `${body}\n`, { encoding: "utf8" });
    } catch (err) {
      return writeError(
        io,
        "io_error",
        `failed to write export to ${out}: ${(err as Error).message}`,
      );
    }
    // Stdout still gets the operator-friendly summary, mirroring how `task
    // get` / `repo add` always emit something so a wrapping script can
    // verify success.
    io.stdout(`${JSON.stringify({ out, count: rows.length })}\n`);
    return { exitCode: 0 };
  }
  io.stdout(`${body}\n`);
  return { exitCode: 0 };
}

function handleRepoImport(
  argv: string[],
  service: RepoService,
  db: DB,
  io: CliIO,
): DispatchResult {
  const inputPath = readFlag(argv, "--in");
  if (inputPath === null) {
    return writeError(io, "usage_error", "repo import requires --in <path>");
  }
  const fileRead = tryReadFile(inputPath);
  if (!fileRead.ok) return writeError(io, "usage_error", fileRead.message);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileRead.value);
  } catch (err) {
    return writeError(
      io,
      "usage_error",
      `repo import: ${inputPath} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    return writeError(
      io,
      "usage_error",
      `repo import: ${inputPath} must contain a JSON array of repo rows`,
    );
  }
  // Per spec §10: "Upserts (idempotent for restore use)." Validation per
  // row happens inside `service.upsert`; on the first failure we surface
  // the structured error and abort. We deliberately do NOT wrap the loop
  // in a SQL transaction: the documented use case is a backup-restore
  // dump produced by `repo export`, so partial success on a malformed
  // dump still leaves a useful set of recovered rows for the operator
  // to inspect — the ones that imported are the prefix of the array up
  // to the failing row.
  const ids: string[] = [];
  for (const row of parsed) {
    const r = service.upsert(withImportedPreambleIds(db, row));
    ids.push(r.repo_id);
  }
  io.stdout(
    `${JSON.stringify({ imported: ids.length, repo_ids: ids })}\n`,
  );
  return { exitCode: 0 };
}

interface RepoExportPreambleRecord {
  preamble_id: number;
  kind: PreambleKind;
  body: string;
  created_at: string;
}

const REPO_EXPORT_PREAMBLE_FIELDS = [
  {
    idKey: "preamble_worker",
    recordKey: "preamble_worker_record",
    kind: "code",
  },
  {
    idKey: "preamble_reviewer",
    recordKey: "preamble_reviewer_record",
    kind: "review",
  },
] as const satisfies ReadonlyArray<{
  idKey: "preamble_worker" | "preamble_reviewer";
  recordKey: "preamble_worker_record" | "preamble_reviewer_record";
  kind: PreambleKind;
}>;

function withExportedPreambleRecords(
  db: DB,
  row: ReturnType<RepoService["list"]>[number],
): Record<string, unknown> {
  const exported: Record<string, unknown> = { ...row };
  for (const field of REPO_EXPORT_PREAMBLE_FIELDS) {
    const preambleId = row[field.idKey];
    if (preambleId === null) continue;
    exported[field.recordKey] = loadRepoExportPreambleRecord(
      db,
      preambleId,
      field.kind,
      row.repo_id,
    );
  }
  return exported;
}

function withImportedPreambleIds(db: DB, row: unknown): unknown {
  if (!isRecord(row)) return row;
  const imported: Record<string, unknown> = { ...row };
  for (const field of REPO_EXPORT_PREAMBLE_FIELDS) {
    delete imported[field.recordKey];
    const rawPreambleId = coercePositiveInteger(row[field.idKey]);
    if (rawPreambleId === null) continue;
    const record = parseRepoExportPreambleRecord(
      row[field.recordKey],
      field.kind,
      field.recordKey,
    );
    if (record === null) continue;
    if (record.preamble_id !== rawPreambleId) {
      throw new QuayError(
        "validation_error",
        `repo import ${field.recordKey}.preamble_id does not match ${field.idKey}`,
        {
          field: field.idKey,
          record_field: field.recordKey,
          preamble_id: rawPreambleId,
          record_preamble_id: record.preamble_id,
        },
      );
    }
    imported[field.idKey] = ensureImportedPreambleRecord(db, record);
  }
  return imported;
}

function loadRepoExportPreambleRecord(
  db: DB,
  preambleId: number,
  expectedKind: PreambleKind,
  repoId: string,
): RepoExportPreambleRecord {
  const row = db
    .query<
      { preamble_id: number; kind: string; body: string; created_at: string },
      [number]
    >(
      `SELECT preamble_id, kind, body, created_at
         FROM preambles
        WHERE preamble_id = ?`,
    )
    .get(preambleId);
  if (!row) {
    throw new QuayError(
      "validation_error",
      `repo ${repoId} references missing preamble ${preambleId}`,
      { repo_id: repoId, preamble_id: preambleId },
    );
  }
  if (row.kind !== expectedKind) {
    throw new QuayError(
      "validation_error",
      `repo ${repoId} preamble ${preambleId} has kind ${row.kind}; expected ${expectedKind}`,
      {
        repo_id: repoId,
        preamble_id: preambleId,
        actual_kind: row.kind,
        expected_kind: expectedKind,
      },
    );
  }
  return {
    preamble_id: row.preamble_id,
    kind: expectedKind,
    body: row.body,
    created_at: row.created_at,
  };
}

function parseRepoExportPreambleRecord(
  value: unknown,
  expectedKind: PreambleKind,
  recordField: string,
): RepoExportPreambleRecord | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    throw new QuayError(
      "validation_error",
      `repo import ${recordField} must be an object when present`,
      { field: recordField },
    );
  }
  const preambleId = coercePositiveInteger(value.preamble_id);
  if (preambleId === null) {
    throw new QuayError(
      "validation_error",
      `repo import ${recordField}.preamble_id must be a positive integer`,
      { field: recordField },
    );
  }
  if (value.kind !== expectedKind) {
    throw new QuayError(
      "validation_error",
      `repo import ${recordField}.kind must be ${expectedKind}`,
      { field: recordField, expected_kind: expectedKind, actual_kind: value.kind },
    );
  }
  if (typeof value.body !== "string") {
    throw new QuayError(
      "validation_error",
      `repo import ${recordField}.body must be a string`,
      { field: recordField },
    );
  }
  if (typeof value.created_at !== "string" || value.created_at === "") {
    throw new QuayError(
      "validation_error",
      `repo import ${recordField}.created_at must be a non-empty string`,
      { field: recordField },
    );
  }
  return {
    preamble_id: preambleId,
    kind: expectedKind,
    body: value.body,
    created_at: value.created_at,
  };
}

function ensureImportedPreambleRecord(
  db: DB,
  record: RepoExportPreambleRecord,
): number {
  if (record.kind === "review") {
    assertReviewerGuidanceProtocolSafe(
      record.body,
      `repo import preamble ${record.preamble_id}`,
    );
  }
  const existing = db
    .query<{ preamble_id: number }, [string, string, string]>(
      `SELECT preamble_id
         FROM preambles
        WHERE kind = ?
          AND body = ?
          AND created_at = ?
        ORDER BY preamble_id
        LIMIT 1`,
    )
    .get(record.kind, record.body, record.created_at);
  if (existing) return existing.preamble_id;

  const inserted = db
    .query<{ preamble_id: number }, [string, string, string]>(
      `INSERT INTO preambles (body, kind, created_at)
       VALUES (?, ?, ?)
       RETURNING preamble_id`,
    )
    .get(record.body, record.kind, record.created_at);
  if (!inserted) {
    throw new QuayError(
      "validation_error",
      "failed to import repo preamble record",
      { preamble_id: record.preamble_id, kind: record.kind },
    );
  }
  return inserted.preamble_id;
}

function coercePositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function handleRepoSetTags(
  argv: string[],
  tagService: TagService,
  io: CliIO,
): DispatchResult {
  const validation = validateFlags(argv, { valued: ["--namespace", "--value"] });
  if (!validation.ok) {
    return writeError(io, "usage_error", validation.message, validation.details);
  }
  const repoId = positional(argv);
  if (!repoId) {
    return writeError(io, "usage_error", "repo set-tags requires <repo_id>");
  }
  const ns = readFlag(argv, "--namespace");
  const value = readFlag(argv, "--value");
  if (!ns || !value) {
    return writeError(
      io,
      "usage_error",
      "repo set-tags requires --namespace <name> --value <v>",
    );
  }
  tagService.setValue("repo", repoId, ns, value);
  io.stdout(
    `${JSON.stringify({ ok: true, repo_id: repoId, namespace: ns, value })}\n`,
  );
  return { exitCode: 0 };
}

function handleRepoUnsetTags(
  argv: string[],
  tagService: TagService,
  io: CliIO,
): DispatchResult {
  // A typo on `--value` (e.g. `--vale`) without flag validation falls through
  // to the whole-namespace deletion path, silently destroying the entire
  // namespace + its required-flag.
  const validation = validateFlags(argv, { valued: ["--namespace", "--value"] });
  if (!validation.ok) {
    return writeError(io, "usage_error", validation.message, validation.details);
  }
  const repoId = positional(argv);
  if (!repoId) {
    return writeError(io, "usage_error", "repo unset-tags requires <repo_id>");
  }
  const ns = readFlag(argv, "--namespace");
  if (!ns) {
    return writeError(
      io,
      "usage_error",
      "repo unset-tags requires --namespace <name>",
    );
  }
  const value = readFlag(argv, "--value") ?? undefined;
  tagService.unsetValue("repo", repoId, ns, value);
  io.stdout(
    `${JSON.stringify({ ok: true, repo_id: repoId, namespace: ns, value: value ?? null })}\n`,
  );
  return { exitCode: 0 };
}

function handleRepoGetTags(
  argv: string[],
  tagService: TagService,
  io: CliIO,
): DispatchResult {
  const validation = validateFlags(argv, {});
  if (!validation.ok) {
    return writeError(io, "usage_error", validation.message, validation.details);
  }
  const repoId = positional(argv);
  if (!repoId) {
    return writeError(io, "usage_error", "repo get-tags requires <repo_id>");
  }
  const namespaces = tagService.getVocab("repo", repoId);
  io.stdout(`${JSON.stringify({ repo_id: repoId, namespaces })}\n`);
  return { exitCode: 0 };
}

function handleRepoApplyTags(
  argv: string[],
  tagService: TagService,
  io: CliIO,
): DispatchResult {
  const validation = validateFlags(argv, { valued: ["--from"] });
  if (!validation.ok) {
    return writeError(io, "usage_error", validation.message, validation.details);
  }
  const repoId = positional(argv);
  if (!repoId) {
    return writeError(io, "usage_error", "repo apply-tags requires <repo_id>");
  }
  const env = readNamespacesEnvelope(argv, "repo apply-tags", io);
  if (!env.ok) return env.result;
  const namespaces: TagVocab = tagService.apply("repo", repoId, env.namespaces);
  io.stdout(`${JSON.stringify({ ok: true, repo_id: repoId, namespaces })}\n`);
  return { exitCode: 0 };
}

// Shared `--from <path>` envelope reader for apply-tags / apply-deployment.
// Reads stdin or file, parses JSON, and validates the `{namespaces: object}`
// outer shape. Inner-shape validation lives in TagService.apply (zod).
function readNamespacesEnvelope(
  argv: string[],
  commandLabel: string,
  io: CliIO,
):
  | { ok: true; namespaces: unknown }
  | { ok: false; result: DispatchResult } {
  const fromPath = readFlag(argv, "--from");
  if (!fromPath) {
    return {
      ok: false,
      result: writeError(io, "usage_error", `${commandLabel} requires --from <path>`),
    };
  }
  const inputRead = readApplyTagsInput(fromPath, io);
  if (!inputRead.ok) {
    return { ok: false, result: writeError(io, "usage_error", inputRead.message) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputRead.value);
  } catch (err) {
    return {
      ok: false,
      result: writeError(
        io,
        "usage_error",
        `${commandLabel}: not valid JSON: ${(err as Error).message}`,
      ),
    };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("namespaces" in parsed) ||
    typeof (parsed as { namespaces: unknown }).namespaces !== "object" ||
    (parsed as { namespaces: unknown }).namespaces === null
  ) {
    return {
      ok: false,
      result: writeError(
        io,
        "usage_error",
        `${commandLabel}: input must be { "namespaces": { ... } }`,
      ),
    };
  }
  return { ok: true, namespaces: (parsed as { namespaces: unknown }).namespaces };
}

function readApplyTagsInput(
  fromPath: string,
  io: CliIO,
): { ok: true; value: string } | { ok: false; message: string } {
  if (fromPath === "-") {
    if (!io.stdin) return { ok: false, message: "no stdin source configured" };
    return { ok: true, value: io.stdin() };
  }
  return tryReadFile(fromPath);
}

function handleSettings(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  if (argv.length === 0) {
    return writeErrorWithUsage(
      io,
      ["settings"],
      "usage_error",
      "settings subcommand required",
    );
  }
  const [sub, ...rest] = argv;
  if (isHelpToken(sub as string)) return printHelp(io, ["settings"]);
  switch (sub) {
    case "import":
      if (wantsHelp(rest)) return printHelp(io, ["settings", "import"]);
      return handleSettingsImport(rest, deps, io);
    default:
      return writeErrorWithUsage(
        io,
        ["settings"],
        "usage_error",
        `unknown settings subcommand: ${sub}`,
      );
  }
}

function handleSettingsImport(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  const validation = validateFlags(argv, {
    valued: ["--from"],
    boolean: ["--only-empty"],
  });
  if (!validation.ok) {
    return writeError(io, "usage_error", validation.message, validation.details);
  }
  const fromPath = readFlag(argv, "--from");
  if (!fromPath) {
    return writeError(io, "usage_error", "settings import requires --from <path>");
  }
  const loaded = loadConfigFromPath(fromPath);
  const service = createDeploymentSettingsService({
    db: deps.db,
    clock: deps.clock,
  });
  const current = service.getRow();
  const imported = {
    worker_agent: loaded.config.agents?.worker ?? null,
    worker_model: loaded.config.agents?.worker_model ?? null,
    reviewer_agent: loaded.config.agents?.reviewer ?? null,
    reviewer_model: loaded.config.agents?.reviewer_model ?? null,
    // No config-file source for the review-finding toggle: leave it unset so
    // it resolves to ON (the current intended behavior).
    review_finding_linear_enabled: null,
  };
  const onlyEmpty = argv.includes("--only-empty");
  const next = onlyEmpty && current !== null ? current : imported;
  try {
    validateAgentSelection(buildAgentSelection(deps.config ?? loaded.config, next));
  } catch (error) {
    return writeError(
      io,
      "validation_error",
      error instanceof Error ? error.message : String(error),
    );
  }
  const row = onlyEmpty && current !== null ? current : service.replace(next);
  io.stdout(`${JSON.stringify({
    imported: {
      worker_agent: row.worker_agent,
      worker_model: row.worker_model,
      reviewer_agent: row.reviewer_agent,
      reviewer_model: row.reviewer_model,
    },
    config_path: loaded.configPath,
  })}\n`);
  return { exitCode: 0 };
}

function handleTags(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  if (argv.length === 0) {
    return writeErrorWithUsage(
      io,
      ["tags"],
      "usage_error",
      "tags subcommand required",
    );
  }
  const [sub, ...rest] = argv;
  if (isHelpToken(sub as string)) return printHelp(io, ["tags"]);
  const tagService = deps.tagService;
  switch (sub) {
    case "set-deployment":
      if (wantsHelp(rest)) return printHelp(io, ["tags", "set-deployment"]);
      return handleTagsSetDeployment(rest, tagService, io);
    case "unset-deployment":
      if (wantsHelp(rest)) return printHelp(io, ["tags", "unset-deployment"]);
      return handleTagsUnsetDeployment(rest, tagService, io);
    case "get-deployment":
      if (wantsHelp(rest)) return printHelp(io, ["tags", "get-deployment"]);
      return handleTagsGetDeployment(rest, tagService, io);
    case "apply-deployment":
      if (wantsHelp(rest)) return printHelp(io, ["tags", "apply-deployment"]);
      return handleTagsApplyDeployment(rest, tagService, io);
    case "import":
      if (wantsHelp(rest)) return printHelp(io, ["tags", "import"]);
      return handleTagsImport(rest, tagService, io);
    case "list":
      if (wantsHelp(rest)) return printHelp(io, ["tags", "list"]);
      return handleTagsList(rest, deps, io);
    default:
      return writeErrorWithUsage(
        io,
        ["tags"],
        "usage_error",
        `unknown tags subcommand: ${sub}`,
      );
  }
}

function handleTagsSetDeployment(
  argv: string[],
  tagService: TagService,
  io: CliIO,
): DispatchResult {
  const validation = validateFlags(argv, { valued: ["--namespace", "--value"] });
  if (!validation.ok) {
    return writeError(io, "usage_error", validation.message, validation.details);
  }
  const ns = readFlag(argv, "--namespace");
  const value = readFlag(argv, "--value");
  if (!ns || !value) {
    return writeError(
      io,
      "usage_error",
      "tags set-deployment requires --namespace <name> --value <v>",
    );
  }
  tagService.setValue("deployment", null, ns, value);
  io.stdout(
    `${JSON.stringify({ ok: true, scope: "deployment", namespace: ns, value })}\n`,
  );
  return { exitCode: 0 };
}

function handleTagsUnsetDeployment(
  argv: string[],
  tagService: TagService,
  io: CliIO,
): DispatchResult {
  const validation = validateFlags(argv, { valued: ["--namespace", "--value"] });
  if (!validation.ok) {
    return writeError(io, "usage_error", validation.message, validation.details);
  }
  const ns = readFlag(argv, "--namespace");
  if (!ns) {
    return writeError(
      io,
      "usage_error",
      "tags unset-deployment requires --namespace <name>",
    );
  }
  const value = readFlag(argv, "--value") ?? undefined;
  tagService.unsetValue("deployment", null, ns, value);
  io.stdout(
    `${JSON.stringify({ ok: true, scope: "deployment", namespace: ns, value: value ?? null })}\n`,
  );
  return { exitCode: 0 };
}

function handleTagsGetDeployment(
  argv: string[],
  tagService: TagService,
  io: CliIO,
): DispatchResult {
  const validation = validateFlags(argv, {});
  if (!validation.ok) {
    return writeError(io, "usage_error", validation.message, validation.details);
  }
  const namespaces = tagService.getVocab("deployment");
  io.stdout(`${JSON.stringify({ scope: "deployment", namespaces })}\n`);
  return { exitCode: 0 };
}

function handleTagsApplyDeployment(
  argv: string[],
  tagService: TagService,
  io: CliIO,
): DispatchResult {
  const validation = validateFlags(argv, { valued: ["--from"] });
  if (!validation.ok) {
    return writeError(io, "usage_error", validation.message, validation.details);
  }
  const env = readNamespacesEnvelope(argv, "tags apply-deployment", io);
  if (!env.ok) return env.result;
  const namespaces: TagVocab = tagService.apply("deployment", null, env.namespaces);
  io.stdout(`${JSON.stringify({ ok: true, scope: "deployment", namespaces })}\n`);
  return { exitCode: 0 };
}

function handleTagsImport(
  argv: string[],
  tagService: TagService,
  io: CliIO,
): DispatchResult {
  const validation = validateFlags(argv, {
    boolean: ["--force"],
    valued: ["--from"],
  });
  if (!validation.ok) {
    return writeError(io, "usage_error", validation.message, validation.details);
  }
  const fromPath = readFlag(argv, "--from");
  if (!fromPath) {
    return writeError(io, "usage_error", "tags import requires --from <path>");
  }
  const forceFlag = argv.includes("--force");
  const fileRead = tryReadFile(fromPath);
  if (!fileRead.ok) {
    return writeError(io, "usage_error", fileRead.message);
  }
  const desired = parseImportToml(fileRead.value);
  const current = tagService.getVocab("deployment");
  const plan = planImport(desired, current);
  if (plan.isNoop) {
    io.stdout(
      `${JSON.stringify({ ok: true, scope: "deployment", noop: true, namespaces: current })}\n`,
    );
    return { exitCode: 0 };
  }
  // Refuse to wipe a non-empty deployment vocab when the TOML carries no
  // namespaces — almost always a user typo (e.g. `[namespaces]` instead of
  // `[tags.namespaces]`). Explicit clearing goes through `apply-deployment`.
  if (Object.keys(desired).length === 0 && Object.keys(current).length > 0) {
    io.stderr(
      `${JSON.stringify({
        error: "empty_import",
        message:
          "TOML has no [tags.namespaces] entries; refusing to clear non-empty deployment vocab. Use `quay tags apply-deployment --from -` with `{\"namespaces\":{}}` to clear explicitly.",
        current,
      })}\n`,
    );
    return { exitCode: 1 };
  }
  if (plan.needsForce && !forceFlag) {
    io.stderr(
      `${JSON.stringify({
        error: "vocab_exists",
        message: "deployment tag vocab is non-empty; pass --force to overwrite",
        current,
      })}\n`,
    );
    return { exitCode: 1 };
  }
  const namespaces = tagService.apply("deployment", null, desired);
  io.stdout(
    `${JSON.stringify({ ok: true, scope: "deployment", namespaces })}\n`,
  );
  return { exitCode: 0 };
}

function handleTagsList(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  const validation = validateFlags(argv, { valued: ["--repo"] });
  if (!validation.ok) {
    return writeError(io, "usage_error", validation.message, validation.details);
  }
  const repoId = readFlag(argv, "--repo");
  if (!repoId) {
    return writeError(io, "usage_error", "tags list requires --repo <repo_id>");
  }
  // Explicit existence guard: tagService.getVocab("repo", id) also throws
  // unknown_repo, but routing the contract through the handler keeps
  // refactors that change the call order from silently dropping the check.
  if (!deps.repoService.get(repoId)) {
    return writeError(io, "unknown_repo", `repo "${repoId}" not found`, {
      repo_id: repoId,
    });
  }
  const perRepo = deps.tagService.getVocab("repo", repoId);
  const deployment = deps.tagService.getVocab("deployment");
  const { namespaces, enforced } = mergeVocab(deployment, perRepo);
  io.stdout(`${JSON.stringify({ repo_id: repoId, namespaces, enforced })}\n`);
  return { exitCode: 0 };
}

async function handleCancel(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): Promise<DispatchResult> {
  if (wantsHelp(argv)) return printHelp(io, ["cancel"]);
  const taskId = positional(argv);
  if (!taskId) {
    return writeError(io, "usage_error", "cancel requires <task_id>");
  }
  // Cancel is destructive (kills the tmux session, removes the worktree,
  // optionally closes the PR). A misspelled flag must NOT be silently
  // ignored — `cancel --keep-worktre` would otherwise behave like a
  // worktree-removing cancel because `--keep-worktree` evaluates false,
  // costing the operator the on-disk state they wanted to preserve. The
  // shared `validateFlags` helper rejects unknown flags AND the
  // `--keep-worktree=true` / `--close-pr=true` forms (which would otherwise
  // pass `argv.includes` but get ignored by the boolean detector).
  const validation = validateFlags(argv, {
    boolean: ["--close-pr", "--keep-worktree"],
  });
  if (!validation.ok) {
    return writeError(io, "usage_error", validation.message, validation.details);
  }
  const closePr = argv.includes("--close-pr");
  const keepWorktree = argv.includes("--keep-worktree");
  const cancelDeps: CancelDeps = {
    db: deps.db,
    clock: deps.clock,
    git: deps.git,
    github: deps.github,
    tmux: deps.tmux,
    artifactStore: deps.artifactStore,
    supervisorLock: deps.supervisorLock,
  };
  const cancelLinear = pickLinearAdapter(deps);
  if (cancelLinear !== undefined) cancelDeps.linear = cancelLinear;
  const result: CancelResult = await cancel_task(cancelDeps, {
    taskId,
    closePr,
    keepWorktree,
  });
  return emitServiceResult(result, io);
}

function handleClaim(argv: string[], deps: CliDeps, io: CliIO): DispatchResult {
  const taskId = positional(argv);
  if (!taskId) {
    return writeError(io, "usage_error", "task claim requires <task_id>");
  }
  const claimDeps: ClaimDeps = { db: deps.db, clock: deps.clock };
  return emitServiceResult(claim_task(claimDeps, { taskId }), io);
}

function handleReleaseClaim(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  const taskId = positional(argv);
  // `--claim-id <id>` is the spec form. Also accept a positional second arg
  // for backwards compatibility with the previous CLI wiring.
  const claimId = readFlag(argv, "--claim-id") ?? positionalAt(argv, 1);
  if (!taskId || !claimId) {
    return writeError(
      io,
      "usage_error",
      "task release-claim requires <task_id> --claim-id <claim_id>",
    );
  }
  const claimDeps: ClaimDeps = { db: deps.db, clock: deps.clock };
  return emitServiceResult(release_claim(claimDeps, { taskId, claimId }), io);
}

async function handleSubmitBrief(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): Promise<DispatchResult> {
  if (wantsHelp(argv)) return printHelp(io, ["submit-brief"]);
  const json = tryParseJsonFlag(argv);
  if (!json.ok) return writeError(io, "usage_error", json.message);
  let input: {
    taskId: string;
    claimId: string;
    brief: string;
    reason: string;
    goalTokenBudget?: number | null;
  };
  if (json.value !== undefined) {
    input = json.value as never;
  } else {
    const taskId = positional(argv);
    const claimId = readFlag(argv, "--claim-id");
    const briefFile = readFlag(argv, "--brief-file");
    const reason = readFlag(argv, "--reason");
    const goalTokenBudgetRaw = readFlag(argv, "--goal-token-budget");
    if (!taskId || !claimId || !briefFile || !reason) {
      return writeError(
        io,
        "usage_error",
        "submit-brief requires <task_id> --claim-id <id> --brief-file <path> --reason <blocker_resolved|advice_answered>",
      );
    }
    const briefRead = tryReadFile(briefFile);
    if (!briefRead.ok) return writeError(io, "usage_error", briefRead.message);
    input = { taskId, claimId, brief: briefRead.value, reason };
    if (goalTokenBudgetRaw !== null) {
      const parsed = parseGoalTokenBudget(goalTokenBudgetRaw);
      if (!parsed.ok) return writeError(io, "usage_error", parsed.message);
      input.goalTokenBudget = parsed.value;
    }
  }
  if (input.reason !== "blocker_resolved" && input.reason !== "advice_answered") {
    return writeError(
      io,
      "usage_error",
      `submit-brief --reason must be blocker_resolved or advice_answered (got ${input.reason})`,
    );
  }
  const submitDeps: SubmitBriefDeps = {
    db: deps.db,
    clock: deps.clock,
    artifactStore: deps.artifactStore,
    referenceReposRoot: deps.tickOptions?.referenceReposRoot,
  };
  const submitLinear = pickLinearAdapter(deps);
  if (submitLinear !== undefined) submitDeps.linear = submitLinear;
  return emitServiceResult(
    await submit_brief(submitDeps, {
      taskId: input.taskId,
      claimId: input.claimId,
      brief: input.brief,
      reason: input.reason as "blocker_resolved" | "advice_answered",
      goalTokenBudget: input.goalTokenBudget,
    }),
    io,
  );
}

function parseGoalTokenBudget(
  raw: string,
): { ok: true; value: number | null } | { ok: false; message: string } {
  if (raw === "none") return { ok: true, value: null };
  if (!/^[1-9]\d*$/.test(raw)) {
    return {
      ok: false,
      message: `--goal-token-budget must be a positive integer or none (got ${raw})`,
    };
  }
  return { ok: true, value: Number(raw) };
}

function parsePositiveIntArg(
  raw: string | null,
  command: string,
  noun = "outbox_item_id",
): { ok: true; value: number } | { ok: false; message: string } {
  if (raw === null) {
    return { ok: false, message: `${command} requires <${noun}>` };
  }
  if (!/^[1-9]\d*$/.test(raw)) {
    return {
      ok: false,
      message: `${command} requires a positive integer ${noun} (got ${raw})`,
    };
  }
  return { ok: true, value: Number(raw) };
}

async function handleEscalateHuman(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): Promise<DispatchResult> {
  if (wantsHelp(argv)) return printHelp(io, ["escalate-human"]);
  const json = tryParseJsonFlag(argv);
  if (!json.ok) return writeError(io, "usage_error", json.message);
  let input: {
    taskId: string;
    claimId: string;
    questionBody: string;
    threadRef?: string | null;
  };
  if (json.value !== undefined) {
    input = json.value as never;
  } else {
    const taskId = positional(argv);
    const claimId = readFlag(argv, "--claim-id");
    const questionFile = readFlag(argv, "--question-file");
    const threadRef = readFlag(argv, "--thread-ref");
    if (!taskId || !claimId || !questionFile) {
      return writeError(
        io,
        "usage_error",
        "escalate-human requires <task_id> --claim-id <id> --question-file <path> [--thread-ref <ref>]",
      );
    }
    const qRead = tryReadFile(questionFile);
    if (!qRead.ok) return writeError(io, "usage_error", qRead.message);
    input = {
      taskId,
      claimId,
      questionBody: qRead.value,
      threadRef: threadRef ?? null,
    };
  }
  const escalateDeps: EscalateHumanDeps = {
    db: deps.db,
    clock: deps.clock,
    ids: deps.ids,
    artifactStore: deps.artifactStore,
  };
  const escalateLinear = pickLinearAdapter(deps);
  if (escalateLinear !== undefined) escalateDeps.linear = escalateLinear;
  return emitServiceResult(await escalate_human(escalateDeps, input), io);
}

async function handleRecordHumanReply(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): Promise<DispatchResult> {
  if (wantsHelp(argv)) return printHelp(io, ["record-human-reply"]);
  const json = tryParseJsonFlag(argv);
  if (!json.ok) return writeError(io, "usage_error", json.message);
  let input: {
    taskId: string;
    claimId: string;
    replyBody: string;
    threadRef?: string | null;
    messageTs?: string | null;
    author?: string | null;
  };
  if (json.value !== undefined) {
    input = json.value as never;
  } else {
    const taskId = positional(argv);
    const claimId = readFlag(argv, "--claim-id");
    const replyFile = readFlag(argv, "--reply-file");
    const threadRef = readFlag(argv, "--thread-ref");
    const messageTs = readFlag(argv, "--message-ts");
    const author = readFlag(argv, "--author");
    if (!taskId || !claimId || !replyFile) {
      return writeError(
        io,
        "usage_error",
        "record-human-reply requires <task_id> --claim-id <id> --reply-file <path> [--thread-ref <ref>] [--message-ts <ts>] [--author <name>]",
      );
    }
    const replyRead = tryReadFile(replyFile);
    if (!replyRead.ok) return writeError(io, "usage_error", replyRead.message);
    input = {
      taskId,
      claimId,
      replyBody: replyRead.value,
      threadRef: threadRef ?? null,
      messageTs: messageTs ?? null,
      author: author ?? null,
    };
  }
  const recordDeps: RecordHumanReplyDeps = {
    db: deps.db,
    clock: deps.clock,
    artifactStore: deps.artifactStore,
  };
  const recordLinear = pickLinearAdapter(deps);
  if (recordLinear !== undefined) recordDeps.linear = recordLinear;
  return emitServiceResult(await record_human_reply(recordDeps, input), io);
}

interface ArtifactRow {
  artifact_id: number;
  task_id: string;
  attempt_id: number | null;
  kind: string;
  file_path: string;
  captured_at: string;
}

function handleArtifact(
  argv: string[],
  deps: CliDeps,
  io: CliIO,
): DispatchResult {
  if (argv.length === 0) {
    return writeErrorWithUsage(
      io,
      ["artifact"],
      "usage_error",
      "artifact subcommand required (get)",
    );
  }
  if (isHelpToken(argv[0] as string)) return printHelp(io, ["artifact"]);
  if (argv[0] !== "get") {
    return writeErrorWithUsage(
      io,
      ["artifact"],
      "usage_error",
      `unknown artifact subcommand: ${argv[0]}`,
    );
  }
  const rest = argv.slice(1);
  if (wantsHelp(rest)) return printHelp(io, ["artifact", "get"]);
  const taskId = positional(rest);
  const kind = positionalAt(rest, 1);
  if (!taskId || !kind) {
    return writeError(
      io,
      "usage_error",
      "artifact get requires <task_id> <kind>",
    );
  }
  const attemptArg = readFlag(rest, "--attempt");
  const attemptId = attemptArg !== null ? Number.parseInt(attemptArg, 10) : null;
  if (attemptArg !== null && Number.isNaN(attemptId)) {
    return writeError(io, "usage_error", `--attempt must be an integer (got ${attemptArg})`);
  }
  const wantPath = rest.includes("--path");

  // Latest matching artifact wins. Filter by attempt_id when provided.
  const row =
    attemptId === null
      ? deps.db
          .query<ArtifactRow, [string, string]>(
            `SELECT artifact_id, task_id, attempt_id, kind, file_path, captured_at
               FROM artifacts WHERE task_id = ? AND kind = ?
              ORDER BY artifact_id DESC LIMIT 1`,
          )
          .get(taskId, kind)
      : deps.db
          .query<ArtifactRow, [string, string, number]>(
            `SELECT artifact_id, task_id, attempt_id, kind, file_path, captured_at
               FROM artifacts WHERE task_id = ? AND kind = ? AND attempt_id = ?
              ORDER BY artifact_id DESC LIMIT 1`,
          )
          .get(taskId, kind, attemptId);
  if (!row) {
    return writeError(io, "unknown_artifact", `no ${kind} artifact for task ${taskId}`, {
      task_id: taskId,
      kind,
      attempt_id: attemptId,
    });
  }
  if (wantPath) {
    io.stdout(`${row.file_path}\n`);
    return { exitCode: 0 };
  }
  // Stream raw bytes — no UTF-8 round-trip. `malformed_signal` artifacts
  // intentionally preserve invalid UTF-8 sequences (that's literally what
  // the kind documents), so decoding here would corrupt the payload before
  // it reaches the operator. CliIO.stdout accepts Uint8Array for exactly
  // this path; the production sink is `process.stdout.write`, which also
  // accepts bytes natively.
  io.stdout(readFileSync(row.file_path));
  return { exitCode: 0 };
}

function emitServiceResult<T>(
  result: ServiceResult<T> | { ok: boolean; value?: T; error?: { code: string; message: string; details?: Record<string, unknown> } },
  io: CliIO,
): DispatchResult {
  if (result.ok) {
    io.stdout(`${JSON.stringify(result.value)}\n`);
    return { exitCode: 0 };
  }
  const err = (result as { error: { code: string; message: string; details?: Record<string, unknown> } }).error;
  io.stderr(`${JSON.stringify(serviceErrorToCli(err))}\n`);
  return { exitCode: 1 };
}

function pickTickDeps(deps: CliDeps): TickDeps {
  const tickDeps: TickDeps = {
    db: deps.db,
    clock: deps.clock,
    git: deps.git,
    commandRunner: deps.commandRunner,
    github: deps.github,
    tmux: deps.tmux,
    slack: deps.slack,
    artifactStore: deps.artifactStore,
    supervisorLock: deps.supervisorLock,
  };
  const linear = pickLinearAdapter(deps);
  if (linear !== undefined) tickDeps.linear = linear;
  return tickDeps;
}

// Forward the Linear adapter only when the deployment opted in via
// `[adapters.linear].enabled = true`. Production wiring constructs the
// adapter unconditionally (token resolution is lazy, so an unused adapter
// is free), so the dispatcher gates here to keep `linearEnabled = false`
// deployments from mutating Linear state via the writeback paths.
export function pickLinearAdapter(deps: CliDeps): LinearPort | undefined {
  if (deps.linear === undefined) return undefined;
  if (deps.adaptersConfig?.linearEnabled !== true) return undefined;
  return deps.linear;
}

// --- argv helpers --------------------------------------------------------

type ParseResult =
  | { ok: true; value: unknown | undefined }
  | { ok: false; message: string };

// Returns { ok: true, value: undefined } when --input is not present, so the
// caller falls through to flag-based parsing without an error.
function tryParseJsonFlag(argv: string[]): ParseResult {
  const raw = readFlag(argv, "--input");
  if (raw === null) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return {
      ok: false,
      message: `invalid JSON for --input: ${(err as Error).message}`,
    };
  }
}

// Validates argv flag tokens against an allowlist before any handler-level
// reads. Closes three silent-ignore footguns at once:
//
//   1. Typo on a flag NAME (`--actv`, `--Active`) — caught as "unknown flag"
//      instead of falling back to the absent-flag default.
//   2. `--<bool>=value` form (`--active=true`) — caught instead of being
//      ignored by the bare-`argv.includes("--active")` boolean detector.
//   3. Missing value on a `--<valued>` flag (`--out` at end of argv, or
//      `--out --active`) — caught instead of letting `readFlag` swallow the
//      next `--` token (or undefined) as the path.
//
// Long-flag tokens only — short flags and positionals are ignored.
interface FlagSpec {
  boolean?: ReadonlyArray<string>;
  valued?: ReadonlyArray<string>;
}
type FlagValidation =
  | { ok: true }
  | { ok: false; message: string; details: { flag: string } };
function validateFlags(argv: string[], spec: FlagSpec): FlagValidation {
  const known = new Set<string>([
    ...(spec.boolean ?? []),
    ...(spec.valued ?? []),
  ]);
  const booleans = new Set<string>(spec.boolean ?? []);
  const valueds = new Set<string>(spec.valued ?? []);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined || !a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    const head = eq === -1 ? a : a.slice(0, eq);
    if (!known.has(head)) {
      return {
        ok: false,
        message: `unknown flag: ${a}`,
        details: { flag: a },
      };
    }
    if (booleans.has(head)) {
      if (eq !== -1) {
        return {
          ok: false,
          message: `${head} is a boolean flag and does not take a value (got ${a})`,
          details: { flag: a },
        };
      }
      continue;
    }
    if (valueds.has(head) && eq === -1) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return {
          ok: false,
          message: `${head} requires a value`,
          details: { flag: head },
        };
      }
    }
  }
  return { ok: true };
}

// Reads `--flag <value>` or `--flag=<value>`. Returns null when absent.
function readFlag(argv: string[], flag: string): string | null {
  const eq = `${flag}=`;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === flag) return argv[i + 1] ?? null;
    if (a.startsWith(eq)) return a.slice(eq.length);
  }
  return null;
}

// Repeatable flag — collects every `--flag <v>` / `--flag=<v>` occurrence.
function collectFlagValues(argv: string[], flag: string): string[] {
  const out: string[] = [];
  const eq = `${flag}=`;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === flag) {
      const v = argv[i + 1];
      if (v !== undefined) out.push(v);
    } else if (a.startsWith(eq)) {
      out.push(a.slice(eq.length));
    }
  }
  return out;
}

// First non-flag token.
function positional(argv: string[]): string | null {
  return positionalAt(argv, 0);
}

// Nth non-flag token (skipping every `--flag <value>` pair).
function positionalAt(argv: string[], n: number): string | null {
  let count = 0;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith("--")) {
      // Flags with `=` are self-contained; flags without an `=` consume the
      // next token unless that next token is itself a `--flag`.
      if (!a.includes("=")) {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) i += 1;
      }
      continue;
    }
    if (count === n) return a;
    count += 1;
  }
  return null;
}

function flagsToObject(
  argv: string[],
  spec: ReadonlyArray<{ flag: string; key: string }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { flag, key } of spec) {
    const v = readFlag(argv, flag);
    if (v !== null) out[key] = v;
  }
  return out;
}

function parsePrIdentifier(
  raw: string,
): { repo: string; prNumber: number } | null {
  const idx = raw.lastIndexOf(":");
  if (idx <= 0 || idx === raw.length - 1) return null;
  const repo = raw.slice(0, idx);
  const n = Number.parseInt(raw.slice(idx + 1), 10);
  if (!Number.isInteger(n) || n <= 0) return null;
  return { repo, prNumber: n };
}

interface UnadoptTargetRow {
  task_id: string;
  repo_id: string;
  authoring_mode: string;
  state: string;
  branch_name: string;
  pr_number: number | null;
}

type UnadoptTargetResolution =
  | { ok: true; value: UnadoptTargetRow }
  | {
      ok: false;
      exitCode: number;
      error: string;
      message: string;
      details?: Record<string, unknown>;
    };

function resolveUnadoptTargetByTask(
  db: DB,
  taskId: string,
): UnadoptTargetResolution {
  const row = db
    .query<UnadoptTargetRow, [string]>(
      `SELECT task_id, repo_id, authoring_mode, state, branch_name, pr_number
         FROM tasks
        WHERE task_id = ?`,
    )
    .get(taskId) ?? null;
  if (row === null) {
    return {
      ok: false,
      exitCode: 3,
      error: "unknown_task",
      message: `task ${taskId} not found`,
      details: { task_id: taskId },
    };
  }
  return { ok: true, value: row };
}

function resolveUnadoptTargetByPr(
  db: DB,
  prArg: string,
): UnadoptTargetResolution {
  const parsedPr = parsePrIdentifier(prArg);
  if (parsedPr === null) {
    return {
      ok: false,
      exitCode: 2,
      error: "usage_error",
      message: `--pr must be <repo>:<num> (got ${prArg})`,
      details: { pr: prArg },
    };
  }
  const repoId = resolveRepoIdForPr(db, parsedPr.repo);
  if (repoId === null) {
    return {
      ok: false,
      exitCode: 2,
      error: "repo_not_configured",
      message: `repo "${parsedPr.repo}" is not configured`,
      details: { repo: parsedPr.repo },
    };
  }
  const row = db
    .query<UnadoptTargetRow, [string, number]>(
      `SELECT task_id, repo_id, authoring_mode, state, branch_name, pr_number
         FROM tasks
        WHERE repo_id = ?
          AND pr_number = ?
        ORDER BY
          CASE WHEN authoring_mode = 'adopted_external_pr' THEN 0 ELSE 1 END,
          created_at DESC,
          task_id DESC
        LIMIT 1`,
    )
    .get(repoId, parsedPr.prNumber) ?? null;
  if (row === null) {
    return {
      ok: false,
      exitCode: 3,
      error: "unknown_pr_task",
      message: `no Quay task found for PR ${repoId}:${parsedPr.prNumber}`,
      details: { repo_id: repoId, pr_number: parsedPr.prNumber },
    };
  }
  return { ok: true, value: row };
}

function resolveRepoIdForPr(db: DB, repoArg: string): string | null {
  const rows = db
    .query<{ repo_id: string; repo_url: string }, []>(
      `SELECT repo_id, repo_url FROM repos WHERE archived_at IS NULL ORDER BY repo_id`,
    )
    .all();
  for (const row of rows) {
    if (row.repo_id === repoArg) return row.repo_id;
    const slug = repoSlugFromUrl(row.repo_url);
    if (slug === repoArg) return row.repo_id;
  }
  return null;
}

function repoSlugFromUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, "").replace(/\.git$/, "");
  try {
    const parsed = new URL(trimmed);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts.slice(-2).join("/");
  } catch {}
  const scpLike = trimmed.match(/^[^:]+:(.+)$/);
  const path = scpLike?.[1] ?? trimmed;
  const parts = path.split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

function tryReadFile(path: string): { ok: true; value: string } | { ok: false; message: string } {
  try {
    return { ok: true, value: readFileSync(path, "utf8") };
  } catch (err) {
    return {
      ok: false,
      message: `failed to read ${path}: ${(err as Error).message}`,
    };
  }
}
