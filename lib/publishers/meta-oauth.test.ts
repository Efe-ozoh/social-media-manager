import { describe, expect, it } from "vitest";
import { decryptToken } from "@/lib/crypto";
import {
  buildMetaAuthorizeUrl,
  completeMetaConnection,
  exchangeForLongLivedToken,
  exchangeMetaAuthorizationCode,
  fetchManagedPages,
  getMetaConfig,
  META_ACCOUNTS_URL,
  META_AUTHORIZE_URL,
  META_SCOPES,
  META_TOKEN_URL,
  MetaOAuthError,
  type MetaConfig,
} from "./meta-oauth";
import { graphUrl } from "./meta-graph";

const KEY = Buffer.alloc(32, 5);
const USER_TOKEN = "EAA-long-lived-user-token-0123456789abcdef";
const SHORT_TOKEN = "EAA-short-lived-user-token-0123456789";
const PAGE_TOKEN = "EAA-page-token-abcdef0123456789";
const IG_ID = "17841400000000001";
const STATE = "s".repeat(43);

const config: MetaConfig = {
  appId: "app-123",
  appSecret: "secret-456",
  redirectUri: "https://app.example/api/auth/meta/callback",
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
    const body = typeof init.body === "string" ? init.body : null;
    const call: Call = { url, init, body };
    calls.push(call);

    const response = await route(call);
    if (!response) throw new Error(`unexpected request: ${init.method ?? "GET"} ${url}`);
    return response;
  }) as typeof fetch;

  return { fetchImpl, calls };
}

function query(call: Call): URLSearchParams {
  return new URL(call.url).searchParams;
}

function pathOf(call: Call): string {
  return new URL(call.url).pathname;
}

const pagesPath = "/v26.0/me/accounts";
const tokenPath = "/v26.0/oauth/access_token";

/** A Meta that exchanges, lists one Page with an IG account, and names it. */
function happyRoute(options: {
  pages?: Record<string, unknown>[];
  igUsername?: Record<string, unknown>;
  igStatus?: number;
  tokenBodies?: Record<string, unknown>[];
} = {}): (call: Call) => Response | undefined {
  let exchanges = 0;
  const tokenBodies = options.tokenBodies ?? [
    { access_token: SHORT_TOKEN, expires_in: 3_600 },
    { access_token: USER_TOKEN, expires_in: 5_184_000 },
  ];

  return (call) => {
    const path = pathOf(call);

    if (path === tokenPath) {
      const body = tokenBodies[Math.min(exchanges, tokenBodies.length - 1)];
      exchanges += 1;
      return json(body);
    }
    if (path === pagesPath) {
      return json({
        data: options.pages ?? [
          {
            id: "page-1",
            name: "CodeSync Hub",
            access_token: PAGE_TOKEN,
            instagram_business_account: { id: IG_ID },
          },
        ],
      });
    }
    if (path === `/v26.0/${IG_ID}`) {
      return json(options.igUsername ?? { id: IG_ID, username: "codesync" }, options.igStatus ?? 200);
    }
    return undefined;
  };
}

async function oauthError(promise: Promise<unknown>): Promise<MetaOAuthError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MetaOAuthError);
    return error as MetaOAuthError;
  }
  throw new Error("expected the flow to fail");
}

describe("getMetaConfig", () => {
  it("builds the callback URL from APP_URL", () => {
    expect(
      getMetaConfig({
        META_APP_ID: " app-123 ",
        META_APP_SECRET: "secret-456",
        APP_URL: "https://app.example/",
      }),
    ).toEqual(config);
  });

  it("names every missing variable", async () => {
    const error = await oauthError((async () => getMetaConfig({ APP_URL: "" }))());

    expect(error.code).toBe("not_configured");
    expect(error.message).toContain("META_APP_ID");
    expect(error.message).toContain("META_APP_SECRET");
    expect(error.message).toContain("APP_URL");
  });
});

describe("buildMetaAuthorizeUrl", () => {
  it("requests exactly the five posting and discovery scopes", () => {
    const url = new URL(buildMetaAuthorizeUrl({ config, state: STATE }));

    expect(`${url.origin}${url.pathname}`).toBe(META_AUTHORIZE_URL);
    expect(META_AUTHORIZE_URL).toContain("/v26.0/dialog/oauth");
    expect(url.searchParams.get("client_id")).toBe("app-123");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("state")).toBe(STATE);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(META_SCOPES.join(","));
    expect(META_SCOPES).toEqual([
      "pages_show_list",
      "pages_read_engagement",
      "pages_manage_posts",
      "instagram_basic",
      "instagram_content_publish",
    ]);
  });
});

describe("exchangeMetaAuthorizationCode", () => {
  it("sends the documented query parameters and returns the token", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      json({ access_token: SHORT_TOKEN, token_type: "bearer", expires_in: 3_600 }),
    );

    const result = await exchangeMetaAuthorizationCode({ code: "the-code", config, fetchImpl });

    expect(result).toEqual({ accessToken: SHORT_TOKEN, expiresIn: 3_600 });
    expect(calls[0].url.startsWith(META_TOKEN_URL)).toBe(true);

    const params = query(calls[0]);
    expect(params.get("client_id")).toBe("app-123");
    expect(params.get("client_secret")).toBe("secret-456");
    expect(params.get("redirect_uri")).toBe(config.redirectUri);
    expect(params.get("code")).toBe("the-code");
  });

  it("surfaces a rejected code without leaking the secret", async () => {
    const { fetchImpl } = mockFetch(() =>
      json({ error: { message: "Invalid verification code format", code: 100 } }, 400),
    );

    const error = await oauthError(
      exchangeMetaAuthorizationCode({ code: "bad", config, fetchImpl }),
    );

    expect(error.code).toBe("provider_error");
    expect(error.status).toBe(400);
    expect(error.message).toContain("Invalid verification code format");
    expect(error.message).not.toContain("secret-456");
  });

  it("fails clearly when no token comes back", async () => {
    const { fetchImpl } = mockFetch(() => json({ token_type: "bearer" }));

    const error = await oauthError(
      exchangeMetaAuthorizationCode({ code: "c", config, fetchImpl }),
    );

    expect(error.code).toBe("invalid_response");
  });

  it("reports a transport failure without echoing the secret", async () => {
    const { fetchImpl } = mockFetch(() => {
      throw new TypeError("fetch failed");
    });

    const error = await oauthError(
      exchangeMetaAuthorizationCode({ code: "c", config, fetchImpl }),
    );

    expect(error.code).toBe("provider_error");
    expect(error.message).toContain("Could not reach Meta");
  });
});

describe("exchangeForLongLivedToken", () => {
  it("uses the documented fb_exchange_token grant", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      json({ access_token: USER_TOKEN, expires_in: 5_184_000 }),
    );

    const result = await exchangeForLongLivedToken({ shortLivedToken: SHORT_TOKEN, config, fetchImpl });

    expect(result).toEqual({ accessToken: USER_TOKEN, expiresIn: 5_184_000 });

    const params = query(calls[0]);
    expect(params.get("grant_type")).toBe("fb_exchange_token");
    expect(params.get("fb_exchange_token")).toBe(SHORT_TOKEN);
    expect(params.get("client_id")).toBe("app-123");
    expect(params.get("client_secret")).toBe("secret-456");
  });

  it("falls back to about 60 days when Meta omits expires_in", async () => {
    const { fetchImpl } = mockFetch(() => json({ access_token: USER_TOKEN }));

    const result = await exchangeForLongLivedToken({ shortLivedToken: SHORT_TOKEN, config, fetchImpl });

    expect(result.expiresIn).toBe(60 * 24 * 60 * 60);
  });
});

describe("fetchManagedPages", () => {
  it("requests the IG link, the token and an appsecret_proof", async () => {
    const { fetchImpl, calls } = mockFetch(happyRoute());

    const pages = await fetchManagedPages({ userToken: USER_TOKEN, config, fetchImpl });

    expect(pages).toEqual([
      { id: "page-1", name: "CodeSync Hub", accessToken: PAGE_TOKEN, instagramId: IG_ID },
    ]);
    expect(META_ACCOUNTS_URL).toBe(graphUrl("/me/accounts"));

    const params = query(calls[0]);
    expect(params.get("fields")).toBe("id,name,access_token,instagram_business_account");
    expect(params.get("access_token")).toBe(USER_TOKEN);
    expect(params.get("appsecret_proof")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("skips entries without a Page token and pages without an IG link", async () => {
    const { fetchImpl } = mockFetch(
      happyRoute({
        pages: [
          { id: "page-1", name: "No Token" },
          { id: "page-2", name: "No Instagram", access_token: PAGE_TOKEN },
        ],
      }),
    );

    const pages = await fetchManagedPages({ userToken: USER_TOKEN, config, fetchImpl });

    expect(pages).toEqual([
      { id: "page-2", name: "No Instagram", accessToken: PAGE_TOKEN, instagramId: null },
    ]);
  });
});

describe("completeMetaConnection", () => {
  const now = new Date("2026-10-26T12:00:00Z");

  it("returns encrypted Facebook and Instagram accounts", async () => {
    const { fetchImpl, calls } = mockFetch(happyRoute());

    const connection = await completeMetaConnection({
      code: "the-code",
      state: STATE,
      cookieState: STATE,
      config,
      fetchImpl,
      key: KEY,
      now,
    });

    // token, long-lived token, Pages, Instagram username.
    expect(calls).toHaveLength(4);
    expect(connection.notes).toEqual([]);
    expect(connection.accounts).toHaveLength(2);

    const [facebook, instagram] = connection.accounts;

    expect(facebook.platform).toBe("facebook");
    expect(facebook.externalId).toBe("page-1");
    expect(facebook.displayName).toBe("CodeSync Hub");
    // Page tokens derived from a long-lived user token have no expiry date.
    expect(facebook.expiresAt).toBeNull();
    expect(facebook.accessTokenEnc).not.toContain(PAGE_TOKEN);
    expect(decryptToken(facebook.accessTokenEnc, KEY)).toBe(PAGE_TOKEN);

    expect(instagram.platform).toBe("instagram");
    expect(instagram.externalId).toBe(IG_ID);
    expect(instagram.displayName).toBe("@codesync");
    expect(instagram.accessTokenEnc).not.toContain(USER_TOKEN);
    expect(decryptToken(instagram.accessTokenEnc, KEY)).toBe(USER_TOKEN);
    expect(instagram.expiresAt).toEqual(new Date("2026-12-25T12:00:00Z"));
  });

  it("refuses a callback whose state does not match the cookie", async () => {
    const { fetchImpl, calls } = mockFetch(happyRoute());

    const error = await oauthError(
      completeMetaConnection({
        code: "the-code",
        state: "attacker",
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
      completeMetaConnection({
        code: "the-code",
        state: STATE,
        cookieState: undefined,
        config,
        fetchImpl,
        key: KEY,
      }),
    );

    expect(error.code).toBe("state_mismatch");
    expect(calls).toHaveLength(0);
  });

  it("reports a cancelled consent screen without exchanging anything", async () => {
    const { fetchImpl, calls } = mockFetch(happyRoute());

    const error = await oauthError(
      completeMetaConnection({
        code: null,
        state: STATE,
        cookieState: STATE,
        providerError: "access_denied",
        providerErrorDescription: "User denied the request",
        config,
        fetchImpl,
        key: KEY,
      }),
    );

    expect(error.code).toBe("denied");
    expect(error.message).toContain("cancelled");
    expect(calls).toHaveLength(0);
  });

  it("explains an account with no Pages", async () => {
    const { fetchImpl } = mockFetch(happyRoute({ pages: [] }));

    const error = await oauthError(
      completeMetaConnection({
        code: "c",
        state: STATE,
        cookieState: STATE,
        config,
        fetchImpl,
        key: KEY,
      }),
    );

    expect(error.code).toBe("no_pages");
    expect(error.message).toContain("admin of a Page");
    expect(error.message).toContain("pages_show_list");
  });

  it("keeps the Instagram account when its username cannot be read", async () => {
    const { fetchImpl } = mockFetch(happyRoute({ igStatus: 403 }));

    const connection = await completeMetaConnection({
      code: "c",
      state: STATE,
      cookieState: STATE,
      config,
      fetchImpl,
      key: KEY,
      now,
    });

    expect(connection.accounts).toHaveLength(2);
    const instagram = connection.accounts[1];
    expect(instagram.platform).toBe("instagram");
    expect(instagram.externalId).toBe(IG_ID);
    expect(instagram.displayName).toBe(`Instagram ${IG_ID}`);
    expect(connection.notes[0]).toContain("Could not read the Instagram username");
  });

  it("notes a Page without a linked Instagram account", async () => {
    const { fetchImpl } = mockFetch(
      happyRoute({ pages: [{ id: "page-2", name: "No Instagram", access_token: PAGE_TOKEN }] }),
    );

    const connection = await completeMetaConnection({
      code: "c",
      state: STATE,
      cookieState: STATE,
      config,
      fetchImpl,
      key: KEY,
      now,
    });

    expect(connection.accounts).toHaveLength(1);
    expect(connection.accounts[0].platform).toBe("facebook");
    expect(connection.notes[0]).toContain("no linked Instagram professional account");
  });

  it("stores nothing when the encryption key is unusable", async () => {
    const { fetchImpl } = mockFetch(happyRoute());

    const error = await oauthError(
      completeMetaConnection({
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
    expect(error.message).not.toContain(USER_TOKEN);
  });

  it("propagates a provider failure with a safe message", async () => {
    const { fetchImpl } = mockFetch(() => json({ error: { message: "Server error" } }, 500));

    const error = await oauthError(
      completeMetaConnection({
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
    expect(error.message).not.toContain(SHORT_TOKEN);
  });

  it("does not expose a token in the message when Meta echoes one", async () => {
    const { fetchImpl } = mockFetch(() =>
      json({ error: { message: `Invalid token ${USER_TOKEN}` } }, 400),
    );

    const error = await oauthError(
      completeMetaConnection({
        code: "c",
        state: STATE,
        cookieState: STATE,
        config,
        fetchImpl,
        key: KEY,
      }),
    );

    expect(error.message).not.toContain(USER_TOKEN);
  });
});
