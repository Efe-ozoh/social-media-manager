/**
 * LinkedIn OAuth 2.0 (3-legged) — SPEC sections 7 and 12.
 *
 * Scopes: `openid profile w_member_social`.
 *   - `w_member_social` (Share on LinkedIn) is what lets us post as the member.
 *   - `openid profile` (Sign In with LinkedIn using OpenID Connect) is only
 *     there to learn which member the token belongs to: /v2/userinfo returns
 *     `sub`, which forms the author URN `urn:li:person:<sub>`. The old
 *     /v2/me + r_liteprofile route is restricted to approved developers.
 *   Nothing else is requested: LinkedIn asks for all scopes at once and the
 *   owner has to re-consent if the app's scopes change.
 *
 * Docs: https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow
 *       https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2
 *
 * LinkedIn issues ~60-day access tokens and, for self-service apps, no
 * refresh token — access to programmatic refresh tokens is limited to
 * approved Marketing Developer Platform partners. So a refresh token is
 * stored when the response happens to include one, and otherwise the UI has
 * to prompt a reconnect; nothing here assumes refreshes are possible.
 *
 * CSRF: a random `state` is kept in a short-lived httpOnly cookie and compared
 * on return. No token or code is ever logged.
 */

import { encryptToken, type TokenCryptoError } from "@/lib/crypto";
import { createOAuthState, statesMatch } from "./oauth-state";
import { redactSecrets } from "./types";

// The state helpers live in oauth-state.ts so every platform shares one
// implementation; they stay exported here for the routes and tests.
export { createOAuthState, statesMatch };

export const LINKEDIN_AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
export const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
export const LINKEDIN_USERINFO_URL = "https://api.linkedin.com/v2/userinfo";

export const LINKEDIN_STATE_COOKIE = "linkedin_oauth_state";
export const LINKEDIN_STATE_TTL_SECONDS = 10 * 60;
export const LINKEDIN_SCOPES = ["openid", "profile", "w_member_social"] as const;

/** Where LinkedIn sends the browser back, derived from APP_URL. */
export const LINKEDIN_CALLBACK_PATH = "/api/auth/linkedin/callback";

/** Access tokens are documented at ~60 days; used when expires_in is absent. */
const DEFAULT_TOKEN_LIFETIME_SECONDS = 60 * 24 * 60 * 60;

const REQUEST_TIMEOUT_MS = 15_000;

export type LinkedInOAuthErrorCode =
  | "not_configured"
  | "state_mismatch"
  | "denied"
  | "provider_error"
  | "invalid_response";

/** An OAuth failure whose message is safe to show and to log. */
export class LinkedInOAuthError extends Error {
  readonly code: LinkedInOAuthErrorCode;
  readonly status?: number;

  constructor(code: LinkedInOAuthErrorCode, message: string, status?: number) {
    super(message);
    this.name = "LinkedInOAuthError";
    this.code = code;
    this.status = status;
  }
}

export type LinkedInConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export type LinkedInConnection = {
  /** urn:li:person:<sub> — the author URN and social_accounts.external_id. */
  externalId: string;
  memberId: string;
  displayName: string;
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  expiresAt: Date;
};

type FetchImpl = typeof fetch;

/**
 * Reads and validates the LinkedIn app settings. Missing settings are a
 * configuration error, not a crash: the route turns this into a message.
 */
export function getLinkedInConfig(
  env: Record<string, string | undefined> = process.env,
): LinkedInConfig {
  const clientId = env.LINKEDIN_CLIENT_ID?.trim();
  const clientSecret = env.LINKEDIN_CLIENT_SECRET?.trim();
  const appUrl = env.APP_URL?.trim().replace(/\/+$/, "");

  const missing: string[] = [];
  if (!clientId) missing.push("LINKEDIN_CLIENT_ID");
  if (!clientSecret) missing.push("LINKEDIN_CLIENT_SECRET");
  if (!appUrl) missing.push("APP_URL");
  if (missing.length > 0) {
    throw new LinkedInOAuthError(
      "not_configured",
      `LinkedIn is not configured. Set ${missing.join(", ")} in .env.local.`,
    );
  }

  return {
    clientId: clientId as string,
    clientSecret: clientSecret as string,
    redirectUri: `${appUrl}${LINKEDIN_CALLBACK_PATH}`,
  };
}

/**
 * Builds the consent URL. Spaces in `scope` are encoded as %20 rather than
 * "+" because LinkedIn's examples use that form.
 */
export function buildAuthorizeUrl(options: {
  config: LinkedInConfig;
  state: string;
  scopes?: readonly string[];
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: options.config.clientId,
    redirect_uri: options.config.redirectUri,
    state: options.state,
    scope: (options.scopes ?? LINKEDIN_SCOPES).join(" "),
  });

  return `${LINKEDIN_AUTHORIZE_URL}?${params.toString().replace(/\+/g, "%20")}`;
}

/** Pulls a short, already-safe message out of a provider error body. */
function providerDetail(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;

  for (const key of ["error_description", "message", "error"]) {
    const value = record[key];
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
    // Never propagate a raw, possibly huge, non-JSON body.
    return null;
  }
}

function requestSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    : undefined;
}

type TokenResponse = {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  scope?: unknown;
};

/**
 * Exchanges the authorization code for an access token. Throws
 * LinkedInOAuthError (never a bare fetch error) so the callback route has one
 * error shape to handle.
 */
export async function exchangeAuthorizationCode(options: {
  code: string;
  config: LinkedInConfig;
  fetchImpl?: FetchImpl;
}): Promise<{ accessToken: string; refreshToken: string | null; expiresIn: number }> {
  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(LINKEDIN_TOKEN_URL, {
      method: "POST",
      // LinkedIn documents form encoding for the token endpoint, not JSON.
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: options.code,
        client_id: options.config.clientId,
        client_secret: options.config.clientSecret,
        redirect_uri: options.config.redirectUri,
      }),
      signal: requestSignal(),
    });
  } catch {
    throw new LinkedInOAuthError(
      "provider_error",
      "Could not reach LinkedIn to exchange the authorization code. Try connecting again.",
    );
  }

  const body = (await readBody(response)) as TokenResponse | null;

  if (!response.ok) {
    const detail = providerDetail(body);
    throw new LinkedInOAuthError(
      "provider_error",
      `LinkedIn rejected the authorization code (HTTP ${response.status})${detail ? `: ${detail}` : "."}`,
      response.status,
    );
  }

  const accessToken = typeof body?.access_token === "string" ? body.access_token : "";
  if (!accessToken) {
    throw new LinkedInOAuthError(
      "invalid_response",
      "LinkedIn did not return an access token.",
      response.status,
    );
  }

  const expiresIn =
    typeof body?.expires_in === "number" && Number.isFinite(body.expires_in) && body.expires_in > 0
      ? body.expires_in
      : DEFAULT_TOKEN_LIFETIME_SECONDS;

  const refreshToken =
    typeof body?.refresh_token === "string" && body.refresh_token !== "" ? body.refresh_token : null;

  return { accessToken, refreshToken, expiresIn };
}

/**
 * Reads the member behind a token: `sub` becomes the person URN, and the
 * display name is used for the accounts list.
 */
export async function fetchLinkedInMember(options: {
  accessToken: string;
  fetchImpl?: FetchImpl;
}): Promise<{ memberId: string; displayName: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(LINKEDIN_USERINFO_URL, {
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        Accept: "application/json",
      },
      signal: requestSignal(),
    });
  } catch {
    throw new LinkedInOAuthError(
      "provider_error",
      "Could not reach LinkedIn to read the member profile. Try connecting again.",
    );
  }

  const body = (await readBody(response)) as Record<string, unknown> | null;

  if (!response.ok) {
    const detail = providerDetail(body);
    throw new LinkedInOAuthError(
      "provider_error",
      `LinkedIn would not return the member profile (HTTP ${response.status})${detail ? `: ${detail}` : "."}`,
      response.status,
    );
  }

  const memberId = typeof body?.sub === "string" ? body.sub.trim() : "";
  if (!memberId) {
    throw new LinkedInOAuthError(
      "invalid_response",
      "LinkedIn did not return a member id (the OpenID Connect `profile` scope may be missing).",
      response.status,
    );
  }

  const nameCandidates = [body?.name, body?.given_name, body?.email];
  const displayName =
    nameCandidates.find((value): value is string => typeof value === "string" && value.trim() !== "")
      ?.trim() ?? "LinkedIn member";

  return { memberId, displayName };
}

/**
 * The whole callback in one place: validate `state`, exchange the code, read
 * the member, encrypt the token. The route only saves the result and sets
 * cookies, which keeps the security-relevant logic unit-testable.
 */
export async function completeLinkedInConnection(options: {
  code: string | null | undefined;
  state: string | null | undefined;
  cookieState: string | null | undefined;
  /** LinkedIn's ?error= parameter, e.g. access_denied. */
  providerError?: string | null;
  config: LinkedInConfig;
  fetchImpl?: FetchImpl;
  /** Encryption key; defaults to TOKEN_ENCRYPTION_KEY. */
  key?: Buffer;
  now?: Date;
}): Promise<LinkedInConnection> {
  // CSRF first: a forged callback must not even trigger a token exchange.
  if (!statesMatch(options.cookieState, options.state)) {
    throw new LinkedInOAuthError(
      "state_mismatch",
      "The LinkedIn sign-in was not started from this browser. Try connecting again.",
    );
  }

  if (options.providerError) {
    throw new LinkedInOAuthError(
      "denied",
      options.providerError === "access_denied"
        ? "LinkedIn access was cancelled. Nothing was connected."
        : `LinkedIn returned an error: ${redactSecrets(options.providerError)}`,
    );
  }

  const code = options.code?.trim();
  if (!code) {
    throw new LinkedInOAuthError(
      "provider_error",
      "LinkedIn did not return an authorization code. Try connecting again.",
    );
  }

  const token = await exchangeAuthorizationCode({
    code,
    config: options.config,
    fetchImpl: options.fetchImpl,
  });

  const member = await fetchLinkedInMember({
    accessToken: token.accessToken,
    fetchImpl: options.fetchImpl,
  });

  const now = options.now ?? new Date();
  let accessTokenEnc: string;
  let refreshTokenEnc: string | null;
  try {
    accessTokenEnc = encryptToken(token.accessToken, options.key);
    refreshTokenEnc = token.refreshToken ? encryptToken(token.refreshToken, options.key) : null;
  } catch (error) {
    // A missing or broken TOKEN_ENCRYPTION_KEY must not store a plaintext
    // token — fail instead, with the key error's safe message.
    const keyError = error as TokenCryptoError;
    throw new LinkedInOAuthError(
      "not_configured",
      keyError?.message ?? "The access token could not be encrypted.",
    );
  }

  return {
    externalId: `urn:li:person:${member.memberId}`,
    memberId: member.memberId,
    displayName: member.displayName,
    accessTokenEnc,
    refreshTokenEnc,
    expiresAt: new Date(now.getTime() + token.expiresIn * 1000),
  };
}
