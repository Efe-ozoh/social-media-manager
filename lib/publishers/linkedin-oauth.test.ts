import { describe, expect, it } from "vitest";
import { decryptToken } from "@/lib/crypto";
import {
  buildAuthorizeUrl,
  completeLinkedInConnection,
  createOAuthState,
  exchangeAuthorizationCode,
  fetchLinkedInMember,
  getLinkedInConfig,
  LINKEDIN_AUTHORIZE_URL,
  LINKEDIN_SCOPES,
  LINKEDIN_TOKEN_URL,
  LINKEDIN_USERINFO_URL,
  LinkedInOAuthError,
  statesMatch,
  type LinkedInConfig,
} from "./linkedin-oauth";

const KEY = Buffer.alloc(32, 3);
const TOKEN = "AQV-member-access-token-0987654321abcd";
const REFRESH = "AQV-refresh-token-1234567890abcdef";
const STATE = "s".repeat(43);

const config: LinkedInConfig = {
  clientId: "client-123",
  clientSecret: "secret-456",
  redirectUri: "https://app.example/api/auth/linkedin/callback",
};

type Call = { url: string; init: RequestInit; body: string | null };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(
  route: (call: Call) => Response | Promise<Response> | undefined,
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];

  const fetchImpl = (async (resource: RequestInfo | URL, init: RequestInit = {}) => {
    const url =
      typeof resource === "string"
        ? resource
        : resource instanceof URL
          ? resource.toString()
          : resource.url;
    const call: Call = {
      url,
      init,
      // Form-encoded token requests pass URLSearchParams, as the real fetch does.
      body:
        typeof init.body === "string"
          ? init.body
          : init.body instanceof URLSearchParams
            ? init.body.toString()
            : null,
    };
    calls.push(call);

    const response = await route(call);
    if (!response) throw new Error(`unexpected request: ${init.method ?? "GET"} ${url}`);
    return response;
  }) as typeof fetch;

  return { fetchImpl, calls };
}

/** A LinkedIn that exchanges the code and returns a member. */
function happyRoute(
  tokenBody: Record<string, unknown> = {
    access_token: TOKEN,
    expires_in: 5_184_000,
    scope: "openid profile w_member_social",
  },
  memberBody: Record<string, unknown> = {
    sub: "member-42",
    name: "Ada Lovelace",
    given_name: "Ada",
  },
): (call: Call) => Response | undefined {
  return (call) => {
    if (call.url === LINKEDIN_TOKEN_URL) return json(tokenBody);
    if (call.url === LINKEDIN_USERINFO_URL) return json(memberBody);
    return undefined;
  };
}

async function oauthError(promise: Promise<unknown>): Promise<LinkedInOAuthError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LinkedInOAuthError);
    return error as LinkedInOAuthError;
  }
  throw new Error("expected the flow to fail");
}

describe("getLinkedInConfig", () => {
  it("builds the callback URL from APP_URL", () => {
    const result = getLinkedInConfig({
      LINKEDIN_CLIENT_ID: " client-123 ",
      LINKEDIN_CLIENT_SECRET: "secret-456",
      APP_URL: "https://app.example/",
    });

    expect(result).toEqual(config);
  });

  it("names every missing variable", async () => {
    const error = await oauthError(
      (async () => getLinkedInConfig({ APP_URL: "" }))(),
    );

    expect(error.code).toBe("not_configured");
    expect(error.message).toContain("LINKEDIN_CLIENT_ID");
    expect(error.message).toContain("LINKEDIN_CLIENT_SECRET");
    expect(error.message).toContain("APP_URL");
  });
});

describe("createOAuthState / statesMatch", () => {
  it("creates unique 256-bit base64url states", () => {
    const first = createOAuthState();
    const second = createOAuthState();

    expect(first).toHaveLength(43);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(second).not.toBe(first);
  });

  it("matches only identical, non-empty states", () => {
    expect(statesMatch(STATE, STATE)).toBe(true);
    expect(statesMatch(STATE, `${STATE}x`)).toBe(false);
    expect(statesMatch(STATE, "t".repeat(43))).toBe(false);
    expect(statesMatch(STATE, null)).toBe(false);
    expect(statesMatch(undefined, STATE)).toBe(false);
    expect(statesMatch("", "")).toBe(false);
    // Different lengths must not throw (timingSafeEqual would).
    expect(statesMatch("short", STATE)).toBe(false);
  });
});

describe("buildAuthorizeUrl", () => {
  it("requests exactly the posting and identity scopes", () => {
    const url = new URL(buildAuthorizeUrl({ config, state: STATE }));

    expect(`${url.origin}${url.pathname}`).toBe(LINKEDIN_AUTHORIZE_URL);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("state")).toBe(STATE);
    expect(url.searchParams.get("scope")).toBe("openid profile w_member_social");
    expect(LINKEDIN_SCOPES).toEqual(["openid", "profile", "w_member_social"]);
    // LinkedIn's examples use %20 between scopes rather than "+".
    expect(url.search).toContain("scope=openid%20profile%20w_member_social");
  });
});

describe("exchangeAuthorizationCode", () => {
  it("posts form-encoded credentials and returns the token", async () => {
    const { fetchImpl, calls } = mockFetch((call) =>
      call.url === LINKEDIN_TOKEN_URL
        ? json({ access_token: TOKEN, expires_in: 1234, refresh_token: REFRESH })
        : undefined,
    );

    const result = await exchangeAuthorizationCode({ code: "the-code", config, fetchImpl });

    expect(result).toEqual({ accessToken: TOKEN, refreshToken: REFRESH, expiresIn: 1234 });

    const [call] = calls;
    expect(call.init.method).toBe("POST");
    expect((call.init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );

    const form = new URLSearchParams(call.body ?? "");
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("the-code");
    expect(form.get("client_id")).toBe("client-123");
    expect(form.get("client_secret")).toBe("secret-456");
    expect(form.get("redirect_uri")).toBe(config.redirectUri);
  });

  it("returns a null refresh token when LinkedIn does not issue one", async () => {
    const { fetchImpl } = mockFetch(() => json({ access_token: TOKEN }));

    const result = await exchangeAuthorizationCode({ code: "c", config, fetchImpl });

    expect(result.refreshToken).toBeNull();
    expect(result.expiresIn).toBe(60 * 24 * 60 * 60);
  });

  it("surfaces a rejected code without leaking the secret", async () => {
    const { fetchImpl } = mockFetch(() =>
      json({ error: "invalid_request", error_description: "Unable to retrieve access token" }, 400),
    );

    const error = await oauthError(exchangeAuthorizationCode({ code: "c", config, fetchImpl }));

    expect(error.code).toBe("provider_error");
    expect(error.status).toBe(400);
    expect(error.message).toContain("Unable to retrieve access token");
    expect(error.message).not.toContain("secret-456");
  });

  it("redacts token-shaped provider text", async () => {
    const { fetchImpl } = mockFetch(() =>
      json({ error_description: `token ${TOKEN} rejected` }, 400),
    );

    const error = await oauthError(exchangeAuthorizationCode({ code: "c", config, fetchImpl }));

    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain("[redacted token]");
  });

  it("fails clearly when no token comes back", async () => {
    const { fetchImpl } = mockFetch(() => json({ scope: "openid" }));

    const error = await oauthError(exchangeAuthorizationCode({ code: "c", config, fetchImpl }));

    expect(error.code).toBe("invalid_response");
  });

  it("reports a network failure without echoing the code or secret", async () => {
    const { fetchImpl } = mockFetch(() => {
      throw new TypeError("fetch failed");
    });

    const error = await oauthError(exchangeAuthorizationCode({ code: "c", config, fetchImpl }));

    expect(error.code).toBe("provider_error");
    expect(error.message).toContain("Could not reach LinkedIn");
    expect(error.message).not.toContain("secret-456");
  });
});

describe("fetchLinkedInMember", () => {
  it("reads the member id and name from /v2/userinfo", async () => {
    const { fetchImpl, calls } = mockFetch((call) =>
      call.url === LINKEDIN_USERINFO_URL ? json({ sub: "member-42", name: "Ada" }) : undefined,
    );

    const member = await fetchLinkedInMember({ accessToken: TOKEN, fetchImpl });

    expect(member).toEqual({ memberId: "member-42", displayName: "Ada" });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("falls back to a placeholder name when none is returned", async () => {
    const { fetchImpl } = mockFetch(() => json({ sub: "member-42" }));

    await expect(fetchLinkedInMember({ accessToken: TOKEN, fetchImpl })).resolves.toEqual({
      memberId: "member-42",
      displayName: "LinkedIn member",
    });
  });

  it("fails when the profile scope did not grant an id", async () => {
    const { fetchImpl } = mockFetch(() => json({ name: "Ada" }));

    const error = await oauthError(fetchLinkedInMember({ accessToken: TOKEN, fetchImpl }));

    expect(error.code).toBe("invalid_response");
    expect(error.message).toContain("profile");
  });

  it("reports a rejected token with its status", async () => {
    const { fetchImpl } = mockFetch(() =>
      json({ message: "Invalid access token", status: 401 }, 401),
    );

    const error = await oauthError(fetchLinkedInMember({ accessToken: TOKEN, fetchImpl }));

    expect(error.code).toBe("provider_error");
    expect(error.status).toBe(401);
    expect(error.message).not.toContain(TOKEN);
  });
});

describe("completeLinkedInConnection", () => {
  it("returns an encrypted connection for the member", async () => {
    const { fetchImpl, calls } = mockFetch(happyRoute());
    const now = new Date("2026-10-26T12:00:00Z");

    const connection = await completeLinkedInConnection({
      code: "the-code",
      state: STATE,
      cookieState: STATE,
      config,
      fetchImpl,
      key: KEY,
      now,
    });

    expect(calls).toHaveLength(2);
    expect(connection.externalId).toBe("urn:li:person:member-42");
    expect(connection.memberId).toBe("member-42");
    expect(connection.displayName).toBe("Ada Lovelace");
    expect(connection.refreshTokenEnc).toBeNull();
    expect(connection.expiresAt).toEqual(new Date("2026-12-25T12:00:00Z"));

    // Stored ciphertext, not the raw token.
    expect(connection.accessTokenEnc).not.toContain(TOKEN);
    expect(decryptToken(connection.accessTokenEnc, KEY)).toBe(TOKEN);
  });

  it("encrypts a refresh token when one is issued", async () => {
    const { fetchImpl } = mockFetch(happyRoute({ access_token: TOKEN, refresh_token: REFRESH }));

    const connection = await completeLinkedInConnection({
      code: "c",
      state: STATE,
      cookieState: STATE,
      config,
      fetchImpl,
      key: KEY,
    });

    expect(connection.refreshTokenEnc).not.toBeNull();
    expect(decryptToken(connection.refreshTokenEnc as string, KEY)).toBe(REFRESH);
  });

  it("refuses a callback whose state does not match the cookie", async () => {
    const { fetchImpl, calls } = mockFetch(happyRoute());

    const error = await oauthError(
      completeLinkedInConnection({
        code: "the-code",
        state: "attacker-state",
        cookieState: STATE,
        config,
        fetchImpl,
        key: KEY,
      }),
    );

    expect(error.code).toBe("state_mismatch");
    expect(calls).toHaveLength(0);
  });

  it("refuses a callback with no state cookie at all", async () => {
    const { fetchImpl, calls } = mockFetch(happyRoute());

    const error = await oauthError(
      completeLinkedInConnection({ code: "c", state: STATE, cookieState: undefined, config, fetchImpl, key: KEY }),
    );

    expect(error.code).toBe("state_mismatch");
    expect(calls).toHaveLength(0);
  });

  it("reports a cancelled consent screen", async () => {
    const { fetchImpl, calls } = mockFetch(happyRoute());

    const error = await oauthError(
      completeLinkedInConnection({
        code: null,
        state: STATE,
        cookieState: STATE,
        providerError: "access_denied",
        config,
        fetchImpl,
        key: KEY,
      }),
    );

    expect(error.code).toBe("denied");
    expect(calls).toHaveLength(0);
  });

  it("fails when no code comes back", async () => {
    const { fetchImpl, calls } = mockFetch(happyRoute());

    const error = await oauthError(
      completeLinkedInConnection({
        code: null,
        state: STATE,
        cookieState: STATE,
        config,
        fetchImpl,
        key: KEY,
      }),
    );

    expect(error.code).toBe("provider_error");
    expect(calls).toHaveLength(0);
  });

  it("stores nothing when the encryption key is unusable", async () => {
    const { fetchImpl } = mockFetch(happyRoute());

    const error = await oauthError(
      completeLinkedInConnection({
        code: "c",
        state: STATE,
        cookieState: STATE,
        config,
        fetchImpl,
        key: Buffer.alloc(16),
      }),
    );

    expect(error.code).toBe("not_configured");
    expect(error.message).toContain("32 bytes");
    // The plaintext token was never handed back to be stored.
    expect(error.message).not.toContain(TOKEN);
  });

  it("propagates a provider failure with a safe message", async () => {
    const { fetchImpl } = mockFetch(() => json({ error: "server_error" }, 500));

    const error = await oauthError(
      completeLinkedInConnection({
        code: "c",
        state: STATE,
        cookieState: STATE,
        config,
        fetchImpl,
        key: KEY,
      }),
    );

    expect(error.code).toBe("provider_error");
    expect(error.status).toBe(500);
    expect(error.message).not.toContain(TOKEN);
  });
});
