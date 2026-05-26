// Pure validator per ticket-validation spec §7.
//
// Evaluation order (per declared field):
//   1. Presence — required absent → MISSING; optional absent → skip.
//   2. Type     — JSON-type vs declared schema type → TYPE; stop on mismatch.
//   3. Type-specific — length / count / pattern / charset / enum / unique.
//   4. Recursive — nested objects and lists of objects.
//
// Errors are collected, never fail-fast, so the LLM rewrite loop sees every
// problem at once. Unknown input fields are silently ignored (§7).
//
// Pure: no clock, no random, no I/O. Same `(payload, schema)` → same output.

import { charsetAccepts } from "./charsets.ts";
import type {
  EnumFieldSchema,
  FieldSchema,
  ListFieldSchema,
  ObjectFieldSchema,
  StringFieldSchema,
  TicketDraft,
  TicketSchema,
  ValidationError,
  ValidationResult,
} from "./types.ts";

export function validateTicket(
  payload: TicketDraft,
  schema: TicketSchema,
): ValidationResult {
  const errors: ValidationError[] = [];

  for (const [name, fieldSchema] of Object.entries(schema.required)) {
    if (!hasOwn(payload, name)) {
      errors.push({
        field: name,
        code: "MISSING",
        message: `${name} is required but was not provided`,
      });
      continue;
    }
    validateField(name, payload[name], fieldSchema, errors);
  }

  for (const [name, fieldSchema] of Object.entries(schema.optional)) {
    if (!hasOwn(payload, name)) continue;
    validateField(name, payload[name], fieldSchema, errors);
  }

  return { valid: errors.length === 0, errors };
}

function validateField(
  path: string,
  value: unknown,
  schema: FieldSchema,
  errors: ValidationError[],
): void {
  switch (schema.type) {
    case "string":
      validateString(path, value, schema, errors);
      return;
    case "list":
      validateList(path, value, schema, errors);
      return;
    case "object":
      validateObject(path, value, schema, errors);
      return;
    case "enum":
      validateEnum(path, value, schema, errors);
      return;
  }
}

function validateString(
  path: string,
  value: unknown,
  schema: StringFieldSchema,
  errors: ValidationError[],
): void {
  if (typeof value !== "string") {
    errors.push({
      field: path,
      code: "TYPE",
      message: `${path} must be a string (got ${describeJsonType(value)})`,
    });
    return;
  }
  applyStringConstraints(path, value, schema, errors);
}

function applyStringConstraints(
  path: string,
  value: string,
  schema: Pick<
    StringFieldSchema,
    "min_length" | "max_length" | "pattern" | "charset"
  >,
  errors: ValidationError[],
): void {
  if (schema.min_length !== undefined && value.length < schema.min_length) {
    errors.push({
      field: path,
      code: "MIN_LENGTH",
      message: `${path} must be at least ${schema.min_length} characters, got ${value.length}`,
    });
  }
  if (schema.max_length !== undefined && value.length > schema.max_length) {
    errors.push({
      field: path,
      code: "MAX_LENGTH",
      message: `${path} must be at most ${schema.max_length} characters, got ${value.length}`,
    });
  }
  if (schema.pattern !== undefined && !schema.pattern.test(value)) {
    errors.push({
      field: path,
      code: "PATTERN",
      message: `${path} does not match the configured pattern`,
    });
  }
  if (
    schema.charset !== undefined &&
    schema.charset !== "any" &&
    !charsetAccepts(schema.charset, value)
  ) {
    errors.push({
      field: path,
      code: "CHARSET",
      message: `${path} contains characters outside charset "${schema.charset}"`,
    });
  }
}

function validateList(
  path: string,
  value: unknown,
  schema: ListFieldSchema,
  errors: ValidationError[],
): void {
  if (!Array.isArray(value)) {
    errors.push({
      field: path,
      code: "TYPE",
      message: `${path} must be a list (got ${describeJsonType(value)})`,
    });
    return;
  }
  if (schema.min_count !== undefined && value.length < schema.min_count) {
    errors.push({
      field: path,
      code: "MIN_COUNT",
      message: `${path} must have at least ${schema.min_count} item${schema.min_count === 1 ? "" : "s"}, got ${value.length}`,
    });
  }
  if (schema.max_count !== undefined && value.length > schema.max_count) {
    errors.push({
      field: path,
      code: "MAX_COUNT",
      message: `${path} must have at most ${schema.max_count} item${schema.max_count === 1 ? "" : "s"}, got ${value.length}`,
    });
  }
  if (schema.unique === true) {
    detectDuplicates(path, value, errors);
  }
  for (let i = 0; i < value.length; i += 1) {
    const itemPath = `${path}[${i}]`;
    const item = value[i];
    if (schema.item_type === "string") {
      if (typeof item !== "string") {
        errors.push({
          field: itemPath,
          code: "TYPE",
          message: `${itemPath} must be a string (got ${describeJsonType(item)})`,
        });
        continue;
      }
      const itemSchema: Pick<
        StringFieldSchema,
        "min_length" | "max_length" | "pattern" | "charset"
      > = {};
      if (schema.charset !== undefined) itemSchema.charset = schema.charset;
      if (schema.pattern !== undefined) itemSchema.pattern = schema.pattern;
      applyStringConstraints(itemPath, item, itemSchema, errors);
    } else {
      // item_type === "object"
      const fields = schema.fields ?? {};
      const objSchema: ObjectFieldSchema = { type: "object", fields };
      validateObject(itemPath, item, objSchema, errors);
    }
  }
}

function validateObject(
  path: string,
  value: unknown,
  schema: ObjectFieldSchema,
  errors: ValidationError[],
): void {
  if (!isPlainObject(value)) {
    errors.push({
      field: path,
      code: "TYPE",
      message: `${path} must be an object (got ${describeJsonType(value)})`,
    });
    return;
  }
  for (const [k, sub] of Object.entries(schema.fields)) {
    const childPath = `${path}.${k}`;
    if (!hasOwn(value, k)) {
      errors.push({
        field: childPath,
        code: "MISSING",
        message: `${childPath} is required but was not provided`,
      });
      continue;
    }
    validateField(childPath, value[k], sub, errors);
  }
}

function validateEnum(
  path: string,
  value: unknown,
  schema: EnumFieldSchema,
  errors: ValidationError[],
): void {
  if (typeof value !== "string") {
    errors.push({
      field: path,
      code: "TYPE",
      message: `${path} must be a string for enum (got ${describeJsonType(value)})`,
    });
    return;
  }
  const caseSensitive = schema.case_sensitive !== false;
  const matched = caseSensitive
    ? schema.allowed.includes(value)
    : schema.allowed.some((a) => a.toLowerCase() === value.toLowerCase());
  if (!matched) {
    errors.push({
      field: path,
      code: "ENUM",
      message: `${path} must be one of [${schema.allowed.join(", ")}], got "${value}"`,
    });
  }
}

function detectDuplicates(
  path: string,
  items: unknown[],
  errors: ValidationError[],
): void {
  const seen = new Map<string, number>();
  const duplicateIndices: number[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const key = canonicalize(items[i]);
    if (seen.has(key)) {
      duplicateIndices.push(i);
    } else {
      seen.set(key, i);
    }
  }
  if (duplicateIndices.length > 0) {
    errors.push({
      field: path,
      code: "DUPLICATE",
      message: `${path} contains duplicate items at indices [${duplicateIndices.join(", ")}]`,
    });
  }
}

// Order-independent JSON canonicalization for duplicate detection. Object
// keys are sorted so {a:1,b:2} and {b:2,a:1} compare equal.
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

function hasOwn(
  obj: Record<string, unknown>,
  key: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function describeJsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "list";
  return typeof value;
}
