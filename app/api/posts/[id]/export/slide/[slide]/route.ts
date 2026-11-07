import { NextResponse, type NextRequest } from "next/server";
import { readSlides, toArrayBuffer, type ExportedSlide } from "@/lib/post-export";
import { isUuid } from "@/lib/post-view";
import { getPrisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; slide: string }> };

/**
 * GET /api/posts/[id]/export/slide/[slide]
 *
 * One slide as a JPEG with a readable download name. The route exists so the
 * browser gets a same-origin response (a cross-origin Blob URL cannot be forced
 * to download under a chosen file name). `slide` is 1-based, like the names the
 * export screen shows.
 */
export async function GET(_request: NextRequest, context: RouteContext) {
  const { id, slide } = await context.params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Invalid post id." }, { status: 400 });
  }
  if (!/^[1-9][0-9]?$/.test(slide)) {
    return NextResponse.json({ error: "Invalid slide number." }, { status: 400 });
  }

  const slideIndex = Number(slide) - 1;
  const post = await getPrisma().post.findUnique({
    where: { id },
    select: {
      id: true,
      media: {
        where: { slideIndex },
        select: { slideIndex: true, url: true },
      },
    },
  });
  if (!post) return NextResponse.json({ error: "Post not found." }, { status: 404 });

  const row = post.media[0];
  if (!row) return NextResponse.json({ error: "Slide not found." }, { status: 404 });

  let exported: ExportedSlide;
  try {
    [exported] = await readSlides(post.id, [row]);
  } catch {
    return NextResponse.json(
      { error: "Could not read that slide from storage." },
      { status: 502 },
    );
  }

  return new NextResponse(toArrayBuffer(exported.bytes), {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Disposition": `attachment; filename="${exported.fileName}"`,
      "Content-Length": String(exported.bytes.byteLength),
      "Cache-Control": "no-store",
    },
  });
}
