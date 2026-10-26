import { NextResponse, type NextRequest } from "next/server";
import {
  hasUnsplashAccessKey,
  searchPortraitPhotos,
  type BackgroundSearchResult,
} from "@/lib/unsplash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/backgrounds/search?q=ocean
 *
 * Login is enforced by proxy.ts for every /api route except the login
 * endpoint. Returns up to 6 portrait photos already cropped to 1080 x 1350.
 *
 * A missing key, an Unsplash error or zero results is a normal, non-fatal
 * answer: `photos` is empty and `error` explains why, so the picker can fall
 * back to the solid background. No download tracking happens here.
 */
export async function GET(request: NextRequest) {
  const configured = hasUnsplashAccessKey();
  const query = request.nextUrl.searchParams.get("q") ?? "";

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

  const result = await searchPortraitPhotos(query);

  return NextResponse.json(
    { ...result, configured },
    { headers: { "Cache-Control": "no-store" } },
  );
}
