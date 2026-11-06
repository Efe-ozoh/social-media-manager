"use client";

import Image from "next/image";

export type PreviewSlide = {
  index: number;
  dataUri: string;
  width: number;
  height: number;
};

export type PreviewState = {
  loading: boolean;
  error: string | null;
  slides: PreviewSlide[];
  slideCount: number;
  renderedSlideCount: number;
  tooLong: boolean;
};

export const EMPTY_PREVIEW: PreviewState = {
  loading: false,
  error: null,
  slides: [],
  slideCount: 0,
  renderedSlideCount: 0,
  tooLong: false,
};

export function SlidePreview({
  state,
  index,
  onIndexChange,
}: {
  state: PreviewState;
  index: number;
  onIndexChange: (index: number) => void;
}) {
  const slide = state.slides[index];
  const hasSlides = state.slides.length > 0;

  return (
    <section
      aria-labelledby="preview-heading"
      className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 id="preview-heading" className="text-sm font-semibold">
          Slide preview
        </h2>
        {state.loading ? (
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            Rendering…
          </span>
        ) : null}
      </div>

      <div className="mt-3 aspect-[4/5] overflow-hidden rounded-lg border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-950">
        {slide ? (
          <Image
            src={slide.dataUri}
            alt={`Slide ${index + 1} of ${state.slides.length}`}
            width={slide.width}
            height={slide.height}
            unoptimized
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
            {state.error
              ? state.error
              : state.loading
                ? "Rendering the first slide…"
                : "Start typing to see the slides."}
          </div>
        )}
      </div>

      {state.error && hasSlides ? (
        <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}

      {hasSlides ? (
        <div className="mt-3 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => onIndexChange(Math.max(0, index - 1))}
            disabled={index <= 0}
            className="rounded-lg border border-zinc-300 px-2.5 py-1 text-sm transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Previous
          </button>
          <span className="text-xs tabular-nums text-zinc-600 dark:text-zinc-400">
            {index + 1} / {state.slides.length}
          </span>
          <button
            type="button"
            onClick={() =>
              onIndexChange(Math.min(state.slides.length - 1, index + 1))
            }
            disabled={index >= state.slides.length - 1}
            className="rounded-lg border border-zinc-300 px-2.5 py-1 text-sm transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            Next
          </button>
        </div>
      ) : null}

      {state.tooLong ? (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
          This content needs {state.slideCount} slides; only the first{" "}
          {state.renderedSlideCount} are published. Shorten it to fit the cap.
        </p>
      ) : null}
    </section>
  );
}
