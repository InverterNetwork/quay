// Ticket-validator types per the ticket-validation spec §5.
//
// `TicketSchema` is the in-memory shape produced by `loadSchema()`; regex
// patterns are pre-compiled so `validateTicket()` stays a pure CPU function
// (no regex compilation, no I/O) per §3 "Determinism".

export type CharsetName = "any" | "lowercase_alphanum_dash" | "ascii_printable";

export interface StringFieldSchema {
  type: "string";
  min_length?: number;
  max_length?: number;
  pattern?: RegExp;
  charset?: CharsetName;
  description?: string;
}

export interface ListFieldSchema {
  type: "list";
  item_type: "string" | "object";
  min_count?: number;
  max_count?: number;
  unique?: boolean;
  charset?: CharsetName;
  pattern?: RegExp;
  // When item_type === "object", these declare the per-item object shape.
  fields?: Record<string, FieldSchema>;
  description?: string;
}

export interface ObjectFieldSchema {
  type: "object";
  fields: Record<string, FieldSchema>;
  description?: string;
}

export interface EnumFieldSchema {
  type: "enum";
  allowed: string[];
  case_sensitive?: boolean;
  description?: string;
}

export type FieldSchema =
  | StringFieldSchema
  | ListFieldSchema
  | ObjectFieldSchema
  | EnumFieldSchema;

export interface TicketSchema {
  required: Record<string, FieldSchema>;
  optional: Record<string, FieldSchema>;
}

export type TicketDraft = Record<string, unknown>;

// Per spec §5: stable machine-readable codes for the LLM rewrite loop.
export type ValidationCode =
  | "MISSING"
  | "TYPE"
  | "MIN_LENGTH"
  | "MAX_LENGTH"
  | "PATTERN"
  | "CHARSET"
  | "MIN_COUNT"
  | "MAX_COUNT"
  | "DUPLICATE"
  | "ENUM";

export interface ValidationError {
  field: string;
  code: ValidationCode;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}
