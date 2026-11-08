import { NextResponse, type NextRequest } from "next/server";
import {
  hasUnsplashAccessKey,
  searchPortraitPhotos,
  type BackgroundSearchResult,
} from "@/lib/unsplash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/backgrounds/search?q=ocean&page=2
 *
 * Login is enforced by proxy.ts for every /api route except the login
 * endpoint. Returns up to 6 portrait photos already cropped to 1080 x 1350;
 * `page` backs the picker's "Show other photos" button.
 *
 * A missing key, an Unsplash error, a spent rate limit or zero results is a
 * normal, non-fatal answer: `photos` is empty and `error` explains why, so the
 * picker can fall back to the solid background. No download tracking happens
 * here — a search is a view, not a use.
 */
export async function GET(request: NextRequest) {
  const configured = hasUnsplashAccessKey();
  const query = request.nextUrl.searchParams.get("q") ?? "";
  const rawPage = request.nextUrl.searchParams.get("page") ?? "1";
  const page = /^\d{1,3}$/.test(rawPage.trim())
    ? Math.min(50, Math.max(1, Number(rawPage)))
    : 1;

  if (query.trim().length < 2) {
    return NextResponse.json(
      {
        photos: [],
        error: "Enter at least 2 characters to search.",
        cached: false,
        configured,
        rateLimit: { limit: null, remaining: null },
      } satisfies BackgroundSearchResult & { configured: boolean },
      { status: 400 },
    );
  }

  if (query.trim().length > 120) {
    return NextResponse.json(
      {
        photos: [],
        error: "Search text is too long (120 characters max).",
        cached: false,
        configured,
        rateLimit: { limit: null, remaining: null },
      } satisfies BackgroundSearchResult & { configured: boolean },
      { status: 400 },
    );
  }

  const result = await searchPortraitPhotos(query, undefined, page);

  return NextResponse.json(
    { ...result, configured },
    { headers: { "Cache-Control": "no-store" } },
  );
}
