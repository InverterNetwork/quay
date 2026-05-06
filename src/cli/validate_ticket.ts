// CLI handler for `quay validate-ticket` per ticket-validation spec §4.
//
// Resolves a schema path (override > env-rooted default > shipped default),
// reads ticket JSON from stdin or a file, runs the pure validator, and
// emits the §4 stdout/stderr shape with stable exit codes:
//
//   0  valid input
//   1  invalid input (one or more validation errors)
//   2  schema configuration error (file missing, malformed TOML, schema invalid)
//   3  input error (input file missing, malformed JSON, JSON not an object)

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadSchema,
  parseSchema,
  SchemaLoadError,
} from "../validator/load_schema.ts";
import type { TicketDraft, TicketSchema } from "../validator/types.ts";
import { validateTicket } from "../validator/validate.ts";
import type { CliIO } from "./io.ts";

export interface ValidateTicketEnv {
  QUAY_CONFIG_DIR?: string;
  HOME?: string;
}

export interface ValidateTicketResult {
  exitCode: number;
}

export interface ValidateTicketDeps {
  // The shipped-default schema as a TOML string. The compiled binary has
  // no `config/ticket_schema.toml` on disk, so we fall back to this when
  // the on-disk lookups (override > QUAY_CONFIG_DIR > $HOME/.quay >
  // SHIPPED_DEFAULT_SCHEMA) all miss. In dev / tests SHIPPED_DEFAULT_SCHEMA
  // resolves to a real file, so this path is only exercised under --compile.
  embeddedSchema?: string;
}

const EMBEDDED_SCHEMA_PATH = "<embedded:ticket_schema.toml>";

const SHIPPED_DEFAULT_SCHEMA = fileURLToPath(
  new URL("../../config/ticket_schema.toml", import.meta.url),
);

export function handleValidateTicket(
  argv: string[],
  io: CliIO,
  env: NodeJS.ProcessEnv | ValidateTicketEnv = process.env,
  deps: ValidateTicketDeps = {},
): ValidateTicketResult {
  const flags = parseFlags(argv);
  if (!flags.ok) {
    return writeStderr(io, "usage_error", flags.message, 2);
  }
  const opts = flags.value;

  const schemaPath = resolveSchemaPath(opts.schemaFile, env);
  let schema: TicketSchema;
  if (schemaPath === null) {
    if (deps.embeddedSchema === undefined || deps.embeddedSchema === "") {
      return writeStderr(
        io,
        "schema_error",
        "no ticket schema found: --schema-file not provided, no file at ${QUAY_CONFIG_DIR}/ticket_schema.toml, and no shipped default available",
        2,
      );
    }
    try {
      schema = parseSchema(deps.embeddedSchema, EMBEDDED_SCHEMA_PATH);
    } catch (err) {
      if (err instanceof SchemaLoadError) {
        return writeStderr(io, "schema_error", err.message, 2, {
          schema_file: err.schemaPath,
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      return writeStderr(io, "schema_error", message, 2);
    }
  } else {
    if (!existsSync(schemaPath)) {
      return writeStderr(
        io,
        "schema_error",
        `ticket schema file not found: ${schemaPath}`,
        2,
        { schema_file: schemaPath },
      );
    }
    try {
      schema = loadSchema(schemaPath);
    } catch (err) {
      if (err instanceof SchemaLoadError) {
        return writeStderr(io, "schema_error", err.message, 2, {
          schema_file: err.schemaPath,
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      return writeStderr(io, "schema_error", message, 2);
    }
  }

  const inputRead = readInput(opts.ticketJson, io);
  if (!inputRead.ok) {
    return writeStderr(io, "input_error", inputRead.message, 3);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(inputRead.value);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return writeStderr(
      io,
      "input_error",
      `ticket input is not valid JSON: ${message}`,
      3,
    );
  }
  if (!isPlainObject(parsed)) {
    return writeStderr(
      io,
      "input_error",
      "ticket input must be a JSON object (got array, primitive, or null)",
      3,
    );
  }

  const result = validateTicket(parsed as TicketDraft, schema);
  if (!opts.quiet) {
    if (result.valid) {
      io.stdout(`${JSON.stringify({ valid: true })}\n`);
    } else {
      io.stdout(`${JSON.stringify(result)}\n`);
    }
  }
  return { exitCode: result.valid ? 0 : 1 };
}

interface ParsedFlags {
  ticketJson: string | null;
  schemaFile: string | null;
  quiet: boolean;
}

function parseFlags(
  argv: string[],
):
  | { ok: true; value: ParsedFlags }
  | { ok: false; message: string } {
  let ticketJson: string | null = null;
  let schemaFile: string | null = null;
  let quiet = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--quiet") {
      quiet = true;
      continue;
    }
    if (a === "--ticket-json" || a.startsWith("--ticket-json=")) {
      const v = readFlagValue(a, argv, i, "--ticket-json");
      if (v === null) return { ok: false, message: "--ticket-json requires a value (path or '-')" };
      ticketJson = v.value;
      i += v.consumed;
      continue;
    }
    if (a === "--schema-file" || a.startsWith("--schema-file=")) {
      const v = readFlagValue(a, argv, i, "--schema-file");
      if (v === null) return { ok: false, message: "--schema-file requires a path" };
      schemaFile = v.value;
      i += v.consumed;
      continue;
    }
    return { ok: false, message: `unknown validate-ticket flag: ${a}` };
  }
  return { ok: true, value: { ticketJson, schemaFile, quiet } };
}

function readFlagValue(
  current: string,
  argv: string[],
  i: number,
  flag: string,
): { value: string; consumed: number } | null {
  const eq = `${flag}=`;
  if (current.startsWith(eq)) {
    return { value: current.slice(eq.length), consumed: 0 };
  }
  const next = argv[i + 1];
  if (next === undefined) return null;
  return { value: next, consumed: 1 };
}

function resolveSchemaPath(
  override: string | null,
  env: NodeJS.ProcessEnv | ValidateTicketEnv,
): string | null {
  if (override !== null) return override;
  const configDir = pickEnv(env, "QUAY_CONFIG_DIR");
  if (configDir !== undefined && configDir !== "") {
    const candidate = join(configDir, "ticket_schema.toml");
    if (existsSync(candidate)) return candidate;
  } else {
    const home = pickEnv(env, "HOME") ?? homedir();
    const candidate = join(home, ".quay", "ticket_schema.toml");
    if (existsSync(candidate)) return candidate;
  }
  if (existsSync(SHIPPED_DEFAULT_SCHEMA)) return SHIPPED_DEFAULT_SCHEMA;
  return null;
}

function pickEnv(
  env: NodeJS.ProcessEnv | ValidateTicketEnv,
  key: "QUAY_CONFIG_DIR" | "HOME",
): string | undefined {
  const v = (env as Record<string, string | undefined>)[key];
  return v;
}

function readInput(
  ticketJson: string | null,
  io: CliIO,
):
  | { ok: true; value: string }
  | { ok: false; message: string } {
  // No flag, or `--ticket-json -`, or `--ticket-json` absent: read stdin.
  const fromStdin = ticketJson === null || ticketJson === "-";
  if (fromStdin) {
    if (!io.stdin) {
      return { ok: false, message: "no stdin source configured" };
    }
    return { ok: true, value: io.stdin() };
  }
  try {
    return { ok: true, value: readFileSync(ticketJson, "utf8") };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `failed to read ticket input from ${ticketJson}: ${message}`,
    };
  }
}

function writeStderr(
  io: CliIO,
  code: string,
  message: string,
  exitCode: number,
  details: Record<string, unknown> = {},
): ValidateTicketResult {
  io.stderr(`${JSON.stringify({ error: code, message, ...details })}\n`);
  return { exitCode };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
