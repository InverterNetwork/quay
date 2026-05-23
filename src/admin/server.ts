import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import {
  createAdminApiHandler,
  type AdminApiRuntime,
} from "./api.ts";

export interface StartAdminApiServerOptions {
  runtime: AdminApiRuntime;
  hostname: string;
  port: number;
  uiDir?: string | null;
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
    fetch: opts.uiDir === undefined || opts.uiDir === null
      ? createAdminApiHandler(opts.runtime)
      : createHostedAdminApiHandler(opts.runtime, opts.uiDir),
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

export function createHostedAdminApiHandler(
  runtime: AdminApiRuntime,
  uiDir: string,
) {
  const apiHandler = createAdminApiHandler(runtime);
  const staticHandler = createStaticUiHandler(uiDir);
  return async function handleHostedAdminApi(
    request: Request,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (isAdminApiPath(url.pathname)) {
      return apiHandler(request);
    }
    return staticHandler(request);
  };
}

function createStaticUiHandler(uiDir: string) {
  const root = resolve(uiDir);
  const indexPath = join(root, "index.html");
  return async function handleStaticUi(request: Request): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return textResponse(
        405,
        `method ${request.method} is not allowed for static UI assets`,
        { Allow: "GET, HEAD" },
        request.method,
      );
    }

    const url = new URL(request.url);
    const target = staticTarget(root, url.pathname);
    if (!target.ok) {
      return textResponse(400, target.message, {}, request.method);
    }

    const response = await readStaticFile(
      target.path,
      url.pathname,
      request.method,
    );
    if (response !== null) return response;

    if (target.assetRequest) {
      return textResponse(
        404,
        `static asset not found: ${url.pathname}`,
        {},
        request.method,
      );
    }

    return (await readStaticFile(indexPath, "/index.html", request.method)) ??
      textResponse(
        500,
        "static UI index.html is no longer readable",
        {},
        request.method,
      );
  };
}

function isAdminApiPath(pathname: string): boolean {
  return pathname === "/v1" || pathname.startsWith("/v1/");
}

type StaticTargetResult =
  | { ok: true; path: string; assetRequest: boolean }
  | { ok: false; message: string };

function staticTarget(root: string, pathname: string): StaticTargetResult {
  const rawSegments = pathname.split("/").filter((segment) => segment !== "");
  const segments: string[] = [];
  for (const raw of rawSegments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return {
        ok: false,
        message: "static asset path contains invalid encoding",
      };
    }
    if (decoded === "." || decoded === ".." || decoded.includes("/")) {
      return { ok: false, message: "static asset path contains invalid segment" };
    }
    segments.push(decoded);
  }
  const path = segments.length === 0
    ? join(root, "index.html")
    : join(root, ...segments);
  const resolved = resolve(path);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    return { ok: false, message: "static asset path escapes ui root" };
  }
  return {
    ok: true,
    path: resolved,
    assetRequest: isAssetRequest(pathname, segments),
  };
}

function isAssetRequest(pathname: string, segments: string[]): boolean {
  if (segments.length === 0 || pathname.endsWith("/")) return false;
  const last = segments[segments.length - 1] ?? "";
  return extname(last) !== "";
}

async function readStaticFile(
  filePath: string,
  requestPath: string,
  method: string,
): Promise<Response | null> {
  try {
    const bytes = await readFile(filePath);
    return new Response(method === "HEAD" ? null : bytes, {
      status: 200,
      headers: staticHeaders(requestPath),
    });
  } catch (err) {
    const code = typeof err === "object" && err !== null && "code" in err
      ? String((err as { code?: unknown }).code)
      : "";
    if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") {
      return null;
    }
    return textResponse(
      500,
      `static asset is not readable: ${requestPath}`,
      {},
      method,
    );
  }
}

function staticHeaders(requestPath: string): Record<string, string> {
  const contentType = contentTypeForPath(requestPath);
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  };
  if (
    requestPath === "/" ||
    requestPath === "/index.html" ||
    contentType === "text/html; charset=utf-8"
  ) {
    headers["Cache-Control"] = "no-cache";
  } else if (requestPath.startsWith("/assets/")) {
    headers["Cache-Control"] = "public, max-age=31536000, immutable";
  } else {
    headers["Cache-Control"] = "public, max-age=300";
  }
  return headers;
}

function contentTypeForPath(pathname: string): string {
  switch (extname(pathname).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".map":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function textResponse(
  status: number,
  message: string,
  headers: Record<string, string>,
  method: string,
): Response {
  return new Response(method === "HEAD" ? null : `${message}\n`, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}
