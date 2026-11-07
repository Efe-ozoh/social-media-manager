import Link from "next/link";
import { notFound } from "next/navigation";
import { isUuid } from "@/lib/post-view";
import { getPrisma } from "@/lib/prisma";
import { ExportScreen } from "./export-screen";

export const dynamic = "force-dynamic";

/**
 * Export screen for the manual-export platforms (Instagram, Facebook).
 *
 * The page only needs the caption and the slide URLs; no token, account row or
 * target error is selected, so nothing secret can reach the browser.
 */
export default async function ExportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const post = await getPrisma().post.findUnique({
    where: { id },
    select: {
      id: true,
      caption: true,
      bodyText: true,
      textOnly: true,
      status: true,
      media: {
        orderBy: { slideIndex: "asc" },
        select: { slideIndex: true, url: true },
      },
    },
  });
  if (!post) notFound();

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <Link
        href="/posts"
        className="text-sm text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
      >
        ← Posts
      </Link>

      <h1 className="mt-2 text-xl font-semibold tracking-tight">Post by hand</h1>
      <p className="mt-1 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
        Instagram and Facebook are manual exports: download the slides, copy the
        caption, and post from the app itself.
      </p>

      <ExportScreen
        post={{
          id: post.id,
          status: post.status,
          textOnly: post.textOnly,
          caption: post.caption,
          bodyText: post.bodyText,
          slides: post.media.map((slide) => ({
            slideNumber: slide.slideIndex + 1,
            url: slide.url,
          })),
        }}
      />
    </main>
  );
}
