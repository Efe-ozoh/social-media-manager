import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it } from "vitest";
import { PUBLIC_PATHS, proxy } from "./proxy";

/**
 * Every new Phase 5b page and route must stay behind login (SPEC section 12).
 * The proxy is what enforces it, so the test drives the real proxy: an
 * unauthenticated API call gets 401, a page gets redirected to /login.
 *
 * AUTH_SECRET is set to a throwaway value so the session check has something to
 * verify against; no real secret is read here.
 */

beforeAll(() => {
  process.env.AUTH_SECRET ??= "test-secret-for-proxy-tests-only".repeat(2);
});

const PROTECTED = [
  "/posts",
  "/posts/b1946ac9-2f6c-4e1b-9d5a-0f2f4a7c8d3e/export",
  "/accounts",
  "/api/posts",
  "/api/posts/b1946ac9-2f6c-4e1b-9d5a-0f2f4a7c8d3e/export/zip",
  "/api/posts/b1946ac9-2f6c-4e1b-9d5a-0f2f4a7c8d3e/export/slide/1",
  "/api/posts/b1946ac9-2f6c-4e1b-9d5a-0f2f4a7c8d3e/targets/22222222-2222-4222-8222-222222222222/retry",
  "/api/platforms/telegram",
] as const;

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

describe("proxy", () => {
  it("keeps the posts, export, retry and accounts routes private", () => {
    for (const path of PROTECTED) {
      expect(isPublic(path)).toBe(false);
    }
  });

  it("answers 401 for an unauthenticated API call", async () => {
    for (const path of PROTECTED.filter((path) => path.startsWith("/api/"))) {
      const response = await proxy(new NextRequest(`http://localhost:3000${path}`));
      expect(response.status).toBe(401);
    }
  });

  it("redirects an unauthenticated page to the login screen", async () => {
    const response = await proxy(new NextRequest("http://localhost:3000/posts"));

    expect(response.status).toBe(307);

    const location = new URL(response.headers.get("location") as string);
    expect(location.pathname).toBe("/login");
    // The page the owner asked for is kept, so login can send them back.
    expect(location.searchParams.get("next")).toBe("/posts");
  });

  it("leaves only the documented paths public", () => {
    expect(PUBLIC_PATHS).toEqual([
      "/login",
      "/api/auth/login",
      "/api/auth/linkedin/callback",
      "/api/auth/meta/callback",
      "/api/cron/dispatch",
    ]);
  });
});
