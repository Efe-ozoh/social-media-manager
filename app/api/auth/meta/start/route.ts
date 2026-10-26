import { NextResponse, type NextRequest } from "next/server";
import {
  buildMetaAuthorizeUrl,
  createOAuthState,
  getMetaConfig,
  META_STATE_COOKIE,
  META_STATE_TTL_SECONDS,
  MetaOAuthError,
  type MetaConfig,
} from "@/lib/publishers/meta-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function backToApp(request: NextRequest, reason: string) {
  const url = request.nextUrl.clone();
  url.pathname = "/";
  url.search = "";
  url.searchParams.set("meta", "error");
  url.searchParams.set("reason", reason);
  return NextResponse.redirect(url);
}

/**
 * GET /api/auth/meta/start
 *
 * Begins the Meta connect flow, which covers both the Facebook Page and the
 * Instagram account linked to it. Login is enforced by proxy.ts (only the
 * callback is public), so the owner must be signed in.
 *
 * The CSRF `state` lives in a short-lived httpOnly cookie scoped to this
 * route tree and is compared on the callback.
 */
export async function GET(request: NextRequest) {
  let config: MetaConfig;
  try {
    config = getMetaConfig();
  } catch (error) {
    const message =
      error instanceof MetaOAuthError ? error.message : "Meta is not configured.";
    console.error(`[meta] ${message}`);
    return backToApp(request, "not_configured");
  }

  const state = createOAuthState();
  const authorizeUrl = buildMetaAuthorizeUrl({ config, state });

  const response = NextResponse.redirect(authorizeUrl);
  response.cookies.set({
    name: META_STATE_COOKIE,
    value: state,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/auth/meta",
    maxAge: META_STATE_TTL_SECONDS,
  });

  return response;
}
