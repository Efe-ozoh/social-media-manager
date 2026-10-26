/**
 * Meta OAuth for Facebook Pages and the linked Instagram account —
 * SPEC sections 7 and 12.
 *
 * API flavour: Instagram API with Facebook Login (graph.facebook.com), the
 * Page-linked setup, rather than Instagram API with Instagram Login
 * (instagram.com + graph.instagram.com) or the newer Unified Login.
 *
 * Why: the spec ties the Instagram account to the Facebook Page and says one
 * Meta app covers both platforms. Facebook Login gives both from a single
 * consent screen — the same long-lived user token lists the Pages, returns
 * each Page's own access token, and identifies the Instagram professional
 * account linked to each Page — so there is one connect flow, one credential
 * pair (META_APP_ID / META_APP_SECRET) and one token model. Instagram Login
 * would mean a second consent flow, a second app credential and a second
 * token family for no gain here.
 *   https://developers.facebook.com/documentation/instagram-platform/overview
 * Meta now recommends Unified Login for new integrations; that needs a
 * business portfolio and a system-user token, which is out of scope for a
 * single-owner v1.
 *
 * Permissions requested, and nothing else:
 *   - pages_show_list        list the Pages the owner administers
 *   - pages_read_engagement  read Page content and the Page's IG link
 *   - pages_manage_posts     publish to the Page
 *   - instagram_basic        read the linked Instagram account
 *   - instagram_content_publish  publish to Instagram
 *   https://developers.facebook.com/documentation/instagram-platform/content-publishing
 * A single-owner app in Development mode works with Standard Access and needs
 * no App Review:
 *   https://developers.facebook.com/docs/graph-api/overview/access-levels/
 *
 * Token lifetimes: a long-lived user token lasts about 60 days; a Page access
 * token derived from one is documented as having "no expiration date", though
 * it can still be invalidated. So the Facebook row stores the Page token with
 * no expiry, and the Instagram row stores the long-lived user token with its
 * real expiry (the Instagram media and media_publish references list a user
 * token for the Facebook Login flavour, while the publishing requirements
 * table says Page token — the per-endpoint reference is the specific one, so
 * that is what is implemented).
 *   https://developers.facebook.com/documentation/facebook-login/guides/access-tokens/get-long-lived
 *   https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media
 *
 * CSRF: a random `state` in a short-lived httpOnly cookie, compared in
 * constant time on return before any code is exchanged. No token, code or
 * app secret is ever logged.
 */

import { encryptToken, type TokenCryptoError } from "@/lib/crypto";
import { appSecretProof, graphUrl, META_GRAPH_VERSION } from "./meta-graph";
import { createOAuthState, statesMatch } from "./oauth-state";
import { redactSecrets } from "./types";

export { createOAuthState, statesMatch };

export const META_AUTHORIZE_URL = `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`;
export const META_TOKEN_URL = graphUrl("/oauth/access_token");
export const META_ACCOUNTS_URL = graphUrl("/me/accounts");

export const META_STATE_COOKIE = "meta_oauth_state";
export const META_STATE_TTL_SECONDS = 10 * 60;
export const META_CALLBACK_PATH = "/api/auth/meta/callback";

/** Exactly the permissions the two publishers need; see the note above. */
export const META_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
] as const;

/** Fields requested when listing Pages, including the IG link. */
export const META_PAGE_FIELDS = "id,name,access_token,instagram_business_account";

const REQUEST_TIMEOUT_MS = 15_000;

export type MetaOAuthErrorCode =
  | "not_configured"
  | "state_mismatch"
  | "denied"
  | "provider_error"
  | "invalid_response"
  | "no_pages";

/** An OAuth failure whose message is safe to show the owner and to log. */
export class MetaOAuthError extends Error {
  readonly code: MetaOAuthErrorCode;
  readonly status?: number;

  constructor(code: MetaOAuthErrorCode, message: string, status?: number) {
    super(message);
    this.name = "MetaOAuthError";
    this.code = code;
    this.status = status;
  }
}

export type MetaConfig = {
  appId: string;
  appSecret: string;
  redirectUri: string;
};

/** One row to write into social_accounts. */
export type MetaConnectedAccount = {
  platform: "facebook" | "instagram";
  externalId: string;
  displayName: string;
  accessTokenEnc: string;
  expiresAt: Date | null;
};

export type MetaConnection = {
  accounts: MetaConnectedAccount[];
  /** Non-fatal remarks, e.g. a Page whose Instagram link could not be read. */
  notes: string[];
};

export type MetaPage = {
  id: string;
  name: string;
  accessToken: string;
  instagramId: string | null;
};

type FetchImpl = typeof fetch;

/**
 * Reads and validates the Meta app settings. Missing settings are a
 * configuration error the route turns into a message, not a crash.
 */
export function getMetaConfig(
  env: Record<string, string | undefined> = process.env,
): MetaConfig {
  const appId = env.META_APP_ID?.trim();
  const appSecret = env.META_APP_SECRET?.trim();
  const appUrl = env.APP_URL?.trim().replace(/\/+$/, "");

  const missing: string[] = [];
  if (!appId) missing.push("META_APP_ID");
  if (!appSecret) missing.push("META_APP_SECRET");
  if (!appUrl) missing.push("APP_URL");
  if (missing.length > 0) {
    throw new MetaOAuthError(
      "not_configured",
      `Meta is not configured. Set ${missing.join(", ")} in .env.local.`,
    );
  }

  return {
    appId: appId as string,
    appSecret: appSecret as string,
    redirectUri: `${appUrl}${META_CALLBACK_PATH}`,
  };
}

/** Builds the consent URL. Meta takes the scopes comma-separated. */
export function buildMetaAuthorizeUrl(options: {
  config: MetaConfig;
  state: string;
  scopes?: readonly string[];
}): string {
  const params = new URLSearchParams({
    client_id: options.config.appId,
    redirect_uri: options.config.redirectUri,
    state: options.state,
    response_type: "code",
    scope: (options.scopes ?? META_SCOPES).join(","),
  });

  return `${META_AUTHORIZE_URL}?${params.toString()}`;
}

/** A short, already-safe message from a Meta error body. */
function providerDetail(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const error = record.error;
  const payload =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : record;

  for (const key of ["error_user_msg", "message", "error_description", "error"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim() !== "") {
      return redactSecrets(value.trim());
    }
  }
  return undefined;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function sendJson(
  url: string,
  fetchImpl: FetchImpl,
  label: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new MetaOAuthError(
      "provider_error",
      `Could not reach Meta to ${label}. Try connecting again.`,
    );
  }

  const body = await readBody(response);
  if (!response.ok) {
    const detail = providerDetail(body);
    throw new MetaOAuthError(
      "provider_error",
      `Meta could not ${label} (HTTP ${response.status})${detail ? `: ${detail}` : "."}`,
      response.status,
    );
  }
  return body;
}

/**
 * Exchanges the authorization code for a short-lived user token. Meta's
 * token endpoint takes query parameters, not a form body.
 */
export async function exchangeMetaAuthorizationCode(options: {
  code: string;
  config: MetaConfig;
  fetchImpl?: FetchImpl;
}): Promise<{ accessToken: string; expiresIn: number }> {
  const url = new URL(META_TOKEN_URL);
  url.searchParams.set("client_id", options.config.appId);
  url.searchParams.set("redirect_uri", options.config.redirectUri);
  url.searchParams.set("client_secret", options.config.appSecret);
  url.searchParams.set("code", options.code);

  const body = (await sendJson(
    url.toString(),
    options.fetchImpl ?? fetch,
    "exchange the authorization code",
  )) as { access_token?: unknown; expires_in?: unknown } | null;

  const accessToken = typeof body?.access_token === "string" ? body.access_token : "";
  if (!accessToken) {
    throw new MetaOAuthError("invalid_response", "Meta did not return an access token.");
  }

  const expiresIn =
    typeof body?.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3_600;

  return { accessToken, expiresIn };
}

/** Swaps the short-lived user token for a long-lived one (~60 days). */
export async function exchangeForLongLivedToken(options: {
  shortLivedToken: string;
  config: MetaConfig;
  fetchImpl?: FetchImpl;
}): Promise<{ accessToken: string; expiresIn: number }> {
  const url = new URL(META_TOKEN_URL);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", options.config.appId);
  url.searchParams.set("client_secret", options.config.appSecret);
  url.searchParams.set("fb_exchange_token", options.shortLivedToken);

  const body = (await sendJson(
    url.toString(),
    options.fetchImpl ?? fetch,
    "extend the access token",
  )) as { access_token?: unknown; expires_in?: unknown } | null;

  const accessToken = typeof body?.access_token === "string" ? body.access_token : "";
  if (!accessToken) {
    throw new MetaOAuthError(
      "invalid_response",
      "Meta did not return a long-lived access token.",
    );
  }

  // Documented as "about 60 days" when expires_in is absent.
  const expiresIn =
    typeof body?.expires_in === "number" && body.expires_in > 0
      ? body.expires_in
      : 60 * 24 * 60 * 60;

  return { accessToken, expiresIn };
}

/**
 * Lists the Pages the user administers, with each Page's own access token and
 * the link to its Instagram professional account.
 *
 * One request with limit=100 is used instead of following pagination: this is
 * a single-owner app, and a hundred Pages is not a realistic case.
 */
export async function fetchManagedPages(options: {
  userToken: string;
  config: MetaConfig;
  fetchImpl?: FetchImpl;
}): Promise<MetaPage[]> {
  const url = new URL(META_ACCOUNTS_URL);
  url.searchParams.set("fields", META_PAGE_FIELDS);
  url.searchParams.set("limit", "100");
  url.searchParams.set("access_token", options.userToken);
  url.searchParams.set(
    "appsecret_proof",
    appSecretProof(options.userToken, options.config.appSecret),
  );

  const body = (await sendJson(
    url.toString(),
    options.fetchImpl ?? fetch,
    "list your Pages",
  )) as { data?: unknown } | null;

  if (!Array.isArray(body?.data)) {
    throw new MetaOAuthError(
      "invalid_response",
      "Meta returned no Page list. Grant the pages_show_list permission and try again.",
    );
  }

  const pages: MetaPage[] = [];
  for (const entry of body.data) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;

    const id = typeof record.id === "string" ? record.id.trim() : "";
    const accessToken = typeof record.access_token === "string" ? record.access_token : "";
    if (!id || !accessToken) continue;

    const instagram = record.instagram_business_account;
    const instagramId =
      typeof instagram === "object" && instagram !== null
        ? (() => {
            const value = (instagram as Record<string, unknown>).id;
            return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
          })()
        : null;

    pages.push({
      id,
      name: typeof record.name === "string" && record.name.trim() !== "" ? record.name.trim() : id,
      accessToken,
      instagramId,
    });
  }

  return pages;
}

/** Reads the username of a linked Instagram professional account. */
export async function fetchInstagramAccount(options: {
  instagramId: string;
  userToken: string;
  config: MetaConfig;
  fetchImpl?: FetchImpl;
}): Promise<{ id: string; username: string | null }> {
  const url = new URL(graphUrl(`/${options.instagramId}`));
  url.searchParams.set("fields", "id,username");
  url.searchParams.set("access_token", options.userToken);
  url.searchParams.set(
    "appsecret_proof",
    appSecretProof(options.userToken, options.config.appSecret),
  );

  const body = (await sendJson(
    url.toString(),
    options.fetchImpl ?? fetch,
    "read the linked Instagram account",
  )) as { id?: unknown; username?: unknown } | null;

  const id = typeof body?.id === "string" && body.id.trim() !== "" ? body.id.trim() : options.instagramId;
  const username =
    typeof body?.username === "string" && body.username.trim() !== "" ? body.username.trim() : null;

  return { id, username };
}

/**
 * The whole callback in one place: check `state`, exchange the code, extend
 * the token, discover Pages and their Instagram accounts, and encrypt
 * everything. The route only saves the result, which keeps the
 * security-relevant logic unit-testable.
 */
export async function completeMetaConnection(options: {
  code: string | null | undefined;
  state: string | null | undefined;
  cookieState: string | null | undefined;
  /** Meta's ?error= parameter, e.g. access_denied. */
  providerError?: string | null;
  providerErrorDescription?: string | null;
  config: MetaConfig;
  fetchImpl?: FetchImpl;
  /** Encryption key; defaults to TOKEN_ENCRYPTION_KEY. */
  key?: Buffer;
  now?: Date;
}): Promise<MetaConnection> {
  // CSRF first: a forged callback must not trigger a token exchange.
  if (!statesMatch(options.cookieState, options.state)) {
    throw new MetaOAuthError(
      "state_mismatch",
      "The Meta sign-in was not started from this browser. Try connecting again.",
    );
  }

  if (options.providerError) {
    const description = options.providerErrorDescription?.trim();
    throw new MetaOAuthError(
      "denied",
      options.providerError === "access_denied"
        ? "Meta access was cancelled. Nothing was connected."
        : `Meta returned an error: ${redactSecrets(description || options.providerError)}`,
    );
  }

  const code = options.code?.trim();
  if (!code) {
    throw new MetaOAuthError(
      "provider_error",
      "Meta did not return an authorization code. Try connecting again.",
    );
  }

  const shortLived = await exchangeMetaAuthorizationCode({
    code,
    config: options.config,
    fetchImpl: options.fetchImpl,
  });

  const longLived = await exchangeForLongLivedToken({
    shortLivedToken: shortLived.accessToken,
    config: options.config,
    fetchImpl: options.fetchImpl,
  });

  const pages = await fetchManagedPages({
    userToken: longLived.accessToken,
    config: options.config,
    fetchImpl: options.fetchImpl,
  });

  if (pages.length === 0) {
    throw new MetaOAuthError(
      "no_pages",
      "No Facebook Page was found for this account. You must be an admin of a Page, and the pages_show_list permission must be granted.",
    );
  }

  const now = options.now ?? new Date();
  const notes: string[] = [];
  const accounts: MetaConnectedAccount[] = [];

  let userTokenEnc: string;
  try {
    userTokenEnc = encryptToken(longLived.accessToken, options.key);
  } catch (error) {
    // A missing or broken TOKEN_ENCRYPTION_KEY must not store a plaintext
    // token: fail instead, with the key error's safe message.
    const keyError = error as TokenCryptoError;
    throw new MetaOAuthError(
      "not_configured",
      keyError?.message ?? "The access token could not be encrypted.",
    );
  }

  const userTokenExpiresAt = new Date(now.getTime() + longLived.expiresIn * 1000);

  for (const page of pages) {
    let pageTokenEnc: string;
    try {
      pageTokenEnc = encryptToken(page.accessToken, options.key);
    } catch (error) {
      const keyError = error as TokenCryptoError;
      throw new MetaOAuthError(
        "not_configured",
        keyError?.message ?? "The Page access token could not be encrypted.",
      );
    }

    accounts.push({
      platform: "facebook",
      externalId: page.id,
      displayName: page.name,
      accessTokenEnc: pageTokenEnc,
      // Documented as having no expiration date; it can still be revoked.
      expiresAt: null,
    });

    if (!page.instagramId) {
      notes.push(`Page "${page.name}" has no linked Instagram professional account.`);
      continue;
    }

    let displayName = `Instagram ${page.instagramId}`;
    try {
      const instagram = await fetchInstagramAccount({
        instagramId: page.instagramId,
        userToken: longLived.accessToken,
        config: options.config,
        fetchImpl: options.fetchImpl,
      });
      if (instagram.username) displayName = `@${instagram.username}`;
    } catch (error) {
      // The IG id is enough to publish with; a missing username is cosmetic.
      const message = error instanceof MetaOAuthError ? error.message : "unknown error";
      notes.push(`Could not read the Instagram username for page "${page.name}": ${message}`);
    }

    accounts.push({
      platform: "instagram",
      externalId: page.instagramId,
      displayName,
      // The Instagram media endpoints take the user token for this flavour.
      accessTokenEnc: userTokenEnc,
      expiresAt: userTokenExpiresAt,
    });
  }

  return { accounts, notes };
}
