import { z } from "zod";
import type { TagVocab } from "./service.ts";
import { QuayError } from "../errors.ts";
import { parseOrThrow } from "../zod_helpers.ts";

export interface ImportPlan {
  desired: Record<string, { values: string[]; required?: boolean | undefined }>;
  current: TagVocab;
  isNoop: boolean;
  needsForce: boolean;
}

const nsSpecSchema = z
  .object({
    values: z.array(z.string()),
    required: z.boolean().optional(),
  })
  .strict();

// Top-level passthrough so unrelated TOML sections (e.g. `[adapters]`) survive
// without complaint. `tags` and `tags.namespaces` are typed strictly so a
// wrong-type entry surfaces as a validation_error instead of being silently
// treated as "missing".
const importTomlSchema = z
  .object({
    tags: z
      .object({
        namespaces: z.record(z.string(), nsSpecSchema).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export function parseImportToml(
  raw: string,
): Record<string, { values: string[]; required?: boolean | undefined }> {
  // Bun.TOML.parse throws AggregateError on syntax errors. Wrap it so
  // user-supplied broken input surfaces as validation_error rather than
  // bubbling up to dispatch as internal_error.
  let doc: unknown;
  try {
    doc = Bun.TOML.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new QuayError("validation_error", `tags import TOML is not valid TOML: ${message}`);
  }
  const parsed = parseOrThrow(importTomlSchema, doc, "tags import TOML");
  const namespaces = parsed.tags?.namespaces ?? {};
  // Dedupe values in each namespace so a TOML with `values = ["x", "x"]`
  // round-trips through the deduped DB storage as a no-op on re-import.
  const result: Record<string, { values: string[]; required?: boolean | undefined }> = {};
  for (const [ns, spec] of Object.entries(namespaces)) {
    result[ns] = spec.required !== undefined
      ? { values: Array.from(new Set(spec.values)), required: spec.required }
      : { values: Array.from(new Set(spec.values)) };
  }
  return result;
}

export function planImport(
  desired: ReturnType<typeof parseImportToml>,
  current: TagVocab,
): ImportPlan {
  const isNoop = desiredEqualsCurrent(desired, current);
  const needsForce = !isNoop && Object.keys(current).length > 0;
  return { desired, current, isNoop, needsForce };
}

function desiredEqualsCurrent(
  desired: Record<string, { values: string[]; required?: boolean | undefined }>,
  current: TagVocab,
): boolean {
  const desiredKeys = Object.keys(desired).sort();
  const currentKeys = Object.keys(current).sort();
  if (desiredKeys.length !== currentKeys.length) return false;
  for (let i = 0; i < desiredKeys.length; i++) {
    if (desiredKeys[i] !== currentKeys[i]) return false;
  }
  for (const key of desiredKeys) {
    const d = desired[key]!;
    const c = current[key];
    if (!c) return false;
    const dValues = [...d.values].sort();
    const cValues = [...c.values].sort();
    if (dValues.length !== cValues.length) return false;
    for (let i = 0; i < dValues.length; i++) {
      if (dValues[i] !== cValues[i]) return false;
    }
    if ((d.required ?? false) !== c.required) return false;
  }
  return true;
}
