import type { RepoService } from "../core/repos/service.ts";

export const ADMIN_API_VERSION = "v1";
export const ADMIN_API_ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://[::1]:3000",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "http://[::1]:4173",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://[::1]:5173",
] as const;

export interface AdminApiRuntime {
  version: string;
  repoService: RepoService;
}

type JsonHeaders = Record<string, string>;

export function createAdminApiHandler(runtime: AdminApiRuntime) {
  return async function handleAdminApi(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = pathSegments(url.pathname);
    const cors = corsDecision(request);
    if (!cors.ok) {
      return errorResponse(
        403,
        "cors_origin_not_allowed",
        `origin "${cors.origin}" is not allowed`,
        cors.headers,
      );
    }
    if (segments === null) {
      return errorResponse(
        400,
        "bad_request",
        "path contains invalid encoding",
        cors.headers,
      );
    }
    if (request.method === "OPTIONS") {
      if (!isVersionedRoute(segments)) {
        return errorResponse(
          404,
          "not_found",
          `route not found: ${url.pathname}`,
          cors.headers,
        );
      }
      return new Response(null, {
        status: 204,
        headers: {
          ...cors.headers,
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "600",
        },
      });
    }
    if (request.method !== "GET") {
      return errorResponse(
        405,
        "method_not_allowed",
        `method ${request.method} is not allowed`,
        { ...cors.headers, Allow: "GET, OPTIONS" },
      );
    }

    if (segments.length === 2 && segments[0] === "v1" && segments[1] === "meta") {
      return jsonResponse({
        service: "quay",
        api_version: ADMIN_API_VERSION,
        quay_version: runtime.version,
      }, 200, cors.headers);
    }

    if (segments.length === 2 && segments[0] === "v1" && segments[1] === "repos") {
      return jsonResponse(
        runtime.repoService.list({ activeOnly: true }),
        200,
        cors.headers,
      );
    }

    if (
      segments.length === 3 &&
      segments[0] === "v1" &&
      segments[1] === "repos"
    ) {
      const repoId = segments[2];
      if (repoId === undefined) {
        return errorResponse(
          404,
          "not_found",
          `route not found: ${url.pathname}`,
          cors.headers,
        );
      }
      const row = runtime.repoService.get(repoId);
      if (row === null || row.archived_at !== null) {
        return errorResponse(
          404,
          "repo_not_found",
          `repo "${repoId}" not found`,
          cors.headers,
        );
      }
      return jsonResponse(row, 200, cors.headers);
    }

    return errorResponse(
      404,
      "not_found",
      `route not found: ${url.pathname}`,
      cors.headers,
    );
  };
}

function isVersionedRoute(segments: string[]): boolean {
  if (segments[0] !== "v1") return false;
  if (segments.length === 2) return segments[1] === "meta" || segments[1] === "repos";
  return segments.length === 3 && segments[1] === "repos";
}

function corsDecision(
  request: Request,
): { ok: true; headers: JsonHeaders } | { ok: false; origin: string; headers: JsonHeaders } {
  const origin = request.headers.get("origin");
  if (origin === null || origin === "") return { ok: true, headers: {} };
  const headers = { Vary: "Origin" };
  if (!ADMIN_API_ALLOWED_ORIGINS.includes(origin as typeof ADMIN_API_ALLOWED_ORIGINS[number])) {
    return { ok: false, origin, headers };
  }
  return {
    ok: true,
    headers: {
      ...headers,
      "Access-Control-Allow-Origin": origin,
    },
  };
}

function pathSegments(pathname: string): string[] | null {
  try {
    return pathname
      .split("/")
      .filter((part) => part.length > 0)
      .map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
}

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: JsonHeaders = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  extraHeaders: JsonHeaders = {},
): Response {
  return jsonResponse({ error: code, message }, status, extraHeaders);
}
