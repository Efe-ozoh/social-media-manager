import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { GET as metaCallback } from "./callback/route";
import { GET as metaStart } from "./start/route";

/**
 * ENABLE_META is the switch that turned Meta automated posting off. These tests
 * drive the real route handlers — no network, no database — to prove three
 * things: the flag closes both routes, it does not close them unconditionally
 * (turning it on still starts the flow), and a callback that arrives while it
 * is off writes nothing.
 */

const SAVED_ENV = { ...process.env };

function setEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  process.env = { ...SAVED_ENV };
});

function request(path: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`);
}

function reasonOf(response: Response): string | null {
  return new URL(response.headers.get("location") as string).searchParams.get("reason");
}

const CREDENTIALS = {
  META_APP_ID: "test-app-id",
  META_APP_SECRET: "test-app-secret",
  APP_URL: "http://localhost:3000",
};

describe("Meta OAuth while ENABLE_META is off", () => {
  it("answers disabled from the start route and sets no state cookie", async () => {
    setEnv({ ...CREDENTIALS, ENABLE_META: "false" });

    const response = await metaStart(request("/api/auth/meta/start"));

    expect(response.status).toBe(307);
    expect(reasonOf(response)).toBe("disabled");
    // Stays on our own origin: no Facebook authorize URL was built.
    expect(new URL(response.headers.get("location") as string).hostname).toBe("localhost");
    // No state cookie, so the flow cannot continue even if someone follows it.
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("answers disabled from the callback and never reaches the database", async () => {
    // No DATABASE_URL: if the route saved anything, it would answer save_failed.
    setEnv({ ...CREDENTIALS, ENABLE_META: "false", DATABASE_URL: undefined });

    const response = await metaCallback(
      request("/api/auth/meta/callback?code=abc&state=xyz"),
    );

    expect(reasonOf(response)).toBe("disabled");
  });

  it("defaults to disabled when the variable is absent", async () => {
    setEnv({ ...CREDENTIALS, ENABLE_META: undefined });

    expect(reasonOf(await metaStart(request("/api/auth/meta/start")))).toBe("disabled");
  });
});

describe("Meta OAuth while ENABLE_META is on", () => {
  it("starts the flow and sets the state cookie scoped to the callback", async () => {
    setEnv({ ...CREDENTIALS, ENABLE_META: "true" });

    const response = await metaStart(request("/api/auth/meta/start"));
    const location = new URL(response.headers.get("location") as string);

    expect(response.status).toBe(307);
    expect(location.hostname).toBe("www.facebook.com");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/auth/meta/callback",
    );
    expect(response.headers.get("set-cookie")).toContain("meta_oauth_state=");
    expect(response.headers.get("set-cookie")).toContain("Path=/api/auth/meta/callback");
  });

  it("still reports missing credentials separately", async () => {
    setEnv({
      ENABLE_META: "true",
      META_APP_ID: undefined,
      META_APP_SECRET: undefined,
      APP_URL: "http://localhost:3000",
    });

    expect(reasonOf(await metaStart(request("/api/auth/meta/start")))).toBe("not_configured");
  });
});
