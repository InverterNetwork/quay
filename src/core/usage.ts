// Per-attempt token/cost/model envelope capture. The spawn wrapper
// redirects the agent's `--output-format json` stdout into
// `<worktree>/.quay-usage.json`; this module reads the file at attempt
// end and persists its bytes verbatim as a `usage` artifact.
//
// Storage is content-addressed via the artifact store's content_hash
// idempotency: re-running the classifier on the same attempt (crash
// recovery) re-hashes the same bytes and the second insert is rejected
// by the partial unique index. Capture is best-effort — missing,
// empty, or malformed envelopes leave no artifact and never throw.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { DB } from "../db/connection.ts";

const USAGE_FILE = ".quay-usage.json";
// Cap parses at 1 MiB. Claude's `--output-format json` envelope is a
// few KiB in practice; anything orders of magnitude beyond that
// indicates a misbehaving runtime and is more useful as a NULL row
// than as a multi-megabyte artifact bloating the store.
const MAX_USAGE_BYTES = 1 * 1024 * 1024;

export interface UsageDeps {
  db: DB;
  artifactStore: ArtifactStore;
}

export function collectUsageArtifact(
  deps: UsageDeps,
  taskId: string,
  attemptId: number,
  worktreePath: string,
): void {
  const path = join(worktreePath, USAGE_FILE);
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return;
  }
  if (!stats.isFile()) return;
  if (stats.size === 0) return;
  if (stats.size > MAX_USAGE_BYTES) return;

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }

  // Validate before persisting: a malformed envelope (truncated by a
  // wall-clock kill mid-write, written by an agent that doesn't honour
  // --output-format json, etc.) is worse than no artifact, since
  // downstream queries assume the bytes are JSON.
  try {
    JSON.parse(raw);
  } catch {
    return;
  }

  try {
    deps.artifactStore.writeArtifact({
      taskId,
      attemptId,
      kind: "usage",
      content: raw,
      extension: "json",
    });
  } catch {
    // UNIQUE violation on (task_id, attempt_id, kind, content_hash) is
    // the crash-recovery idempotent-success case; any other failure is
    // also swallowed because usage capture must never block the
    // terminal transition.
  }
}
