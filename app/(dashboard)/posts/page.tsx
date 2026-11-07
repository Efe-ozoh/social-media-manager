import Link from "next/link";
import { PostsList } from "./posts-list";

export default function PostsPage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Posts</h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            Scheduled posts publish within about a minute of their time.
            Instagram and Facebook are posted by hand from each post&apos;s
            export screen.
          </p>
        </div>
        <Link
          href="/compose"
          className="inline-flex rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
        >
          New post
        </Link>
      </div>

      <PostsList />
    </main>
  );
}
