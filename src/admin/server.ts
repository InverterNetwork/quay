import {
  createAdminApiHandler,
  type AdminApiRuntime,
} from "./api.ts";

export interface StartAdminApiServerOptions {
  runtime: AdminApiRuntime;
  hostname: string;
  port: number;
}

export type AdminApiServer = ReturnType<typeof Bun.serve>;

export interface StartedAdminApiServer {
  server: AdminApiServer;
  hostname: string;
  port: number;
  url: string;
  stop: () => void;
}

export function startAdminApiServer(
  opts: StartAdminApiServerOptions,
): StartedAdminApiServer {
  const server = Bun.serve({
    hostname: opts.hostname,
    port: opts.port,
    fetch: createAdminApiHandler(opts.runtime),
  });
  const hostname = server.hostname ?? opts.hostname;
  const port = server.port ?? opts.port;
  return {
    server,
    hostname,
    port,
    url: formatHttpUrl(hostname, port),
    stop: () => server.stop(true),
  };
}

function formatHttpUrl(hostname: string, port: number): string {
  const host = hostname.includes(":") ? `[${hostname}]` : hostname;
  return `http://${host}:${port}`;
}
