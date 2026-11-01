import { NextResponse, type NextRequest } from "next/server";
import { getPrisma } from "@/lib/prisma";
import {
  completeMetaConnection,
  getMetaConfig,
  META_CALLBACK_PATH,
  META_STATE_COOKIE,
  MetaOAuthError,
  type MetaConnection,
} from "@/lib/publishers/meta-oauth";
import { isMetaEnabled } from "@/lib/platforms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/auth/meta/callback
 *
 * Public by design (SPEC section 12): the browser arrives from Facebook, and
 * the state cookie — not a session — is what proves the flow started here.
 *
 * One consent screen is enough to reach the Page and the Instagram account
 * linked to it. The Page that has a linked Instagram account is chosen (the
 * first, when several qualify), so this writes exactly two social_accounts
 * rows in one transaction: either both land or neither does. Rows are keyed by
 * (platform, external_id), so reconnecting updates them in place.
 *
 * On success the redirect records which Page was chosen (`page`, `page_id`).
 * Every failure lands on a short reason code from MetaOAuthErrorCode.
 *
 * No code, token or app secret is ever logged.
 *
 * Meta posting is switched off unless ENABLE_META is an explicit yes, so a
 * callback that arrives while it is off stores nothing and says so.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  const finish = (
    status: "connected" | "error",
    reason?: string,
    extra?: Record<string, string>,
  ) => {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    url.searchParams.set("meta", status);
    if (reason) url.searchParams.set("reason", reason);
    for (const [key, value] of Object.entries(extra ?? {})) {
      url.searchParams.set(key, value);
    }

    const response = NextResponse.redirect(url);
    // One-shot cookie: clear it whatever the outcome.
    response.cookies.set({
      name: META_STATE_COOKIE,
      value: "",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: META_CALLBACK_PATH,
      maxAge: 0,
    });
    return response;
  };

  // Before anything else, and before the state check: a disabled install must
  // never write a social_accounts row, whatever arrives here.
  if (!isMetaEnabled()) {
    console.warn("[meta] Callback ignored: set ENABLE_META=true to enable Meta posting again.");
    return finish("error", "disabled");
  }

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

  console.log(
    `[meta] connected Page "${connection.page.name}" (${connection.page.id}) and Instagram ${connection.instagram.displayName}`,
  );
  return finish("connected", undefined, {
    page: connection.page.name,
    page_id: connection.page.id,
  });
}
