import { NextResponse, type NextRequest } from "next/server";
import type { Prisma } from "@/lib/generated/prisma/client";
import { readJsonBody } from "@/lib/api-body";
import { trackBackgroundForPost } from "@/lib/background-tracking";
import { createImageStore, keyFromPublicUrl } from "@/lib/image-store";
import type { PlatformName } from "@/lib/platforms";
import { renderSaveAndCleanup } from "@/lib/post-media";
import {
  changesRenderedContent,
  parsePostUpdate,
  type PostUpdateInput,
} from "@/lib/post-request";
import { isUuid, POST_INCLUDE, serializePost } from "@/lib/post-view";
import { getPrisma } from "@/lib/prisma";
import {
  deleteStaleImages,
  renderPost,
  type PostMediaRow,
} from "@/lib/render-post";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

async function postId(context: RouteContext): Promise<string | null> {
  const { id } = await context.params;
  return isUuid(id) ? id : null;
}

export async function GET(_request: NextRequest, context: RouteContext) {
  const id = await postId(context);
  if (!id) return NextResponse.json({ error: "Invalid post id." }, { status: 400 });

  const post = await getPrisma().post.findUnique({
    where: { id },
    include: POST_INCLUDE,
  });
  if (!post) return NextResponse.json({ error: "Post not found." }, { status: 404 });

  return NextResponse.json(
    { post: serializePost(post) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * PATCH /api/posts/[id]
 *
 * Only draft and scheduled posts are editable. When rendered content changes
 * the slides are re-rendered before the database write; the old images are
 * deleted only after the new post_media rows have been committed.
 */
export async function PATCH(request: NextRequest, context: RouteContext) {
  const id = await postId(context);
  if (!id) return NextResponse.json({ error: "Invalid post id." }, { status: 400 });

  const body = await readJsonBody(request);
  if (!body.ok) {
    return NextResponse.json({ error: body.error }, { status: body.status });
  }

  const prisma = getPrisma();
  const existing = await prisma.post.findUnique({
    where: { id },
    include: POST_INCLUDE,
  });
  if (!existing) return NextResponse.json({ error: "Post not found." }, { status: 404 });

  if (existing.status !== "draft" && existing.status !== "scheduled") {
    return NextResponse.json(
      { error: "Only draft or scheduled posts can be edited." },
      { status: 409 },
    );
  }

  const parsed = parsePostUpdate(body.value, {
    currentContentType: existing.contentType,
    currentScheduledAt: existing.scheduledAt,
    currentTextOnly: existing.textOnly,
    currentCaption: existing.caption,
    currentTargets: existing.targets.map((target) => ({
      platform: target.platform as PlatformName,
      captionOverride: target.captionOverride,
    })),
  });
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: parsed.status });
  }
  const update = parsed.value;

  // Replacing targets after a publish has started could publish the same post
  // twice, so it is refused even though the parent is still "scheduled".
  if (
    update.targets &&
    existing.targets.some(
      (target) => target.status === "published" || target.status === "processing",
    )
  ) {
    return NextResponse.json(
      { error: "Targets cannot be changed after publishing has started." },
      { status: 409 },
    );
  }

  const store = createImageStore();
  const contentChanged = changesRenderedContent(update);

  const save = (media: PostMediaRow[] | null) =>
    savePostUpdate(id, update, media);

  try {
    if (update.textOnly === true) {
      // Turning a post into text only drops its slides: the rows go first and
      // the images they referenced are deleted afterwards.
      await save([]);
      const keys = existing.media
        .map((row) => keyFromPublicUrl(row.url))
        .filter((key): key is string => key !== null);
      if (keys.length > 0) await deleteStaleImages(keys, store);
    } else if (contentChanged) {
      await renderSaveAndCleanup({
        render: () =>
          renderPost(
            {
              id,
              bodyText: update.bodyText ?? existing.bodyText,
              code: update.code !== undefined ? update.code : existing.code,
              contentType: update.contentType ?? existing.contentType,
              language:
                update.language !== undefined ? update.language : existing.language,
              backgroundMode:
                update.background?.backgroundMode ?? existing.backgroundMode,
              bgUrl: update.background ? update.background.bgUrl : existing.bgUrl,
              bgAuthorName: update.background
                ? update.background.bgAuthorName
                : existing.bgAuthorName,
              bgAuthorUrl: update.background
                ? update.background.bgAuthorUrl
                : existing.bgAuthorUrl,
            },
            store,
            {
              previousUrls: existing.media.map((row) => row.url),
              usePhotoBehindCode:
                update.usePhotoBehindCode ?? existing.usePhotoBehindCode,
            },
          ),
        save,
        deleteStale: (keys) => deleteStaleImages(keys, store),
      });
    } else {
      await save(null);
    }
  } catch {
    return NextResponse.json(
      { error: "Could not render or save the post." },
      { status: 503 },
    );
  }

  // Scheduling is the first moment the photo is considered used. The helper is
  // idempotent, so later saves of the same photo do not report it again.
  if ((update.status ?? existing.status) === "scheduled") {
    await trackBackgroundForPost(id);
  }

  const post = await prisma.post.findUnique({
    where: { id },
    include: POST_INCLUDE,
  });
  if (!post) return NextResponse.json({ error: "Post not found." }, { status: 404 });

  return NextResponse.json({ post: serializePost(post) });
}

/** DELETE /api/posts/[id] — only while draft or scheduled. */
export async function DELETE(_request: NextRequest, context: RouteContext) {
  const id = await postId(context);
  if (!id) return NextResponse.json({ error: "Invalid post id." }, { status: 400 });

  const prisma = getPrisma();
  const existing = await prisma.post.findUnique({
    where: { id },
    include: { media: true },
  });
  if (!existing) return NextResponse.json({ error: "Post not found." }, { status: 404 });

  if (existing.status !== "draft" && existing.status !== "scheduled") {
    return NextResponse.json(
      { error: "Only draft or scheduled posts can be deleted." },
      { status: 409 },
    );
  }

  await prisma.post.delete({ where: { id } });

  // The rows are gone; now the images they referenced may be removed.
  const keys = existing.media
    .map((row) => keyFromPublicUrl(row.url))
    .filter((key): key is string => key !== null);
  if (keys.length > 0) {
    await deleteStaleImages(keys, createImageStore());
  }

  return NextResponse.json({ ok: true });
}

async function savePostUpdate(
  id: string,
  update: PostUpdateInput,
  media: PostMediaRow[] | null,
): Promise<void> {
  const data: Prisma.PostUpdateInput = {};

  if (update.title !== undefined) data.title = update.title;
  if (update.bodyText !== undefined) data.bodyText = update.bodyText;
  if (update.contentType !== undefined) data.contentType = update.contentType;
  if (update.code !== undefined) data.code = update.code;
  if (update.language !== undefined) data.language = update.language;
  if (update.theme !== undefined) data.theme = update.theme;
  if (update.caption !== undefined) data.caption = update.caption;
  if (update.textOnly !== undefined) data.textOnly = update.textOnly;
  if (update.carouselMode !== undefined) data.carouselMode = update.carouselMode;
  if (update.source !== undefined) data.source = update.source;
  if (update.aiPrompt !== undefined) data.aiPrompt = update.aiPrompt;
  if (update.status !== undefined) data.status = update.status;
  if (update.scheduledAt !== undefined) data.scheduledAt = update.scheduledAt;
  if (update.usePhotoBehindCode !== undefined) {
    data.usePhotoBehindCode = update.usePhotoBehindCode;
  }
  if (update.creditCaption !== undefined) data.bgCreditCaption = update.creditCaption;
  if (update.background !== undefined) {
    Object.assign(data, update.background);
    // A solid background has no photo, so nothing is left to attribute or
    // report; clear the tracked id with the photo it belonged to.
    if (update.background.backgroundMode === "solid") data.bgDownloadTracked = null;
  }

  await getPrisma().$transaction(async (tx) => {
    await tx.post.update({ where: { id }, data });

    if (update.targets !== undefined) {
      await tx.postTarget.deleteMany({ where: { postId: id } });
      await tx.postTarget.createMany({
        data: update.targets.map((target) => ({
          postId: id,
          platform: target.platform,
          captionOverride: target.captionOverride,
        })),
      });
    }

    if (media !== null) {
      await tx.postMedia.deleteMany({ where: { postId: id } });
      if (media.length > 0) {
        await tx.postMedia.createMany({
          data: media.map((row) => ({
            postId: id,
            slideIndex: row.slideIndex,
            url: row.url,
            width: row.width,
            height: row.height,
          })),
        });
      }
    }
  });
}
