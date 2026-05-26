// Built-in charsets per ticket-validator spec §6 "Built-in `charset` values".
//
// `any` is a no-op (no restriction) and never produces a CHARSET error.
// `lowercase_alphanum_dash` = `[a-z0-9-]+` — suitable for tags/slugs.
// `ascii_printable`         = `[\x20-\x7E]+`.
//
// Patterns are anchored so a single offending character anywhere in the
// string yields a CHARSET error.

import type { CharsetName } from "./types.ts";

const CHARSET_PATTERNS: Record<Exclude<CharsetName, "any">, RegExp> = {
  lowercase_alphanum_dash: /^[a-z0-9-]+$/,
  ascii_printable: /^[\x20-\x7E]+$/,
};

export function isCharset(name: string): name is CharsetName {
  return (
    name === "any" ||
    name === "lowercase_alphanum_dash" ||
    name === "ascii_printable"
  );
}

export function charsetAccepts(name: CharsetName, value: string): boolean {
  if (name === "any") return true;
  return CHARSET_PATTERNS[name].test(value);
}
