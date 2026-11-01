import { NextResponse, type NextRequest } from "next/server";
import {
  buildMetaAuthorizeUrl,
  createOAuthState,
  getMetaConfig,
  META_CALLBACK_PATH,
  META_STATE_COOKIE,
  META_STATE_TTL_SECONDS,
  MetaOAuthError,
  type MetaConfig,
} from "@/lib/publishers/meta-oauth";
import { isMetaEnabled } from "@/lib/platforms";

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
 * The CSRF `state` lives in a short-lived httpOnly cookie scoped to the
 * callback path and is compared there.
 *
 * Meta automated posting is switched off, so unless ENABLE_META is an explicit
 * yes this answers with reason=disabled and starts nothing. The code below is
 * kept for when the flag is turned back on; Facebook and Instagram are
 * manual-export platforms meanwhile (lib/platforms.ts).
 */
export async function GET(request: NextRequest) {
  if (!isMetaEnabled()) {
    console.warn("[meta] Connect disabled: set ENABLE_META=true to enable Meta posting again.");
    return backToApp(request, "disabled");
  }

  let config: MetaConfig;
  try {
    config = getMetaConfig();
  } catch (error) {
    const message =
      error instanceof MetaOAuthError ? error.message : "Meta is not configured.";
    console.error(`[meta] ${message}`);
    return backToApp(request, "not_configured");
  }

  // Printed every time the flow starts, because this exact string has to be
  // registered on the Meta app or Facebook refuses the redirect.
  console.log(
    "[meta] Redirect URL to register in the Meta app (Facebook Login → Settings → " +
      `Valid OAuth Redirect URIs): ${config.redirectUri}`,
  );

  const state = createOAuthState();
  const authorizeUrl = buildMetaAuthorizeUrl({ config, state });

  const response = NextResponse.redirect(authorizeUrl);
  response.cookies.set({
    name: META_STATE_COOKIE,
    value: state,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: META_CALLBACK_PATH,
    maxAge: META_STATE_TTL_SECONDS,
  });

  return response;
}
