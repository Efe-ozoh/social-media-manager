import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { readJsonBody } from "@/lib/api-body";
import { trackBackgroundForPost } from "@/lib/background-tracking";
import { createImageStore, keyFromPublicUrl } from "@/lib/image-store";
import { parsePostCreate } from "@/lib/post-request";
import { POST_INCLUDE, serializePost } from "@/lib/post-view";
import { getPrisma } from "@/lib/prisma";
import {
  deleteStaleImages,
  renderPost,
  type PostMediaRow,
} from "@/lib/render-post";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/posts
 *
 * Creates a draft or a scheduled post, renders its slides, saves post_media,
 * and only then deletes images from a previous render (none on create). Login
 * is enforced by proxy.ts.
 */
export async function POST(request: NextRequest) {
  const body = await readJsonBody(request);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }

  const parsed = parsePostCreate(body.value);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  }

  const input = parsed.value;
  const id = randomUUID();
  const store = createImageStore();

  // A text-only post publishes its caption as plain text: nothing is
  // rendered, so no slide can be stored and no image upload happens.
  let rendered: Awaited<ReturnType<typeof renderPost>> | null = null;
  if (!input.textOnly) {
    try {
      rendered = await renderPost(
        {
          id,
          bodyText: input.bodyText,
          code: input.code,
          contentType: input.contentType,
          language: input.language,
          backgroundMode: input.background.backgroundMode,
          bgUrl: input.background.bgUrl,
          bgAuthorName: input.background.bgAuthorName,
          bgAuthorUrl: input.background.bgAuthorUrl,
        },
        store,
        { usePhotoBehindCode: input.usePhotoBehindCode },
      );
    } catch {
      return NextResponse.json({ error: "Could not render the slides." }, { status: 502 });
    }
  }

  try {
    await getPrisma().post.create({
      data: {
        id,
        title: input.title,
        bodyText: input.bodyText,
        contentType: input.contentType,
        code: input.code,
        language: input.language,
        theme: input.theme,
        caption: input.caption,
        textOnly: input.textOnly,
        carouselMode: input.carouselMode,
        source: input.source,
        aiPrompt: input.aiPrompt,
        status: input.status,
        scheduledAt: input.scheduledAt,
        ...input.background,
        usePhotoBehindCode: input.usePhotoBehindCode,
        bgCreditCaption: input.creditCaption,
        ...(rendered && rendered.media.length > 0
          ? {
              media: {
                create: rendered.media.map((row) => ({
                  slideIndex: row.slideIndex,
                  url: row.url,
                  width: row.width,
                  height: row.height,
                })),
              },
            }
          : {}),
        targets: {
          create: input.targets.map((target) => ({
            platform: target.platform,
            captionOverride: target.captionOverride,
          })),
        },
      },
    });
  } catch {
    // The post was never saved, so its newly uploaded slides are orphans.
    // Delete only what this attempt wrote; nothing older is in scope.
    await deleteStaleImages(mediaKeys(rendered?.media ?? []), store);
    return NextResponse.json(
      { error: "Could not save the post (database error)." },
      { status: 503 },
    );
  }

  // New posts have no previous render, so this is normally a no-op.
  await deleteStaleImages(rendered?.staleKeys ?? [], store);

  // Unsplash wants a download reported once the photo is actually used. A
  // draft is not a use; scheduling is. Failures are swallowed by the helper.
  if (input.status === "scheduled") {
    await trackBackgroundForPost(id);
  }

  const post = await getPrisma().post.findUnique({
    where: { id },
    include: POST_INCLUDE,
  });
  if (!post) {
    return NextResponse.json(
      { error: "The post was saved but could not be read back." },
      { status: 500 },
    );
  }

  return NextResponse.json({ post: serializePost(post) }, { status: 201 });
}

/** GET /api/posts — every post with its media and per-target status. */
export async function GET() {
  const posts = await getPrisma().post.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: POST_INCLUDE,
  });

  return NextResponse.json(
    { posts: posts.map(serializePost) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

function mediaKeys(media: PostMediaRow[]): string[] {
  return media
    .map((row) => keyFromPublicUrl(row.url))
    .filter((key): key is string => key !== null);
}
