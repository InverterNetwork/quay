import { z } from "zod";
import type { TagVocab } from "./service.ts";
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
  const doc = Bun.TOML.parse(raw);
  const parsed = parseOrThrow(importTomlSchema, doc, "tags import TOML");
  return parsed.tags?.namespaces ?? {};
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
