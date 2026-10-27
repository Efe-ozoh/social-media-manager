import { NextResponse, type NextRequest } from "next/server";
import {
  buildAuthorizeUrl,
  createOAuthState,
  getLinkedInConfig,
  LINKEDIN_CALLBACK_PATH,
  LINKEDIN_STATE_COOKIE,
  LINKEDIN_STATE_TTL_SECONDS,
  LinkedInOAuthError,
  type LinkedInConfig,
} from "@/lib/publishers/linkedin-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function backToApp(request: NextRequest, reason: string) {
  const url = request.nextUrl.clone();
  url.pathname = "/";
  url.search = "";
  url.searchParams.set("linkedin", "error");
  url.searchParams.set("reason", reason);
  return NextResponse.redirect(url);
}

/**
 * GET /api/auth/linkedin/start
 *
 * Begins the OAuth flow. Login is enforced by proxy.ts (only the callback is
 * public), so the owner must be signed in to connect an account.
 *
 * The CSRF `state` goes into a short-lived httpOnly cookie scoped to the
 * callback path, and is compared there.
 */
export async function GET(request: NextRequest) {
  let config: LinkedInConfig;
  try {
    config = getLinkedInConfig();
  } catch (error) {
    const message =
      error instanceof LinkedInOAuthError ? error.message : "LinkedIn is not configured.";
    console.error(`[linkedin] ${message}`);
    return backToApp(request, "not_configured");
  }

  // Printed every time the flow starts, because this exact string has to be
  // registered on the LinkedIn app or LinkedIn refuses the redirect.
  console.log(
    "[linkedin] Redirect URL to register in the LinkedIn app (Auth → OAuth 2.0 " +
      `settings → Authorized redirect URLs): ${config.redirectUri}`,
  );

  const state = createOAuthState();
  const authorizeUrl = buildAuthorizeUrl({ config, state });

  const response = NextResponse.redirect(authorizeUrl);
  response.cookies.set({
    name: LINKEDIN_STATE_COOKIE,
    value: state,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: LINKEDIN_CALLBACK_PATH,
    maxAge: LINKEDIN_STATE_TTL_SECONDS,
  });

  return response;
}
