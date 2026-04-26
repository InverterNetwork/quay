import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "../db/connection.ts";
import type { Clock } from "../ports/clock.ts";

export interface WriteArtifactInput {
  taskId: string;
  attemptId: number | null;
  kind: string;
  content: string | Uint8Array;
  extension?: string;
}

export interface WriteArtifactResult {
  artifactId: number;
  filePath: string;
  contentHash: string;
  capturedAt: string;
}

export interface ArtifactStoreDeps {
  db: DB;
  artifactRoot: string;
  clock: Clock;
}

export function createArtifactStore({ db, artifactRoot, clock }: ArtifactStoreDeps) {
  return {
    writeArtifact(input: WriteArtifactInput): WriteArtifactResult {
      const buffer =
        typeof input.content === "string"
          ? new TextEncoder().encode(input.content)
          : input.content;

      const contentHash = createHash("sha256").update(buffer).digest("hex");
      const ext = input.extension ?? "bin";
      const attemptDir = input.attemptId === null ? "task" : String(input.attemptId);
      const dir = join(artifactRoot, input.taskId, attemptDir, input.kind);
      mkdirSync(dir, { recursive: true });
      const filePath = join(dir, `${contentHash.slice(0, 16)}.${ext}`);
      writeFileSync(filePath, buffer);

      const capturedAt = clock.nowISO();
      const row = db
        .query<{ artifact_id: number }, [string, number | null, string, string, string, string]>(
          `INSERT INTO artifacts (task_id, attempt_id, kind, file_path, content_hash, captured_at)
           VALUES (?, ?, ?, ?, ?, ?)
           RETURNING artifact_id`,
        )
        .get(input.taskId, input.attemptId, input.kind, filePath, contentHash, capturedAt);

      if (!row) {
        throw new Error("artifact insert returned no row");
      }

      return {
        artifactId: row.artifact_id,
        filePath,
        contentHash,
        capturedAt,
      };
    },
  };
}

export type ArtifactStore = ReturnType<typeof createArtifactStore>;
