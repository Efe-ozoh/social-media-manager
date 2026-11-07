"use client";

import { useState, type ReactNode } from "react";
import { slideFileName, zipFileName } from "@/lib/export-files";
import { useHydrated } from "@/lib/use-hydrated";

/**
 * Manual-export screen for Instagram and Facebook.
 *
 * Everything here is browser-only work on public slide images and the caption;
 * no endpoint returns a token. Per-slide downloads go through our own route so
 * the file arrives with a readable name even when the slide itself lives on a
 * cross-origin blob host, where the `download` attribute is ignored.
 */

type ExportSlide = { slideNumber: number; url: string };

type ExportPost = {
  id: string;
  status: string;
  /** The caption is the whole post; there are no slides to export. */
  textOnly: boolean;
  caption: string;
  bodyText: string;
  slides: ExportSlide[];
};

const PRIMARY =
  "inline-flex items-center justify-center rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300";
const SECONDARY =
  "inline-flex items-center justify-center rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800";

function Notice({ tone, children }: { tone: "info" | "error"; children: ReactNode }) {
  return (
    <p
      role="status"
      className={`mt-3 rounded-lg border px-3 py-2 text-sm leading-relaxed ${
        tone === "error"
          ? "border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
          : "border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-900 dark:bg-sky-950/40 dark:text-sky-200"
      }`}
    >
      {children}
    </p>
  );
}

export function ExportScreen({ post }: { post: ExportPost }) {
  const [tab, setTab] = useState<"instagram" | "facebook">("instagram");
  const [facebookText, setFacebookText] = useState(post.caption);
  const [notice, setNotice] = useState<{ tone: "info" | "error"; text: string } | null>(
    null,
  );
  const [sharing, setSharing] = useState(false);

  const hasSlides = post.slides.length > 0;

  // Feature detection needs a browser. It only runs after hydration, so the
  // Share button is absent from both the server HTML and the first client pass;
  // without file support it is never rendered.
  const hydrated = useHydrated();
  const canShareFiles = hydrated && supportsFileSharing();

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice({ tone: "info", text: `${label} copied.` });
    } catch {
      setNotice({
        tone: "error",
        text: "Could not copy automatically. Select the text and copy it manually.",
      });
    }
  }

  async function share(text: string) {
    if (!hasSlides) return;

    setSharing(true);
    setNotice(null);
    try {
      const files = await Promise.all(
        post.slides.map(async (slide) => {
          const response = await fetch(
            `/api/posts/${post.id}/export/slide/${slide.slideNumber}`,
          );
          if (!response.ok) throw new Error("Could not read a slide.");

          const blob = await response.blob();
          return new File([blob], slideFileName(post.id, slide.slideNumber), {
            type: "image/jpeg",
          });
        }),
      );

      if (!navigator.canShare?.({ files })) {
        setNotice({
          tone: "error",
          text: "This browser cannot share image files. Use the download buttons instead.",
        });
        return;
      }

      await navigator.share({ files, text });
    } catch (shareError) {
      // A cancelled share sheet throws too; only report real failures.
      if (shareError instanceof Error && shareError.name === "AbortError") return;
      setNotice({
        tone: "error",
        text: "Sharing failed. Use the download buttons instead.",
      });
    } finally {
      setSharing(false);
    }
  }

  return (
    <div className="mt-5">
      <div role="tablist" aria-label="Export destination" className="flex flex-wrap gap-1">
        {(
          [
            { value: "instagram", label: "Instagram" },
            { value: "facebook", label: "Facebook" },
          ] as const
        ).map((option) => {
          const active = tab === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => {
                setTab(option.value);
                setNotice(null);
              }}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                active
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}

      {!hasSlides ? (
        <div className="mt-4 rounded-xl border border-dashed border-zinc-300 p-4 dark:border-zinc-700">
          <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
            {post.textOnly
              ? "This is a text-only post, so there are no images to download. The caption below is the whole post: copy it into Instagram or Facebook by hand."
              : "This post has no saved slides, so there are no images to download. Edit the post and save it again to render them."}
          </p>
        </div>
      ) : null}

      {tab === "instagram" ? (
        <section className="mt-4 space-y-4">
          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60">
            <h2 className="text-sm font-semibold">
              {post.slides.length} slide{post.slides.length === 1 ? "" : "s"}
            </h2>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {post.slides.map((slide) => (
                <figure key={slide.slideNumber} className="space-y-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={slide.url}
                    alt={`Slide ${slide.slideNumber}`}
                    className="aspect-[4/5] w-full rounded-lg border border-zinc-200 object-cover dark:border-zinc-800"
                  />
                  <figcaption className="flex items-center justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                    <span>Slide {slide.slideNumber}</span>
                    <a
                      href={`/api/posts/${post.id}/export/slide/${slide.slideNumber}`}
                      download={slideFileName(post.id, slide.slideNumber)}
                      className="font-medium text-sky-700 underline underline-offset-2 dark:text-sky-300"
                    >
                      Download
                    </a>
                  </figcaption>
                </figure>
              ))}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <a
                href={`/api/posts/${post.id}/export/zip`}
                download={zipFileName(post.id)}
                className={PRIMARY}
              >
                Download all (ZIP)
              </a>
              {canShareFiles && hasSlides ? (
                <button
                  type="button"
                  onClick={() => void share(instagramNote(post.caption))}
                  disabled={sharing}
                  className={SECONDARY}
                >
                  {sharing ? "Preparing…" : "Share"}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => void copy(post.caption, "Caption")}
                className={SECONDARY}
              >
                Copy caption
              </button>
            </div>

            <p className="mt-3 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
              Instagram ignores any caption passed through the share sheet, so
              paste it into the app after the images are added.
            </p>
          </div>

          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60">
            <h2 className="text-sm font-semibold">How to post</h2>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
              <li>Download all the slides (or pick a few) and copy the caption.</li>
              <li>Open Instagram and choose a new post, then select the slides in order.</li>
              <li>Paste the caption, check the crop, and share.</li>
            </ol>
          </div>
        </section>
      ) : (
        <section className="mt-4 space-y-4">
          <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60">
            <h2 className="text-sm font-semibold">Caption</h2>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
              Edits here are only for copying. The saved post is not changed.
            </p>
            <textarea
              value={facebookText}
              onChange={(event) => setFacebookText(event.target.value)}
              rows={8}
              className="mt-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm leading-relaxed outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
            />

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void copy(facebookText, "Text")}
                className={PRIMARY}
              >
                Copy text
              </button>
              <a
                href="https://www.facebook.com/"
                target="_blank"
                rel="noreferrer"
                className={SECONDARY}
              >
                Open Facebook
              </a>
              {canShareFiles && hasSlides ? (
                <button
                  type="button"
                  onClick={() => void share(facebookText)}
                  disabled={sharing}
                  className={SECONDARY}
                >
                  {sharing ? "Preparing…" : "Share images"}
                </button>
              ) : null}
            </div>
          </div>

          {hasSlides ? (
            <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60">
              <h2 className="text-sm font-semibold">Images</h2>
              <ul className="mt-2 space-y-2">
                {post.slides.map((slide) => (
                  <li
                    key={slide.slideNumber}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <span className="text-zinc-600 dark:text-zinc-400">
                      Slide {slide.slideNumber}
                    </span>
                    <a
                      href={`/api/posts/${post.id}/export/slide/${slide.slideNumber}`}
                      download={slideFileName(post.id, slide.slideNumber)}
                      className="font-medium text-sky-700 underline underline-offset-2 dark:text-sky-300"
                    >
                      Download
                    </a>
                  </li>
                ))}
              </ul>
              <a
                href={`/api/posts/${post.id}/export/zip`}
                download={zipFileName(post.id)}
                className={`${SECONDARY} mt-3`}
              >
                Download all (ZIP)
              </a>
            </div>
          ) : null}
        </section>
      )}
    </div>
  );
}

/** Whether this browser can share image files with the Web Share API. */
function supportsFileSharing(): boolean {
  if (typeof navigator === "undefined" || typeof navigator.canShare !== "function") {
    return false;
  }

  try {
    const probe = new File([new Blob(["probe"], { type: "image/jpeg" })], "probe.jpg", {
      type: "image/jpeg",
    });
    return navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

/**
 * Instagram's share sheet accepts the caption but the app ignores it. Sending
 * it anyway keeps the text visible in the sheet, and the note above the buttons
 * says it has to be pasted.
 */
function instagramNote(caption: string): string {
  return caption;
}
