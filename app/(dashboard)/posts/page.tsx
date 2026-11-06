import Link from "next/link";

export default function PostsPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-12 sm:px-6">
      <h1 className="text-xl font-semibold tracking-tight">Posts</h1>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
        The posts table is the next Phase 5 step. It will show per-platform
        status, retry controls, error details, and edit/delete for unpublished
        posts.
      </p>
      <Link
        href="/compose"
        className="mt-6 inline-flex rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
      >
        Back to Compose
      </Link>
    </main>
  );
}
