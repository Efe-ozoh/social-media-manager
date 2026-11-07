/**
 * Preview for a text-only post.
 *
 * There is nothing to render, so this shows the caption exactly as it will be
 * published: plain text, blank lines kept, no slide frame and no image.
 */
export function TextPreview({ caption }: { caption: string }) {
  const text = caption.trim();

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Text preview</h2>
        <span className="rounded-full border border-zinc-300 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-600 dark:border-zinc-700 dark:text-zinc-300">
          No images
        </span>
      </div>

      <div className="mt-3 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
        {text ? (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-900 dark:text-zinc-100">
            {caption}
          </p>
        ) : (
          <p className="text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
            Start writing the caption to see how the post will read.
          </p>
        )}
      </div>

      <p className="mt-2 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
        Published as plain text: no slides are rendered, stored or uploaded.
      </p>
    </section>
  );
}
