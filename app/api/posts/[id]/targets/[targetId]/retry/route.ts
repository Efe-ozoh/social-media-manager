import { NextResponse, type NextRequest } from "next/server";
import { isUuid, POST_INCLUDE, serializePost } from "@/lib/post-view";
import { getPrisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; targetId: string }> };

/**
 * POST /api/posts/[id]/targets/[targetId]/retry
 *
 * Retries one target that ended up failed. Login is enforced by proxy.ts (this
 * path is not public), and only a failed target of a saved post can be reset:
 * a published target must never publish twice, and a pending one is already
 * queued.
 *
 * The target goes back to pending with its attempt counter reset, so it gets a
 * full retry budget rather than the one or two attempts it had left. Because
 * the dispatcher only claims targets whose parent post is scheduled, the parent
 * is put back to scheduled as well; its scheduled time is left alone unless it
 * never had one, so a future schedule is not pulled forward.
 */
export async function POST(_request: NextRequest, context: RouteContext) {
  const { id, targetId } = await context.params;
  if (!isUuid(id) || !isUuid(targetId)) {
    return NextResponse.json({ error: "Invalid post or target id." }, { status: 400 });
  }

  const prisma = getPrisma();
  const post = await prisma.post.findUnique({
    where: { id },
    include: { targets: true },
  });
  if (!post) return NextResponse.json({ error: "Post not found." }, { status: 404 });

  const target = post.targets.find((row) => row.id === targetId);
  if (!target) return NextResponse.json({ error: "Target not found." }, { status: 404 });

  if (target.status !== "failed") {
    return NextResponse.json(
      { error: "Only a failed target can be retried." },
      { status: 409 },
    );
  }

  if (post.status === "draft") {
    return NextResponse.json(
      { error: "Schedule the post before retrying one of its targets." },
      { status: 409 },
    );
  }

  const now = new Date();
  const reset = await prisma.$transaction(async (tx) => {
    // Matching on status again makes two overlapping retries safe: the second
    // one updates nothing and reports a conflict instead of double-queueing.
    const updated = await tx.postTarget.updateMany({
      where: { id: targetId, postId: id, status: "failed" },
      data: {
        status: "pending",
        attempts: 0,
        nextAttemptAt: now,
        lastError: null,
        notes: null,
        processingStartedAt: null,
      },
    });
    if (updated.count === 0) return false;

    await tx.post.update({
      where: { id },
      data: {
        status: "scheduled",
        ...(post.scheduledAt ? {} : { scheduledAt: now }),
      },
    });
    return true;
  });

  if (!reset) {
    return NextResponse.json(
      { error: "The target changed before it could be retried. Reload and try again." },
      { status: 409 },
    );
  }

  const updated = await prisma.post.findUnique({
    where: { id },
    include: POST_INCLUDE,
  });
  if (!updated) return NextResponse.json({ error: "Post not found." }, { status: 404 });

  return NextResponse.json(
    { ok: true, post: serializePost(updated) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
