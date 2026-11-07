import { NextResponse, type NextRequest } from "next/server";
import { zipFileName } from "@/lib/export-files";
import { readSlides, toArrayBuffer, zipSlides } from "@/lib/post-export";
import { isUuid } from "@/lib/post-view";
import { getPrisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/posts/[id]/export/zip
 *
 * Every saved slide of one post as a ZIP, for posting by hand to Instagram or
 * Facebook. Login is enforced by proxy.ts; the bytes never come from a client
 * supplied URL, only from the post's own post_media rows.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Invalid post id." }, { status: 400 });
  }

  const post = await getPrisma().post.findUnique({
    where: { id },
    select: {
      id: true,
      media: {
        orderBy: { slideIndex: "asc" },
        select: { slideIndex: true, url: true },
      },
    },
  });
  if (!post) return NextResponse.json({ error: "Post not found." }, { status: 404 });

  if (post.media.length === 0) {
    return NextResponse.json(
      { error: "This post has no saved slides to export." },
      { status: 409 },
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = zipSlides(await readSlides(post.id, post.media));
  } catch {
    return NextResponse.json(
      { error: "Could not read this post's slides from storage." },
      { status: 502 },
    );
  }

  return new NextResponse(toArrayBuffer(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${zipFileName(post.id)}"`,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "no-store",
    },
  });
}
