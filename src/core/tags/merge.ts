import type { TagVocab } from "./service.ts";

export interface MergedVocab {
  namespaces: TagVocab;
  enforced: boolean;
}

export function mergeVocab(deployment: TagVocab, perRepo: TagVocab): MergedVocab {
  const enforced = Object.keys(perRepo).length > 0;

  const allKeys = Array.from(
    new Set([...Object.keys(deployment), ...Object.keys(perRepo)]),
  ).sort();

  const namespaces: TagVocab = {};
  for (const ns of allKeys) {
    const d = deployment[ns];
    const r = perRepo[ns];
    const dValues = d?.values ?? [];
    const rValues = r?.values ?? [];
    const values = Array.from(new Set([...dValues, ...rValues])).sort();
    const required = (d?.required ?? false) || (r?.required ?? false);
    namespaces[ns] = { values, required };
  }

  return { namespaces, enforced };
}
