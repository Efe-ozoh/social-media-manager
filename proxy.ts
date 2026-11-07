import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

// Everything requires login except the login page, the login endpoint, the
// platform OAuth callbacks and the cron endpoint (SPEC section 12). A callback
// is protected by its own one-shot `state` cookie, and the browser arrives
// from the provider as a top-level navigation. The cron route is protected by
// its own CRON_SECRET check instead (lib/cron-auth.ts).
export const PUBLIC_PATHS = [
  "/login",
  "/api/auth/login",
  "/api/auth/linkedin/callback",
  "/api/auth/meta/callback",
  "/api/cron/dispatch",
];

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (await verifySessionToken(token)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  const next = `${pathname}${search}`;
  if (pathname !== "/") loginUrl.searchParams.set("next", next);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    // Skip Next internals and static assets.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
