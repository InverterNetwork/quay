#!/usr/bin/env bun
// Quay CLI entry. Handles stateless short-circuits and startup environment
// guards, then creates the shared runtime used by CLI dispatch and HTTP serve.
//
// Tests do NOT import this file: they call dispatch() directly with fakes.
// Keep this entry thin.

import { readFileSync } from "node:fs";
import {
  EMBEDDED_MIGRATIONS,
  EMBEDDED_TICKET_SCHEMA,
  QUAY_VERSION,
} from "../build/embedded.generated.ts";
import {
  createQuayRuntime,
  QuayRuntimeStartupError,
} from "../runtime/quay_runtime.ts";
import { dispatch } from "./dispatch.ts";
import { commandHelp, wantsHelp } from "./help.ts";
import { createLazyRepoVocabLookup } from "./repo_vocab_lookup.ts";
import { runServeCommand } from "./serve.ts";
import { detectStartupEnvHazard } from "./startup_env.ts";
import { handleValidateTicket } from "./validate_ticket.ts";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  // `quay --version` and `-v` MUST short-circuit before any DB / config /
  // migration work: the version stamp is meaningful even on a host where
  // ~/.quay/config.toml is malformed, the data dir is unwritable, or the
  // box has never been initialised.
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(`${QUAY_VERSION}\n`);
    return 0;
  }
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
      {
        embeddedSchema: EMBEDDED_TICKET_SCHEMA,
        lookupRepoVocab: createLazyRepoVocabLookup(
          process.env,
          () => EMBEDDED_MIGRATIONS,
        ),
      },
    );
    return result.exitCode;
  }
  if (argv[0] === "serve" && wantsHelp(argv.slice(1))) {
    process.stdout.write(commandHelp(["serve"]) ?? "");
    return 0;
  }
  // An inherited cwd the process can't read (e.g. `sudo -u <unprivileged>`
  // from a root shell at `/root`) has historically degraded config + DB
  // init into a silent `~/.quay/` fallback. Pin cwd to `/` for init, then
  // restore before `dispatch` so user-supplied relative paths (`--brief
  // ./brief.md`, `--in repos.json`) still resolve under the invocation
  // cwd. Adapter spawn sites all pass an explicit `cwd`, so the process-
  // wide chdir doesn't bleed into subprocesses.
  let invocationCwd: string | undefined;
  try {
    invocationCwd = process.cwd();
  } catch {}
  try {
    process.chdir("/");
  } catch (err) {
    // Surfacing rather than swallowing: a silent failure here would
    // re-enter the hostile-cwd state this branch exists to neutralise.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `${JSON.stringify({ error: "internal_error", message: `chdir to / failed: ${message}` })}\n`,
    );
  }
  const startupEnvHazard = detectStartupEnvHazard({
    env: process.env,
    invocationCwd,
  });
  if (startupEnvHazard !== null) {
    process.stderr.write(
      `${JSON.stringify({ error: "startup_error", message: startupEnvHazard })}\n`,
    );
    return 2;
  }
  const runtime = (() => {
    try {
      return createQuayRuntime({
        migrations: EMBEDDED_MIGRATIONS,
        version: QUAY_VERSION,
      });
    } catch (err) {
      if (err instanceof QuayRuntimeStartupError) {
        process.stderr.write(`${JSON.stringify(err.toPayload())}\n`);
        return { startupExitCode: err.exitCode } as const;
      }
      throw err;
    }
  })();
  if ("startupExitCode" in runtime) return runtime.startupExitCode;

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
  if (invocationCwd !== undefined && invocationCwd !== "/") {
    try {
      process.chdir(invocationCwd);
    } catch {}
  }
  try {
    if (argv[0] === "serve") {
      return await runServeCommand(argv.slice(1), runtime, io);
    }
    const result = await dispatch(argv, runtime.cliDeps, io);
    return result.exitCode;
  } finally {
    runtime.close();
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  process.stderr.write(
    `${JSON.stringify({ error: "internal_error", message: err?.message ?? String(err) })}\n`,
  );
  process.exit(1);
});
