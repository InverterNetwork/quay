import type { RepoService } from "../core/repos/service.ts";

export const ADMIN_API_VERSION = "v1";

export interface AdminApiRuntime {
  version: string;
  repoService: RepoService;
}

type JsonHeaders = Record<string, string>;

export function createAdminApiHandler(runtime: AdminApiRuntime) {
  return async function handleAdminApi(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return errorResponse(
        405,
        "method_not_allowed",
        `method ${request.method} is not allowed`,
        { Allow: "GET" },
      );
    }

    const url = new URL(request.url);
    const segments = pathSegments(url.pathname);
    if (segments === null) {
      return errorResponse(400, "bad_request", "path contains invalid encoding");
    }

    if (segments.length === 2 && segments[0] === "v1" && segments[1] === "meta") {
      return jsonResponse({
        service: "quay",
        api_version: ADMIN_API_VERSION,
        quay_version: runtime.version,
      });
    }

    if (segments.length === 2 && segments[0] === "v1" && segments[1] === "repos") {
      return jsonResponse(runtime.repoService.list({ activeOnly: true }));
    }

    if (
      segments.length === 3 &&
      segments[0] === "v1" &&
      segments[1] === "repos"
    ) {
      const repoId = segments[2];
      if (repoId === undefined) {
        return errorResponse(404, "not_found", `route not found: ${url.pathname}`);
      }
      const row = runtime.repoService.get(repoId);
      if (row === null || row.archived_at !== null) {
        return errorResponse(
          404,
          "repo_not_found",
          `repo "${repoId}" not found`,
        );
      }
      return jsonResponse(row);
    }

    return errorResponse(404, "not_found", `route not found: ${url.pathname}`);
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
