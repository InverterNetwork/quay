import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import {
  createAdminApiHandler,
  type AdminApiRuntime,
} from "./api.ts";
import {
  resolveAdminAuth,
} from "./auth.ts";
import { EMBEDDED_UI_ASSETS } from "../build/embedded.generated.ts";

// Bun.serve rejects idleTimeout values above 255 seconds.
export const ADMIN_API_SERVER_IDLE_TIMEOUT_SECONDS = 255;

export interface EmbeddedUiAsset {
  readonly path: string;
  readonly contentBase64: string;
}

export interface StartAdminApiServerOptions {
  runtime: AdminApiRuntime;
  hostname: string;
  port: number;
  uiDir?: string | null;
  embeddedUiAssets?: readonly EmbeddedUiAsset[];
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
  const handlerOpts: {
    uiDir?: string | null;
    embeddedUiAssets?: readonly EmbeddedUiAsset[];
  } = {};
  if (opts.uiDir !== undefined) handlerOpts.uiDir = opts.uiDir;
  if (opts.embeddedUiAssets !== undefined) {
    handlerOpts.embeddedUiAssets = opts.embeddedUiAssets;
  }
  const server = Bun.serve({
    hostname: opts.hostname,
    port: opts.port,
    idleTimeout: ADMIN_API_SERVER_IDLE_TIMEOUT_SECONDS,
    fetch: createAdminApiServerHandler(opts.runtime, handlerOpts),
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

export function createAdminApiServerHandler(
  runtime: AdminApiRuntime,
  opts: {
    uiDir?: string | null;
    embeddedUiAssets?: readonly EmbeddedUiAsset[];
  } = {},
) {
  if (opts.uiDir !== undefined && opts.uiDir !== null) {
    return createHostedAdminApiHandler(runtime, opts.uiDir);
  }
  const embeddedUiAssets = opts.embeddedUiAssets ?? EMBEDDED_UI_ASSETS;
  if (embeddedUiAssets.length > 0) {
    return createEmbeddedAdminApiHandler(runtime, embeddedUiAssets);
  }
  return createAdminApiHandler(runtime);
}

export function createHostedAdminApiHandler(
  runtime: AdminApiRuntime,
  uiDir: string,
) {
  return createAdminUiHandler(runtime, createStaticUiHandler(runtime, uiDir));
}

export function createEmbeddedAdminApiHandler(
  runtime: AdminApiRuntime,
  assets: readonly EmbeddedUiAsset[],
) {
  return createAdminUiHandler(
    runtime,
    createEmbeddedStaticUiHandler(runtime, assets),
  );
}

function createAdminUiHandler(
  runtime: AdminApiRuntime,
  staticHandler: (request: Request) => Promise<Response>,
) {
  const apiHandler = createAdminApiHandler(runtime);
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

function createStaticUiHandler(runtime: AdminApiRuntime, uiDir: string) {
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
    const target = staticTarget(url.pathname);
    if (!target.ok) {
      return textResponse(400, target.message, {}, request.method);
    }
    const targetPath = staticFilePath(root, target.segments);
    if (!targetPath.ok) {
      return textResponse(400, targetPath.message, {}, request.method);
    }

    const response = await readStaticFile(
      targetPath.path,
      url.pathname,
      request.method,
      runtime,
    );
    if (response !== null) return response;

    if (target.assetRequest && !isAdminUiSpaRoute(target.segments)) {
      return textResponse(
        404,
        `static asset not found: ${url.pathname}`,
        {},
        request.method,
      );
    }

    return (await readStaticFile(indexPath, "/index.html", request.method, runtime)) ??
      textResponse(
        500,
        "static UI index.html is no longer readable",
        {},
        request.method,
      );
  };
}

function createEmbeddedStaticUiHandler(
  runtime: AdminApiRuntime,
  assets: readonly EmbeddedUiAsset[],
) {
  const assetByPath = new Map<string, EmbeddedUiAsset>();
  for (const asset of assets) {
    assetByPath.set(normalizeEmbeddedAssetPath(asset.path), asset);
  }
  const indexAsset = assetByPath.get("index.html");
  if (indexAsset === undefined) {
    throw new Error("embedded UI assets must include index.html");
  }

  return async function handleEmbeddedStaticUi(
    request: Request,
  ): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return textResponse(
        405,
        `method ${request.method} is not allowed for static UI assets`,
        { Allow: "GET, HEAD" },
        request.method,
      );
    }

    const url = new URL(request.url);
    const target = staticTarget(url.pathname);
    if (!target.ok) {
      return textResponse(400, target.message, {}, request.method);
    }

    const targetAsset = assetByPath.get(staticAssetPath(target.segments));
    if (targetAsset !== undefined) {
      return embeddedAssetResponse(targetAsset, url.pathname, request.method, runtime);
    }

    if (target.assetRequest && !isAdminUiSpaRoute(target.segments)) {
      return textResponse(
        404,
        `static asset not found: ${url.pathname}`,
        {},
        request.method,
      );
    }

    return embeddedAssetResponse(indexAsset, "/index.html", request.method, runtime);
  };
}

function isAdminApiPath(pathname: string): boolean {
  return pathname === "/v1" || pathname.startsWith("/v1/");
}

function isAdminUiSpaRoute(segments: readonly string[]): boolean {
  return segments[0] === "mission-control" || segments[0] === "configuration";
}

type StaticTargetResult =
  | { ok: true; segments: string[]; assetRequest: boolean }
  | { ok: false; message: string };

function staticTarget(pathname: string): StaticTargetResult {
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
  return {
    ok: true,
    segments,
    assetRequest: isAssetRequest(pathname, segments),
  };
}

type StaticFilePathResult =
  | { ok: true; path: string }
  | { ok: false; message: string };

function staticFilePath(root: string, segments: string[]): StaticFilePathResult {
  const path = segments.length === 0
    ? join(root, "index.html")
    : join(root, ...segments);
  const resolved = resolve(path);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    return { ok: false, message: "static asset path escapes ui root" };
  }
  return { ok: true, path: resolved };
}

function staticAssetPath(segments: string[]): string {
  return segments.length === 0 ? "index.html" : segments.join("/");
}

function normalizeEmbeddedAssetPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  const segments = normalized.split("/");
  if (
    normalized === "" ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`invalid embedded UI asset path: ${path}`);
  }
  return normalized;
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
  runtime: AdminApiRuntime,
): Promise<Response | null> {
  try {
    const bytes = await readFile(filePath);
    return staticAssetResponse(bytes, requestPath, method, runtime);
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

function embeddedAssetResponse(
  asset: EmbeddedUiAsset,
  requestPath: string,
  method: string,
  runtime: AdminApiRuntime,
): Response {
  return staticAssetResponse(
    Buffer.from(asset.contentBase64, "base64"),
    requestPath,
    method,
    runtime,
  );
}

function staticAssetResponse(
  bytes: Uint8Array,
  requestPath: string,
  method: string,
  runtime: AdminApiRuntime,
): Response {
  return new Response(method === "HEAD" ? null : bodyForStaticAsset(bytes, requestPath, runtime), {
    status: 200,
    headers: staticHeaders(requestPath),
  });
}

function bodyForStaticAsset(
  bytes: Uint8Array,
  requestPath: string,
  runtime: AdminApiRuntime,
): Uint8Array | string {
  if (!isIndexHtmlRequestPath(requestPath)) return bytes;
  return injectIndexRuntimeConfig(new TextDecoder().decode(bytes), runtime);
}

const RUNTIME_CONFIG_SCRIPT =
  `window.__QUAY_API_BASE_URL__=window.__QUAY_API_BASE_URL__??window.location.origin;`;

const ADMIN_AUTH_BOOTSTRAP_MARKER = "__QUAY_ADMIN_AUTH_BOOTSTRAP__";

function runtimeConfigScript(runtime: AdminApiRuntime): string {
  const auth = resolveAdminAuth(runtime);
  const lines = [RUNTIME_CONFIG_SCRIPT];
  if (auth.enabled) {
    lines.push(`window.${ADMIN_AUTH_BOOTSTRAP_MARKER}=true;`);
    lines.push(`(()=>{const key="quay_admin_token";const params=new URLSearchParams(window.location.hash.startsWith("#")?window.location.hash.slice(1):window.location.hash);const token=params.get(key);if(token!==null&&token!==""){window.sessionStorage.setItem(key,token);window.history.replaceState(null,document.title,window.location.pathname+window.location.search);}const originalFetch=window.fetch.bind(window);window.fetch=(input,init={})=>{const url=new URL(input instanceof Request?input.url:String(input),window.location.href);if(url.origin===window.location.origin&&url.pathname.startsWith("/v1/")){const stored=window.sessionStorage.getItem(key);if(stored!==null&&stored!==""){const headers=new Headers(input instanceof Request?input.headers:init.headers);if(!headers.has("Authorization"))headers.set("Authorization",\`Bearer \${stored}\`);if(input instanceof Request){input=new Request(input,{headers});}else{init={...init,headers};}}}return originalFetch(input,init);};})();`);
  }
  return `<script>${lines.join("")}</script>`;
}

function injectIndexRuntimeConfig(html: string, runtime: AdminApiRuntime): string {
  const auth = resolveAdminAuth(runtime);
  if (
    html.includes("__QUAY_API_BASE_URL__") &&
    (!auth.enabled || html.includes(ADMIN_AUTH_BOOTSTRAP_MARKER))
  ) {
    return html;
  }
  const script = runtimeConfigScript(runtime);
  const headClose = html.match(/<\/head\s*>/i);
  if (headClose?.index !== undefined) {
    return `${html.slice(0, headClose.index)}${script}${html.slice(headClose.index)}`;
  }
  const moduleScriptIndex = html.search(/<script\b[^>]*\btype=["']module["'][^>]*>/i);
  if (moduleScriptIndex >= 0) {
    return `${html.slice(0, moduleScriptIndex)}${script}${html.slice(moduleScriptIndex)}`;
  }
  return `${script}${html}`;
}

function isIndexHtmlRequestPath(requestPath: string): boolean {
  return requestPath === "/" || requestPath === "/index.html";
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
  if (pathname === "/") return "text/html; charset=utf-8";
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
