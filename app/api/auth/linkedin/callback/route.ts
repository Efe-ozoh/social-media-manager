import { NextResponse, type NextRequest } from "next/server";
import { getPrisma } from "@/lib/prisma";
import {
  completeLinkedInConnection,
  getLinkedInConfig,
  LINKEDIN_STATE_COOKIE,
  LinkedInOAuthError,
  type LinkedInConnection,
} from "@/lib/publishers/linkedin-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/linkedin/callback
 *
 * Public by design (SPEC section 12): the browser arrives from LinkedIn, and
 * the state cookie — not a session — is what proves the flow started here.
 * The session cookie is SameSite=Lax, so it rides along on this top-level
 * navigation when the owner is still signed in.
 *
 * Nothing here logs a code or a token: failures are reported as short reason
 * codes on the redirect, and the OAuth error messages are built to be safe.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  const finish = (status: "connected" | "error", reason?: string) => {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    url.searchParams.set("linkedin", status);
    if (reason) url.searchParams.set("reason", reason);

    const response = NextResponse.redirect(url);
    // One-shot cookie: clear it whatever the outcome.
    response.cookies.set({
      name: LINKEDIN_STATE_COOKIE,
      value: "",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/api/auth/linkedin",
      maxAge: 0,
    });
    return response;
  };

  let config;
  try {
    config = getLinkedInConfig();
  } catch {
    return finish("error", "not_configured");
  }

  let connection: LinkedInConnection;
  try {
    connection = await completeLinkedInConnection({
      code: params.get("code"),
      state: params.get("state"),
      cookieState: request.cookies.get(LINKEDIN_STATE_COOKIE)?.value,
      providerError: params.get("error"),
      config,
    });
  } catch (error) {
    const reason = error instanceof LinkedInOAuthError ? error.code : "provider_error";
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[linkedin] connect failed (${reason}): ${message}`);
    return finish("error", reason);
  }

  try {
    // Reconnecting the same member replaces the stored token in place.
    await getPrisma().socialAccount.upsert({
      where: {
        platform_externalId: { platform: "linkedin", externalId: connection.externalId },
      },
      create: {
        platform: "linkedin",
        externalId: connection.externalId,
        displayName: connection.displayName,
        accessTokenEnc: connection.accessTokenEnc,
        refreshTokenEnc: connection.refreshTokenEnc,
        expiresAt: connection.expiresAt,
      },
      update: {
        displayName: connection.displayName,
        accessTokenEnc: connection.accessTokenEnc,
        refreshTokenEnc: connection.refreshTokenEnc,
        expiresAt: connection.expiresAt,
      },
    });
  } catch (error) {
    // Only the error class: a Prisma message can include the datasource URL.
    const name = error instanceof Error ? error.name : "Error";
    console.error(`[linkedin] could not save the connected account (${name})`);
    return finish("error", "save_failed");
  }

  return finish("connected");
}
