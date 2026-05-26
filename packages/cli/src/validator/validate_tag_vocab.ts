// Pure tag-vocab enforcement against a pre-merged (deployment ∪ per-repo)
// vocab. Tags are split on the first `-` — namespace is the prefix, value is
// everything after. Callers own the opt-in gate (skip when per-repo vocab is
// empty); this module always enforces against whatever vocab it receives.

import type { MergedVocab } from "../core/tags/merge.ts";
import type { ValidationError } from "./types.ts";

export interface ParsedTag {
  namespace: string;
  value: string;
}

export function parseTagToken(tag: string): ParsedTag | null {
  const dash = tag.indexOf("-");
  if (dash <= 0 || dash === tag.length - 1) return null;
  return { namespace: tag.slice(0, dash), value: tag.slice(dash + 1) };
}

export function validateTagVocab(
  tags: readonly unknown[],
  merged: MergedVocab,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const matchedNamespaces = new Set<string>();

  for (let i = 0; i < tags.length; i += 1) {
    const tag = tags[i];
    // Non-string entries already get a TYPE error from the schema validator;
    // skip silently here so error indices keep matching the original array.
    if (typeof tag !== "string") continue;
    const path = `tags[${i}]`;
    const parsed = parseTagToken(tag);
    if (parsed === null) {
      errors.push({
        field: path,
        code: "TAG_UNKNOWN_NAMESPACE",
        message: `${path}="${tag}" must be of the form "<namespace>-<value>"`,
      });
      continue;
    }
    const ns = merged.namespaces[parsed.namespace];
    if (ns === undefined) {
      errors.push({
        field: path,
        code: "TAG_UNKNOWN_NAMESPACE",
        message: `${path}="${tag}" uses unknown namespace "${parsed.namespace}"`,
      });
      continue;
    }
    if (!ns.values.includes(parsed.value)) {
      errors.push({
        field: path,
        code: "TAG_UNKNOWN_VALUE",
        message: `${path}="${tag}" uses unknown value "${parsed.value}" in namespace "${parsed.namespace}" (allowed: [${ns.values.join(", ")}])`,
      });
      continue;
    }
    matchedNamespaces.add(parsed.namespace);
  }

  for (const ns of Object.keys(merged.namespaces).sort()) {
    const spec = merged.namespaces[ns]!;
    if (spec.required && !matchedNamespaces.has(ns)) {
      errors.push({
        field: "tags",
        code: "TAG_REQUIRED_MISSING",
        message: `tags must include at least one value from required namespace "${ns}"`,
      });
    }
  }

  return errors;
}
