import { accessSync, constants, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ADMIN_API_VERSION,
  type AdminApiRuntime,
} from "../admin/api.ts";
import {
  startAdminApiServer,
  type StartedAdminApiServer,
} from "../admin/server.ts";
import { assertAdminAuthReady } from "../admin/auth.ts";
import type { QuayRuntime } from "../runtime/quay_runtime.ts";
import { commandHelp, wantsHelp } from "./help.ts";
import type { CliIO } from "./io.ts";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9731;

export interface RunServeCommandOptions {
  waitForShutdown?: () => Promise<void>;
  startServer?: (opts: {
    runtime: AdminApiRuntime;
    hostname: string;
    port: number;
    uiDir?: string | null;
  }) => StartedAdminApiServer;
}

export async function runServeCommand(
  argv: string[],
  runtime: QuayRuntime,
  io: CliIO,
  opts: RunServeCommandOptions = {},
): Promise<number> {
  if (wantsHelp(argv)) {
    io.stdout(commandHelp(["serve"]) ?? "");
    return 0;
  }

  const parsed = parseServeArgs(argv);
  if (!parsed.ok) {
    io.stderr(
      `${JSON.stringify({ error: "usage_error", message: parsed.message })}\n`,
    );
    const help = commandHelp(["serve"]);
    if (help !== null) io.stderr(`\n${help}`);
    return 1;
  }

  const startServer = opts.startServer ?? startAdminApiServer;
  const waitForShutdown = opts.waitForShutdown ?? waitForProcessSignal;
  let uiDirPath: string | null = null;
  if (parsed.uiDir !== null) {
    const validation = validateUiDir(parsed.uiDir);
    if (!validation.ok) {
      io.stderr(
        `${JSON.stringify({ error: "startup_error", message: validation.message })}\n`,
      );
      return 2;
    }
    uiDirPath = validation.path;
  }

  try {
    assertAdminAuthReady(runtime);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(
      `${JSON.stringify({ error: "startup_error", message })}\n`,
    );
    return 2;
  }

  let server: StartedAdminApiServer;
  try {
    server = startServer({
      runtime,
      hostname: parsed.hostname,
      port: parsed.port,
      uiDir: uiDirPath,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.stderr(
      `${JSON.stringify({ error: "startup_error", message })}\n`,
    );
    return 2;
  }
  io.stdout(
    `${JSON.stringify({
      listening: true,
      url: server.url,
      host: server.hostname,
      port: server.port,
      api_version: ADMIN_API_VERSION,
      ui_dir: uiDirPath ?? undefined,
    })}\n`,
  );

  try {
    await waitForShutdown();
  } finally {
    server.stop();
  }
  return 0;
}

export type ServeArgsResult =
  | { ok: true; hostname: string; port: number; uiDir: string | null }
  | { ok: false; message: string };

export function parseServeArgs(argv: string[]): ServeArgsResult {
  let hostname = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  let uiDir: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--host") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, message: "--host requires a value" };
      }
      hostname = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--host=")) {
      hostname = arg.slice("--host=".length);
      continue;
    }
    if (arg === "--port") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, message: "--port requires a value" };
      }
      const parsedPort = parsePort(value);
      if (parsedPort === null) {
        return { ok: false, message: "--port must be an integer from 1 to 65535" };
      }
      port = parsedPort;
      i += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      const parsedPort = parsePort(arg.slice("--port=".length));
      if (parsedPort === null) {
        return { ok: false, message: "--port must be an integer from 1 to 65535" };
      }
      port = parsedPort;
      continue;
    }
    if (arg === "--ui-dir") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, message: "--ui-dir requires a value" };
      }
      if (value.trim() === "") {
        return { ok: false, message: "--ui-dir must not be empty" };
      }
      uiDir = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--ui-dir=")) {
      const value = arg.slice("--ui-dir=".length);
      if (value.trim() === "") {
        return { ok: false, message: "--ui-dir must not be empty" };
      }
      uiDir = value;
      continue;
    }
    return { ok: false, message: `unknown serve argument: ${arg}` };
  }

  if (hostname.trim() === "") {
    return { ok: false, message: "--host must not be empty" };
  }
  hostname = hostname.trim();
  if (!isLoopbackHost(hostname)) {
    return {
      ok: false,
      message: "--host must be a loopback address: 127.0.0.1, ::1, or localhost",
    };
  }

  return { ok: true, hostname, port, uiDir };
}

export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized === "0:0:0:0:0:0:0:1"
  ) {
    return true;
  }

  const parts = normalized.split(".");
  if (parts.length !== 4 || parts[0] !== "127") return false;
  return parts.every((part) => {
    if (!/^\d+$/.test(part)) return false;
    const n = Number(part);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

export function waitForProcessSignal(): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolve();
    };
    process.on("SIGINT", finish);
    process.on("SIGTERM", finish);
  });
}

function parsePort(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

type UiDirValidation =
  | { ok: true; path: string }
  | { ok: false; message: string };

export function validateUiDir(rawPath: string): UiDirValidation {
  const path = resolve(rawPath);
  let dirStat: ReturnType<typeof statSync>;
  try {
    dirStat = statSync(path);
  } catch {
    return { ok: false, message: `--ui-dir path does not exist: ${path}` };
  }
  if (!dirStat.isDirectory()) {
    return { ok: false, message: `--ui-dir must point to a directory: ${path}` };
  }
  try {
    accessSync(path, constants.R_OK);
  } catch {
    return { ok: false, message: `--ui-dir is not readable: ${path}` };
  }

  const indexPath = join(path, "index.html");
  let indexStat: ReturnType<typeof statSync>;
  try {
    indexStat = statSync(indexPath);
  } catch {
    return {
      ok: false,
      message: `--ui-dir must contain index.html: ${indexPath}`,
    };
  }
  if (!indexStat.isFile()) {
    return {
      ok: false,
      message: `--ui-dir index.html must be a file: ${indexPath}`,
    };
  }
  try {
    accessSync(indexPath, constants.R_OK);
  } catch {
    return { ok: false, message: `--ui-dir index.html is not readable: ${indexPath}` };
  }
  return { ok: true, path };
}
