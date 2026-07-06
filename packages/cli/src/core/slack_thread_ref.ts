import { QuayError } from "./errors.ts";

const SLACK_THREAD_REF_PREFIX = "slack:";
const SLACK_THREAD_REF_CHANNEL = /^[CGD][A-Z0-9]+$/;
const SLACK_THREAD_REF_TS = /^\d+\.\d+$/;

export function normalizeSlackThreadRef(
  ref: string | null | undefined,
): string | null {
  if (ref === null || ref === undefined) return null;
  const trimmed = ref.trim();
  const unprefixed = trimmed.startsWith(SLACK_THREAD_REF_PREFIX)
    ? trimmed.slice(SLACK_THREAD_REF_PREFIX.length)
    : trimmed;
  const parts = unprefixed.split(":");
  if (parts.length !== 2) {
    throw invalidSlackThreadRef(ref);
  }
  const [channel, threadTs] = parts;
  if (
    channel === undefined ||
    threadTs === undefined ||
    !SLACK_THREAD_REF_CHANNEL.test(channel) ||
    !SLACK_THREAD_REF_TS.test(threadTs)
  ) {
    throw invalidSlackThreadRef(ref);
  }
  return `${channel}:${threadTs}`;
}

export function normalizeStoredSlackThreadRef(
  ref: string | null | undefined,
): string | null {
  if (ref === null || ref === undefined) return null;
  try {
    return normalizeSlackThreadRef(ref);
  } catch (err) {
    if (err instanceof QuayError && err.code === "validation_error") {
      return ref;
    }
    throw err;
  }
}

function invalidSlackThreadRef(ref: string): QuayError {
  return new QuayError(
    "validation_error",
    "slack_thread_ref must be CHANNEL:THREAD_TS or slack:CHANNEL:THREAD_TS",
    { slack_thread_ref: ref },
  );
}
