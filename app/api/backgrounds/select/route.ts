import { NextResponse, type NextRequest } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { isUnsplashImageUrl, trackDownload } from "@/lib/unsplash";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_QUERY = 120;

/** The bg_* columns of a post, as written to Prisma. */
type BackgroundSelection = {
  backgroundMode: "solid" | "unsplash";
  backgroundQuery: string | null;
  bgUnsplashId: string | null;
  bgUrl: string | null;
  bgThumbUrl: string | null;
  bgAuthorName: string | null;
  bgAuthorUrl: string | null;
  bgColor: string | null;
};

function solidSelection(): BackgroundSelection {
  return {
    backgroundMode: "solid",
    backgroundQuery: null,
    bgUnsplashId: null,
    bgUrl: null,
    bgThumbUrl: null,
    bgAuthorName: null,
    bgAuthorUrl: null,
    bgColor: null,
  };
}

function fail(error: string, status = 400) {
  return NextResponse.json({ ok: false, error }, { status });
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim().slice(0, max)
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Attribution must link back to Unsplash (guideline requirement). */
function isUnsplashProfileUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "unsplash.com" || url.hostname.endsWith(".unsplash.com"))
    );
  } catch {
    return false;
  }
}

/**
 * POST /api/backgrounds/select
 *
 * Body, either shape:
 *   { "mode": "unsplash", "photo": <a photo from /api/backgrounds/search>,
 *     "query": "ocean", "postId": "<uuid>"? }
 *   { "mode": "solid", "postId": "<uuid>"? }
 *
 * With `postId` the choice is written to the post's bg_* columns; without one
 * it is validated and echoed back, so the compose UI can hold a selection
 * before the post exists. Login is enforced by proxy.ts.
 *
 * Selecting a photo is the moment Unsplash considers the photo "used", so the
 * download is tracked here — never from search or preview.
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown> | null;
  try {
    body = asRecord(await request.json());
  } catch {
    return fail("Invalid JSON body.");
  }
  if (!body) return fail("Invalid request body.");

  const rawPostId = body.postId;
  if (rawPostId !== undefined && rawPostId !== null && typeof rawPostId !== "string") {
    return fail("postId must be a UUID.");
  }
  const postId = text(rawPostId, 64);
  if (typeof rawPostId === "string" && rawPostId.trim() !== "" && !UUID_PATTERN.test(rawPostId.trim())) {
    return fail("postId must be a UUID.");
  }

  const mode = text(body.mode, 16);
  const photo = asRecord(body.photo);
  const wantsUnsplash = mode === "unsplash" || (mode === null && photo !== null);

  let selection: BackgroundSelection;
  let downloadLocation: string | null = null;

  if (wantsUnsplash) {
    if (!photo) return fail('photo is required when mode is "unsplash".');

    const id = text(photo.id, 64);
    const url = text(photo.url, 2048);
    const authorName = text(photo.authorName, 120);
    const authorUrl = text(photo.authorUrl, 2048);

    if (!id) return fail("photo.id is required.");
    if (!url || !isUnsplashImageUrl(url)) {
      return fail("photo.url must be a hotlinked images.unsplash.com URL.");
    }
    if (!authorName) {
      return fail("photo.authorName is required: Unsplash attribution needs it.");
    }
    if (!authorUrl || !isUnsplashProfileUrl(authorUrl)) {
      return fail("photo.authorUrl must link to the photographer's Unsplash profile.");
    }

    const thumbUrl = text(photo.thumbUrl, 2048);
    selection = {
      backgroundMode: "unsplash",
      backgroundQuery: text(body.query, MAX_QUERY),
      bgUnsplashId: id,
      bgUrl: url,
      bgThumbUrl: thumbUrl && isUnsplashImageUrl(thumbUrl) ? thumbUrl : null,
      bgAuthorName: authorName,
      bgAuthorUrl: authorUrl,
      bgColor: text(photo.color, 16),
    };
    downloadLocation = text(photo.downloadLocation, 2048);
  } else if (mode === "solid" || mode === null) {
    selection = solidSelection();
  } else {
    return fail('mode must be "solid" or "unsplash".');
  }

  // Fire-and-forget: a failed download ping must never fail the request.
  if (downloadLocation) void trackDownload(downloadLocation);

  if (!postId) {
    return NextResponse.json(
      { ok: true, saved: false, postId: null, selection },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const post = await getPrisma().post.update({
      where: { id: postId },
      data: selection,
      select: { id: true },
    });

    return NextResponse.json(
      { ok: true, saved: true, postId: post.id, selection },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if ((error as { code?: string }).code === "P2025") {
      return fail("Post not found.", 404);
    }
    const message =
      error instanceof Error ? error.message.split("\n")[0] : "Unknown error";
    return fail(`Could not save the background: ${message}`, 503);
  }
}
