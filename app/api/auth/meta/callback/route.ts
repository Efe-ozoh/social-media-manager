import { NextResponse, type NextRequest } from "next/server";
import { getPrisma } from "@/lib/prisma";
import {
  completeMetaConnection,
  getMetaConfig,
  META_STATE_COOKIE,
  MetaOAuthError,
  type MetaConnection,
} from "@/lib/publishers/meta-oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/meta/callback
 *
 * Public by design (SPEC section 12): the browser arrives from Facebook, and
 * the state cookie — not a session — is what proves the flow started here.
 *
 * One consent screen yields every Page the owner administers plus each Page's
 * linked Instagram account, so this writes several social_accounts rows in one
 * transaction: either the whole connection lands or none of it does. Rows are
 * keyed by (platform, external_id), so reconnecting updates them in place.
 *
 * No code, token or app secret is ever logged.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  const finish = (status: "connected" | "error", reason?: string) => {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    url.searchParams.set("meta", status);
    if (reason) url.searchParams.set("reason", reason);

    const response = NextResponse.redirect(url);
    // One-shot cookie: clear it whatever the outcome.
    response.cookies.set({
      name: META_STATE_COOKIE,
      value: "",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/api/auth/meta",
      maxAge: 0,
    });
    return response;
  };

  let config;
  try {
    config = getMetaConfig();
  } catch {
    return finish("error", "not_configured");
  }

  let connection: MetaConnection;
  try {
    connection = await completeMetaConnection({
      code: params.get("code"),
      state: params.get("state"),
      cookieState: request.cookies.get(META_STATE_COOKIE)?.value,
      providerError: params.get("error"),
      providerErrorDescription: params.get("error_description"),
      config,
    });
  } catch (error) {
    const reason = error instanceof MetaOAuthError ? error.code : "provider_error";
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[meta] connect failed (${reason}): ${message}`);
    return finish("error", reason);
  }

  for (const note of connection.notes) console.warn(`[meta] ${note}`);

  try {
    const prisma = getPrisma();
    await prisma.$transaction(
      connection.accounts.map((account) =>
        prisma.socialAccount.upsert({
          where: {
            platform_externalId: {
              platform: account.platform,
              externalId: account.externalId,
            },
          },
          create: {
            platform: account.platform,
            externalId: account.externalId,
            displayName: account.displayName,
            accessTokenEnc: account.accessTokenEnc,
            refreshTokenEnc: null,
            expiresAt: account.expiresAt,
          },
          update: {
            displayName: account.displayName,
            accessTokenEnc: account.accessTokenEnc,
            refreshTokenEnc: null,
            expiresAt: account.expiresAt,
          },
        }),
      ),
    );
  } catch (error) {
    // Only the error class: a Prisma message can include the datasource URL.
    const name = error instanceof Error ? error.name : "Error";
    console.error(`[meta] could not save the connected accounts (${name})`);
    return finish("error", "save_failed");
  }

  console.log(`[meta] connected ${connection.accounts.length} account(s)`);
  return finish("connected");
}
