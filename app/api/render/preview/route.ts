import { NextResponse, type NextRequest } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import {
  MAX_BODY_BYTES,
  PREVIEW_RATE_LIMIT,
  PREVIEW_RATE_WINDOW_MS,
  parsePreviewRequest,
} from "@/lib/preview-request";
import {
  renderSlidesPng,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  type BackgroundImage,
} from "@/lib/renderer";
import { splitSlides } from "@/lib/splitter";
import { fetchBackgroundImage } from "@/lib/unsplash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/render/preview
 *
 * Body: { text, contentType?, language?, background?, usePhotoBehindCode? }
 * where background is { url, authorName?, authorUrl? } from the Unsplash
 * picker. Login is enforced by proxy.ts.
 *
 * Renders without uploading and without touching the database, returning the
 * slide PNGs inline as base64 data URIs for the dashboard preview. Rendering
 * is capped at the carousel limit; `tooLong` tells the UI to offer a trim.
 */
export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const limit = rateLimit(
    `render-preview:${ip}`,
    PREVIEW_RATE_LIMIT,
    PREVIEW_RATE_WINDOW_MS,
  );
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many previews. Try again in a few minutes." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  // Refuse an oversized body before buffering it (and again after reading,
  // since Content-Length can be absent or wrong).
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: `Request body is too large (${MAX_BODY_BYTES} bytes max).` },
      { status: 413 },
    );
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return NextResponse.json({ error: "Could not read the request body." }, { status: 400 });
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: `Request body is too large (${MAX_BODY_BYTES} bytes max).` },
      { status: 413 },
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = parsePreviewRequest(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  }

  const { text, contentType, language, background, usePhotoBehindCode } = parsed.value;

  // A photo that cannot be fetched falls back to the solid card: preview must
  // never fail because of a background.
  let photo: BackgroundImage | null = null;
  if (background) {
    const bytes = await fetchBackgroundImage(background.url);
    if (bytes) {
      photo = {
        data: bytes,
        attribution: background.authorName
          ? { name: background.authorName, url: background.authorUrl ?? undefined }
          : undefined,
      };
    }
  }

  try {
    const split = splitSlides({ text, contentType, language });
    const slides = split.slides.slice(0, split.config.carouselCap);
    const pngs =
      slides.length > 0
        ? await renderSlidesPng(
            { ...split, slides },
            { background: photo, usePhotoBehindCode },
          )
        : [];

    return NextResponse.json(
      {
        slides: pngs.map((png, index) => ({
          index,
          dataUri: `data:image/png;base64,${png.toString("base64")}`,
          width: SLIDE_WIDTH,
          height: SLIDE_HEIGHT,
        })),
        slideCount: split.slideCount,
        renderedSlideCount: pngs.length,
        tooLong: split.tooLong,
        showIndicator: split.showIndicator,
        contentType: split.contentType,
        language: split.language,
        background: photo ? "photo" : "solid",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("render preview failed", error);
    return NextResponse.json({ error: "Could not render the slides." }, { status: 500 });
  }
}
