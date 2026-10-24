import { NextResponse, type NextRequest } from "next/server";
import { verifyPassword } from "@/lib/password";
import { rateLimit } from "@/lib/rate-limit";
import {
  createSessionToken,
  getAuthSecret,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from "@/lib/session";

export const runtime = "nodejs";

const MAX_ATTEMPTS = 10;
const WINDOW_MS = 10 * 60 * 1000;

export async function POST(request: NextRequest) {
  const secret = getAuthSecret();
  const storedHash = process.env.ALLOWED_LOGIN?.trim();
  if (!secret || !storedHash) {
    return NextResponse.json(
      {
        error:
          "Login is not configured. Set AUTH_SECRET (32+ characters) and ALLOWED_LOGIN in .env.local.",
      },
      { status: 500 },
    );
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const limit = rateLimit(`login:${ip}`, MAX_ATTEMPTS, WINDOW_MS);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  let password = "";
  try {
    const body = (await request.json()) as { password?: unknown };
    if (typeof body.password === "string") password = body.password;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  if (password.length === 0 || password.length > 512) {
    return NextResponse.json({ error: "Incorrect password." }, { status: 401 });
  }

  if (!verifyPassword(password, storedHash)) {
    return NextResponse.json({ error: "Incorrect password." }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: SESSION_COOKIE,
    value: await createSessionToken(secret),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return response;
}
