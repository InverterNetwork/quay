// Validator runner — adapters spec §11. The validator stays a standalone
// CLI (`quay validate-ticket`) per the validator spec; `enqueue --linear-issue`
// invokes it as a child process via `Bun.spawnSync`. This module provides the
// port (so tests can swap a fake) and the production spawning implementation.
//
// Why child process and not a library call:
//   - Preserves the validator's standalone usability for the cron-pickup path
//     (`docs/quay-spec-ticket-validation.md` §8.2).
//   - One implementation, two callers (human at the CLI; quay enqueue
//     internally). Library promotion is deferred per spec §17.

import { fileURLToPath } from "node:url";
import type { ValidationError } from "../validator/types.ts";

export interface ValidatorRunResult {
  valid: boolean;
  errors: ValidationError[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ValidatorRunner {
  run(payload: unknown): ValidatorRunResult;
}

const DEFAULT_VALIDATOR_BIN = fileURLToPath(
  new URL("../cli/validate_ticket_bin.ts", import.meta.url),
);

// True when running inside a `bun build --compile` binary. In that context,
// `Bun.embeddedFiles` is populated and `DEFAULT_VALIDATOR_BIN` resolves to a
// virtual /$bunfs/... path that no spawned process can read. We must instead
// recurse through the running binary itself.
function isCompiledBinary(): boolean {
  return (
    typeof Bun !== "undefined" &&
    Array.isArray(Bun.embeddedFiles) &&
    Bun.embeddedFiles.length > 0
  );
}

export interface SpawnedValidatorRunnerOptions {
  binPath?: string;
  bunPath?: string;
  schemaFile?: string;
  env?: Record<string, string | undefined>;
}

export class SpawnedValidatorRunner implements ValidatorRunner {
  constructor(private readonly opts: SpawnedValidatorRunnerOptions = {}) {}

  run(payload: unknown): ValidatorRunResult {
    let args: string[];
    if (this.opts.binPath !== undefined || this.opts.bunPath !== undefined) {
      // Explicit overrides (used by tests) always win.
      const binPath = this.opts.binPath ?? DEFAULT_VALIDATOR_BIN;
      const bunPath = this.opts.bunPath ?? "bun";
      args = [bunPath, "run", binPath, "--ticket-json", "-"];
    } else if (isCompiledBinary()) {
      // Inside a compiled binary, recurse through the running executable.
      // cli/index.ts short-circuits `validate-ticket` in-process with the
      // embedded schema, so no `bun` on PATH is required.
      args = [process.execPath, "validate-ticket", "--ticket-json", "-"];
    } else {
      args = ["bun", "run", DEFAULT_VALIDATOR_BIN, "--ticket-json", "-"];
    }
    if (this.opts.schemaFile !== undefined) {
      args.push("--schema-file", this.opts.schemaFile);
    }

    const stdinBytes = new TextEncoder().encode(JSON.stringify(payload));
    const proc = Bun.spawnSync({
      cmd: args,
      stdin: stdinBytes,
      stdout: "pipe",
      stderr: "pipe",
      env: mergeEnv(process.env, this.opts.env),
    });

    const stdout = new TextDecoder().decode(proc.stdout);
    const stderr = new TextDecoder().decode(proc.stderr);
    const exitCode = proc.exitCode ?? -1;

    if (exitCode === 0) {
      return { valid: true, errors: [], exitCode, stdout, stderr };
    }
    if (exitCode === 1) {
      const trimmed = stdout.trim();
      if (trimmed.length === 0) {
        return { valid: false, errors: [], exitCode, stdout, stderr };
      }
      try {
        const parsed = JSON.parse(trimmed) as {
          valid?: boolean;
          errors?: ValidationError[];
        };
        return {
          valid: parsed.valid === true,
          errors: parsed.errors ?? [],
          exitCode,
          stdout,
          stderr,
        };
      } catch {
        return { valid: false, errors: [], exitCode, stdout, stderr };
      }
    }
    // Exit codes 2 (schema_error) and 3 (input_error) are configuration /
    // payload-shape failures, not ticket validity failures. They mean the
    // calling code is broken — surface as a thrown error so the operator
    // sees a real diagnostic instead of a silent "ticket invalid".
    throw new Error(
      `validate-ticket child process exited with code ${exitCode}: ${
        stderr.trim() || stdout.trim() || "<no output>"
      }`,
    );
  }
}

function mergeEnv(
  base: NodeJS.ProcessEnv,
  override: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined) out[k] = v;
  }
  if (override !== undefined) {
    for (const [k, v] of Object.entries(override)) {
      if (v === undefined) {
        delete out[k];
      } else {
        out[k] = v;
      }
    }
  }
  return out;
}
