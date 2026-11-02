import { NextResponse, type NextRequest } from "next/server";
import { dispatchDue } from "@/lib/dispatcher";
import { isUuid, POST_INCLUDE, serializePost } from "@/lib/post-view";
import { getPrisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/posts/[id]/publish-now
 *
 * Makes the post's unfinished targets due immediately, then runs the same
 * dispatch path as the cron endpoint. Published targets are left alone, and a
 * target already processing is not reset (that could double-post).
 */
export async function POST(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Invalid post id." }, { status: 400 });
  }

  const prisma = getPrisma();
  const existing = await prisma.post.findUnique({
    where: { id },
    include: POST_INCLUDE,
  });
  if (!existing) return NextResponse.json({ error: "Post not found." }, { status: 404 });

  const unfinished = existing.targets.filter(
    (target) => target.status !== "published",
  );
  if (unfinished.length === 0) {
    return NextResponse.json(
      { error: "This post is already published on every target." },
      { status: 409 },
    );
  }

  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.post.update({
      where: { id },
      data: { status: "scheduled", scheduledAt: now },
    });

    await tx.postTarget.updateMany({
      where: {
        postId: id,
        status: { in: ["pending", "failed"] },
      },
      data: {
        status: "pending",
        attempts: 0,
        nextAttemptAt: now,
        lastError: null,
        notes: null,
        requiresReconnect: false,
        processingStartedAt: null,
      },
    });
  });

  const summary = await dispatchDue({ postId: id, now, limit: 100 });

  const post = await prisma.post.findUnique({
    where: { id },
    include: POST_INCLUDE,
  });

  return NextResponse.json({
    ok: true,
    ...summary,
    ...(post ? { post: serializePost(post) } : {}),
  });
}
