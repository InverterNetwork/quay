// Per-attempt tool-call trace capture. The default agent invocation
// passes `--debug --debug-file .quay-tool-trace.log` so claude streams
// its tool-dispatch and API events into a worktree-local file; this
// module ingests the bytes verbatim as a `tool_trace` artifact at
// attempt end.
//
// Debug logs can run to megabytes. Capping reads at MAX_TOOL_TRACE_BYTES
// with a tail bias mirrors the session_log behaviour: the most recent
// events are the ones an operator scrolling backward from "what
// happened at the end?" reaches first. Same content_hash idempotency
// path as the other recovery-safe artifacts.

import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactStore } from "../artifacts/store.ts";
import type { DB } from "../db/connection.ts";

const TOOL_TRACE_FILE = ".quay-tool-trace.log";
// Same 4 MiB cap the tmux adapter applies to session_log. A debug
// trace bigger than this almost certainly contains repeated polling
// noise that the tail captures anyway; the head bytes describe spawn
// startup and rarely change across attempts.
const MAX_TOOL_TRACE_BYTES = 4 * 1024 * 1024;

export interface ToolTraceDeps {
  db: DB;
  artifactStore: ArtifactStore;
}

export function collectToolTraceArtifact(
  deps: ToolTraceDeps,
  taskId: string,
  attemptId: number,
  worktreePath: string,
): void {
  const path = join(worktreePath, TOOL_TRACE_FILE);
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return;
  }
  if (!stats.isFile()) return;
  if (stats.size === 0) return;

  let bytes: string;
  try {
    bytes =
      stats.size <= MAX_TOOL_TRACE_BYTES
        ? readFileSync(path, "utf8")
        : tailRead(path, stats.size, MAX_TOOL_TRACE_BYTES);
  } catch {
    return;
  }
  if (bytes.length === 0) return;

  try {
    deps.artifactStore.writeArtifact({
      taskId,
      attemptId,
      kind: "tool_trace",
      content: bytes,
      extension: "log",
    });
  } catch {
    // UNIQUE violation on (task_id, attempt_id, kind, content_hash) is
    // the crash-recovery idempotent-success case; any other failure is
    // also swallowed because trace capture must never block a terminal
    // transition.
  }
}

// Read the last `cap` bytes of a file. Bun's `Bun.file().slice()`
// returns a Promise (and decoded as empty when called synchronously
// in earlier code paths), so we use Node's blocking `openSync` +
// positional `readSync` — the same approach the tmux adapter uses
// for session_log tail-reads.
function tailRead(path: string, fileSize: number, cap: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(cap);
    const offset = fileSize - cap;
    let total = 0;
    while (total < cap) {
      const n = readSync(fd, buf, total, cap - total, offset + total);
      if (n === 0) break;
      total += n;
    }
    return buf.subarray(0, total).toString("utf8");
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
}
