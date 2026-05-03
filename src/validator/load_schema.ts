// Schema loader per ticket-validation spec §6 + §10 (regex-compile-once rule).
//
// Reads a TOML file, walks the [required.<f>] / [optional.<f>] tables, and
// produces an in-memory `TicketSchema` with patterns pre-compiled. Field
// types and option keys are validated up-front so every schema-error is a
// loader error (exit 2 in the CLI), not a validateTicket() error.

import { readFileSync } from "node:fs";
import { isCharset } from "./charsets.ts";
import type {
  CharsetName,
  EnumFieldSchema,
  FieldSchema,
  ListFieldSchema,
  ObjectFieldSchema,
  StringFieldSchema,
  TicketSchema,
} from "./types.ts";

export class SchemaLoadError extends Error {
  constructor(
    message: string,
    public readonly schemaPath: string,
  ) {
    super(message);
    this.name = "SchemaLoadError";
  }
}

export function loadSchema(path: string): TicketSchema {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SchemaLoadError(
      `failed to read ticket schema at ${path}: ${message}`,
      path,
    );
  }
  return parseSchema(raw, path);
}

export function parseSchema(toml: string, path: string): TicketSchema {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(toml);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SchemaLoadError(
      `ticket schema at ${path} is not valid TOML: ${message}`,
      path,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new SchemaLoadError(
      `ticket schema at ${path} must be a TOML table at the root`,
      path,
    );
  }
  const required = compileGroup(parsed.required, "required", path);
  const optional = compileGroup(parsed.optional, "optional", path);
  return { required, optional };
}

function compileGroup(
  raw: unknown,
  group: string,
  schemaPath: string,
): Record<string, FieldSchema> {
  if (raw === undefined) return {};
  if (!isPlainObject(raw)) {
    throw new SchemaLoadError(
      `[${group}] must be a table in ${schemaPath}`,
      schemaPath,
    );
  }
  const out: Record<string, FieldSchema> = {};
  for (const [name, value] of Object.entries(raw)) {
    out[name] = compileField(value, `${group}.${name}`, schemaPath);
  }
  return out;
}

function compileField(
  raw: unknown,
  loc: string,
  schemaPath: string,
): FieldSchema {
  if (!isPlainObject(raw)) {
    throw new SchemaLoadError(
      `${loc} must be a table in ${schemaPath}`,
      schemaPath,
    );
  }
  const typeRaw = raw.type;
  if (typeof typeRaw !== "string") {
    throw new SchemaLoadError(
      `${loc}.type must be a string in ${schemaPath}`,
      schemaPath,
    );
  }
  switch (typeRaw) {
    case "string":
      return compileString(raw, loc, schemaPath);
    case "list":
      return compileList(raw, loc, schemaPath);
    case "object":
      return compileObject(raw, loc, schemaPath);
    case "enum":
      return compileEnum(raw, loc, schemaPath);
    default:
      throw new SchemaLoadError(
        `${loc}.type "${typeRaw}" is not a known field type (string, list, object, enum) in ${schemaPath}`,
        schemaPath,
      );
  }
}

function compileString(
  raw: Record<string, unknown>,
  loc: string,
  schemaPath: string,
): StringFieldSchema {
  const out: StringFieldSchema = { type: "string" };
  const minLen = readNumber(raw.min_length, `${loc}.min_length`, schemaPath);
  if (minLen !== undefined) out.min_length = minLen;
  const maxLen = readNumber(raw.max_length, `${loc}.max_length`, schemaPath);
  if (maxLen !== undefined) out.max_length = maxLen;
  const charset = readCharset(raw.charset, `${loc}.charset`, schemaPath);
  if (charset !== undefined) out.charset = charset;
  const pattern = readPattern(raw.pattern, `${loc}.pattern`, schemaPath);
  if (pattern !== undefined) out.pattern = pattern;
  const description = readString(raw.description, `${loc}.description`, schemaPath);
  if (description !== undefined) out.description = description;
  return out;
}

function compileList(
  raw: Record<string, unknown>,
  loc: string,
  schemaPath: string,
): ListFieldSchema {
  const itemTypeRaw = raw.item_type;
  if (itemTypeRaw !== "string" && itemTypeRaw !== "object") {
    throw new SchemaLoadError(
      `${loc}.item_type must be "string" or "object" in ${schemaPath}`,
      schemaPath,
    );
  }
  const out: ListFieldSchema = { type: "list", item_type: itemTypeRaw };
  const minCount = readNumber(raw.min_count, `${loc}.min_count`, schemaPath);
  if (minCount !== undefined) out.min_count = minCount;
  const maxCount = readNumber(raw.max_count, `${loc}.max_count`, schemaPath);
  if (maxCount !== undefined) out.max_count = maxCount;
  if (raw.unique !== undefined) {
    if (typeof raw.unique !== "boolean") {
      throw new SchemaLoadError(
        `${loc}.unique must be a boolean in ${schemaPath}`,
        schemaPath,
      );
    }
    out.unique = raw.unique;
  }
  const charset = readCharset(raw.charset, `${loc}.charset`, schemaPath);
  if (charset !== undefined) out.charset = charset;
  const pattern = readPattern(raw.pattern, `${loc}.pattern`, schemaPath);
  if (pattern !== undefined) out.pattern = pattern;
  const description = readString(raw.description, `${loc}.description`, schemaPath);
  if (description !== undefined) out.description = description;
  if (raw.fields !== undefined) {
    if (!isPlainObject(raw.fields)) {
      throw new SchemaLoadError(
        `${loc}.fields must be a table in ${schemaPath}`,
        schemaPath,
      );
    }
    const fields: Record<string, FieldSchema> = {};
    for (const [k, v] of Object.entries(raw.fields)) {
      fields[k] = compileField(v, `${loc}.fields.${k}`, schemaPath);
    }
    out.fields = fields;
  }
  return out;
}

function compileObject(
  raw: Record<string, unknown>,
  loc: string,
  schemaPath: string,
): ObjectFieldSchema {
  const fieldsRaw = raw.fields;
  if (fieldsRaw === undefined || !isPlainObject(fieldsRaw)) {
    throw new SchemaLoadError(
      `${loc}.fields must be a table in ${schemaPath}`,
      schemaPath,
    );
  }
  const fields: Record<string, FieldSchema> = {};
  for (const [k, v] of Object.entries(fieldsRaw)) {
    fields[k] = compileField(v, `${loc}.fields.${k}`, schemaPath);
  }
  const out: ObjectFieldSchema = { type: "object", fields };
  const description = readString(raw.description, `${loc}.description`, schemaPath);
  if (description !== undefined) out.description = description;
  return out;
}

function compileEnum(
  raw: Record<string, unknown>,
  loc: string,
  schemaPath: string,
): EnumFieldSchema {
  const allowedRaw = raw.allowed;
  if (!Array.isArray(allowedRaw) || allowedRaw.length === 0) {
    throw new SchemaLoadError(
      `${loc}.allowed must be a non-empty array of strings in ${schemaPath}`,
      schemaPath,
    );
  }
  const allowed: string[] = [];
  for (const v of allowedRaw) {
    if (typeof v !== "string") {
      throw new SchemaLoadError(
        `${loc}.allowed entries must be strings in ${schemaPath}`,
        schemaPath,
      );
    }
    allowed.push(v);
  }
  const out: EnumFieldSchema = { type: "enum", allowed };
  if (raw.case_sensitive !== undefined) {
    if (typeof raw.case_sensitive !== "boolean") {
      throw new SchemaLoadError(
        `${loc}.case_sensitive must be a boolean in ${schemaPath}`,
        schemaPath,
      );
    }
    out.case_sensitive = raw.case_sensitive;
  }
  const description = readString(raw.description, `${loc}.description`, schemaPath);
  if (description !== undefined) out.description = description;
  return out;
}

function readNumber(
  v: unknown,
  loc: string,
  schemaPath: string,
): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new SchemaLoadError(
      `${loc} must be a number in ${schemaPath}`,
      schemaPath,
    );
  }
  return v;
}

function readString(
  v: unknown,
  loc: string,
  schemaPath: string,
): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") {
    throw new SchemaLoadError(
      `${loc} must be a string in ${schemaPath}`,
      schemaPath,
    );
  }
  return v;
}

function readCharset(
  v: unknown,
  loc: string,
  schemaPath: string,
): CharsetName | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !isCharset(v)) {
    throw new SchemaLoadError(
      `${loc} must be one of "any" | "lowercase_alphanum_dash" | "ascii_printable" in ${schemaPath}`,
      schemaPath,
    );
  }
  return v;
}

// Compile-once: each `pattern` regex gets built here so per-validation calls
// in `validateTicket()` are pure CPU lookups.
function readPattern(
  v: unknown,
  loc: string,
  schemaPath: string,
): RegExp | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") {
    throw new SchemaLoadError(
      `${loc} must be a string regex in ${schemaPath}`,
      schemaPath,
    );
  }
  try {
    return new RegExp(v);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new SchemaLoadError(
      `${loc} is not a valid regex (${message}) in ${schemaPath}`,
      schemaPath,
    );
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
