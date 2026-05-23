import {
  ADMIN_API_VERSION,
  type AdminApiRuntime,
} from "../admin/api.ts";
import {
  startAdminApiServer,
  type StartedAdminApiServer,
} from "../admin/server.ts";
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
  const server = startServer({
    runtime,
    hostname: parsed.hostname,
    port: parsed.port,
  });
  io.stdout(
    `${JSON.stringify({
      listening: true,
      url: server.url,
      host: server.hostname,
      port: server.port,
      api_version: ADMIN_API_VERSION,
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
  | { ok: true; hostname: string; port: number }
  | { ok: false; message: string };

export function parseServeArgs(argv: string[]): ServeArgsResult {
  let hostname = DEFAULT_HOST;
  let port = DEFAULT_PORT;

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
    return { ok: false, message: `unknown serve argument: ${arg}` };
  }

  if (hostname.trim() === "") {
    return { ok: false, message: "--host must not be empty" };
  }

  return { ok: true, hostname, port };
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
