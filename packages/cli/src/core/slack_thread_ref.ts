import { QuayError } from "./errors.ts";

export function normalizeSlackThreadRef(ref: string | null): string | null {
  if (ref === null) return null;
  const trimmed = ref.trim();
  const match = /^(?:slack:)?([^\s:]+):([0-9]+\.[0-9]+)$/.exec(trimmed);
  if (match === null) {
    throw new QuayError(
      "validation_error",
      "slack_thread_ref must be CHANNEL:THREAD_TS or slack:CHANNEL:THREAD_TS",
      { slack_thread_ref: ref },
    );
  }
  return `${match[1]}:${match[2]}`;
}
