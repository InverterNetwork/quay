import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import type { QuayConfig } from "../cli/config.ts";

export const DEFAULT_ADMIN_TOKEN_ENV = "QUAY_ADMIN_TOKEN";
export const DEFAULT_ADMIN_FORWARDED_IDENTITY_HEADER = "X-Hermes-User-Id";

const BEARER_REALM = "quay-admin";
const SECRET_BEARING_FORWARD_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
  "x-xsrf-token",
]);

export interface AdminAuthRuntime {
  config?: QuayConfig;
  env?: NodeJS.ProcessEnv;
}

export interface ResolvedAdminAuth {
  enabled: boolean;
  tokenEnv: string;
  forwardedIdentityHeader: string;
  token?: string;
  startupFailure?: AdminAuthFailure;
}

export interface AdminAuthFailure {
  status: number;
  code: string;
  message: string;
  headers: Record<string, string>;
}

export interface AdminRequestAuditContext {
  slack_user_id: string | null;
  identity_status: "forwarded" | "missing" | "standalone";
  forwarded_identity: string | null;
  forwarded_identity_header: string;
}

export function resolveAdminAuth(runtime: AdminAuthRuntime): ResolvedAdminAuth {
  const config = runtime.config ?? {};
  const env = runtime.env ?? process.env;
  const adminConfig = config.admin;
  const tokenEnv = adminConfig?.token_env ?? DEFAULT_ADMIN_TOKEN_ENV;
  const token = env[tokenEnv] ?? "";
  const requireAuth = adminConfig?.require_auth ?? token !== "";
  const forwardedIdentityHeader = adminConfig?.forwarded_identity_header ??
    DEFAULT_ADMIN_FORWARDED_IDENTITY_HEADER;

  if (!requireAuth) {
    return { enabled: false, tokenEnv, forwardedIdentityHeader };
  }
  if (isSecretBearingForwardedIdentityHeader(forwardedIdentityHeader)) {
    return {
      enabled: true,
      tokenEnv,
      forwardedIdentityHeader,
      startupFailure: {
        status: 500,
        code: "admin_forwarded_identity_header_secret_bearing",
        message:
          `[admin].forwarded_identity_header must not be a secret-bearing header: ${forwardedIdentityHeader}`,
        headers: {},
      },
    };
  }
  if (token === "") {
    return {
      enabled: true,
      tokenEnv,
      forwardedIdentityHeader,
      startupFailure: {
        status: 500,
        code: "admin_auth_not_configured",
        message: `Admin auth is enabled but ${tokenEnv} is not set`,
        headers: {},
      },
    };
  }
  return { enabled: true, tokenEnv, forwardedIdentityHeader, token };
}

export function isSecretBearingForwardedIdentityHeader(name: string): boolean {
  return SECRET_BEARING_FORWARD_HEADER_NAMES.has(name.toLowerCase());
}

export function assertAdminAuthReady(runtime: AdminAuthRuntime): void {
  const auth = resolveAdminAuth(runtime);
  if (auth.startupFailure !== undefined) {
    throw new Error(auth.startupFailure.message);
  }
}

export function authorizeAdminRequest(
  runtime: AdminAuthRuntime,
  request: Request,
):
  | {
    ok: true;
    auth: ResolvedAdminAuth;
    audit: AdminRequestAuditContext;
  }
  | { ok: false; failure: AdminAuthFailure } {
  const auth = resolveAdminAuth(runtime);
  if (auth.startupFailure !== undefined) {
    return { ok: false, failure: auth.startupFailure };
  }
  if (!auth.enabled) {
    return { ok: true, auth, audit: adminRequestAuditContext(request, auth) };
  }

  const provided = bearerTokenFromAuthorization(
    request.headers.get("authorization"),
  );
  if (provided === null) {
    return {
      ok: false,
      failure: bearerFailure(
        "admin_auth_required",
        "Admin API requires Authorization: Bearer <token>",
      ),
    };
  }
  if (auth.token === undefined || !constantTimeEquals(provided, auth.token)) {
    return {
      ok: false,
      failure: bearerFailure("admin_auth_invalid", "invalid admin bearer token"),
    };
  }

  return { ok: true, auth, audit: adminRequestAuditContext(request, auth) };
}

export function adminAuthAllowedHeaders(runtime: AdminAuthRuntime): string {
  const auth = resolveAdminAuth(runtime);
  const headers = [
    "Accept",
    "Authorization",
    "Content-Type",
    auth.forwardedIdentityHeader,
  ];
  return [...new Map(headers.map((header) => [header.toLowerCase(), header])).values()]
    .join(", ");
}

export function adminAuthErrorResponse(
  failure: AdminAuthFailure,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({ error: failure.code, message: failure.message }),
    {
      status: failure.status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        ...extraHeaders,
        ...failure.headers,
      },
    },
  );
}

function adminRequestAuditContext(
  request: Request,
  auth: ResolvedAdminAuth,
): AdminRequestAuditContext {
  if (!auth.enabled) {
    return {
      slack_user_id: null,
      identity_status: "standalone",
      forwarded_identity: null,
      forwarded_identity_header: auth.forwardedIdentityHeader,
    };
  }
  const rawIdentity = request.headers.get(auth.forwardedIdentityHeader);
  const forwardedIdentity = rawIdentity === null || rawIdentity.trim() === ""
    ? null
    : rawIdentity.trim();
  return {
    slack_user_id: forwardedIdentity,
    identity_status: forwardedIdentity === null ? "missing" : "forwarded",
    forwarded_identity: forwardedIdentity,
    forwarded_identity_header: auth.forwardedIdentityHeader,
  };
}

function bearerTokenFromAuthorization(header: string | null): string | null {
  if (header === null || header.trim() === "") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match === null) return null;
  return match[1] ?? null;
}

function bearerFailure(code: string, message: string): AdminAuthFailure {
  return {
    status: 401,
    code,
    message,
    headers: {
      "WWW-Authenticate": `Bearer realm="${BEARER_REALM}"`,
    },
  };
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(left, right);
}
