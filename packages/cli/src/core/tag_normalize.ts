// Tag normalization shared by the ticket-context builder (block tags) and
// the `--linear-issue` CLI handler (CLI `--tag` values). Both feed the
// validator's `tags` payload, so they must converge on the same shape:
// lower-cased, exact-deduped (first occurrence wins to preserve ordering).
//
// Charset and emptiness are enforced by the validator (ticket-validation
// spec §6); this helper does normalization only, so a typo'd CLI tag still
// surfaces as a `validation_error` rather than passing through unchanged.

export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.toLowerCase();
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export function mergeNormalizedTags(
  ...lists: ReadonlyArray<readonly string[]>
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const raw of list) {
      const t = raw.toLowerCase();
      if (seen.has(t)) continue;
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}
