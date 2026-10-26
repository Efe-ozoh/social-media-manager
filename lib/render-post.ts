/**
 * Post rendering and upload — SPEC section 8, "Rendering and storage".
 *
 * Renders a post's slides, uploads every PNG through an ImageStore, and
 * returns the rows that belong in post_media. Rendering happens once when a
 * post is created or edited, not on every publish attempt.
 *
 * Re-running is safe: keys include a fingerprint of everything that affects
 * the output, and uploads for the new set finish before any blob the previous
 * render left behind is deleted. Images belonging to other posts are never
 * touched. The caller must persist the returned rows right after this
 * resolves — the old blobs are already gone by then.
 */

import { createHash } from "node:crypto";
import { getPrisma } from "./prisma";
import {
  createImageStore,
  keyFromPublicUrl,
  type ImageStore,
} from "./image-store";
import {
  renderSlidesPng,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  type BackgroundImage,
} from "./renderer";
import { splitSlides, type SplitContentType } from "./splitter";
import { fetchBackgroundImage } from "./unsplash";

/** One row of post_media, minus the post id the caller adds. */
export type PostMediaRow = {
  slideIndex: number;
  url: string;
  width: number;
  height: number;
};

/** The post fields rendering depends on. */
export type RenderablePost = {
  id: string;
  bodyText: string;
  code: string | null;
  contentType: SplitContentType;
  language: string | null;
  backgroundMode: "solid" | "unsplash";
  bgUrl: string | null;
  bgAuthorName: string | null;
  bgAuthorUrl: string | null;
};

export type RenderPostOptions = {
  /** URLs already in post_media; anything no longer used is deleted. */
  previousUrls?: string[];
  /** Off by default: code cards keep their solid theme. */
  usePhotoBehindCode?: boolean;
};

export type RenderPostResult = {
  /** Ready for post_media (add postId at the call site). */
  media: PostMediaRow[];
  slideCount: number;
  renderedSlideCount: number;
  tooLong: boolean;
  background: "photo" | "solid";
  /** Storage keys removed after the new set was uploaded. */
  removedKeys: string[];
};

/** Bumped when the splitter/renderer output changes, so old blobs get cleaned. */
const RENDER_VERSION = 1;

/**
 * Renders and uploads one post. `store` is injected so tests (and callers
 * that need a specific backend) never depend on the environment.
 */
export async function renderPost(
  post: RenderablePost,
  store: ImageStore,
  options: RenderPostOptions = {},
): Promise<RenderPostResult> {
  const text = textForPost(post);
  const split = splitSlides({
    text,
    contentType: post.contentType,
    language: post.language,
  });

  // The carousel cap is also the storage/publish ceiling; `tooLong` warns.
  const slides = split.slides.slice(0, split.config.carouselCap);

  const background = await loadBackground(post);
  const pngs =
    slides.length > 0
      ? await renderSlidesPng(
          { ...split, slides },
          { background, usePhotoBehindCode: options.usePhotoBehindCode },
        )
      : [];

  const fingerprint = renderFingerprint({
    text,
    contentType: split.contentType,
    language: split.language,
    backgroundUrl: background ? post.bgUrl : null,
    usePhotoBehindCode: options.usePhotoBehindCode === true,
  });
  const prefix = postKeyPrefix(post.id);

  const media: PostMediaRow[] = [];
  const uploadedUrls: string[] = [];

  try {
    for (const [index, png] of pngs.entries()) {
      const key = `${prefix}${fingerprint}/slide-${index + 1}.png`;
      const url = await store.put(png, key);
      uploadedUrls.push(url);
      media.push({
        slideIndex: index,
        url,
        width: SLIDE_WIDTH,
        height: SLIDE_HEIGHT,
      });
    }
  } catch (error) {
    // Do not leak a half-uploaded carousel: drop what this attempt wrote.
    await Promise.allSettled(
      uploadedUrls.map((url) => {
        const key = keyFromPublicUrl(url);
        return key ? store.delete(key) : Promise.resolve();
      }),
    );
    throw error;
  }

  const removedKeys = await removeStaleImages(store, {
    prefix,
    previousUrls: options.previousUrls ?? [],
    currentUrls: media.map((row) => row.url),
  });

  return {
    media,
    slideCount: split.slideCount,
    renderedSlideCount: media.length,
    tooLong: split.tooLong,
    background: background ? "photo" : "solid",
    removedKeys,
  };
}

/**
 * Loads a post and its current media, renders it, uploads the slides and
 * returns the rows to save. The database is read, not written: saving the
 * rows (and the post's updated timestamp) is the caller's job.
 */
export async function renderPostForStorage(
  postId: string,
  options: { store?: ImageStore; usePhotoBehindCode?: boolean } = {},
): Promise<RenderPostResult> {
  const prisma = getPrisma();
  const post = await prisma.post.findUnique({
    where: { id: postId },
    include: { media: { orderBy: { slideIndex: "asc" } } },
  });
  if (!post) throw new Error(`Post ${postId} not found`);

  return renderPost(
    {
      id: post.id,
      bodyText: post.bodyText,
      code: post.code,
      contentType: post.contentType,
      language: post.language,
      backgroundMode: post.backgroundMode,
      bgUrl: post.bgUrl,
      bgAuthorName: post.bgAuthorName,
      bgAuthorUrl: post.bgAuthorUrl,
    },
    options.store ?? createImageStore(),
    {
      previousUrls: post.media.map((row) => row.url),
      usePhotoBehindCode: options.usePhotoBehindCode,
    },
  );
}

/** Storage keys for one post live under a single prefix. */
export function postKeyPrefix(postId: string): string {
  return `posts/${postId}/`;
}

function textForPost(post: RenderablePost): string {
  if (post.contentType === "code") {
    const code = post.code?.trim();
    if (code) return post.code as string;
  }
  return post.bodyText;
}

async function loadBackground(post: RenderablePost): Promise<BackgroundImage | null> {
  if (post.backgroundMode !== "unsplash" || !post.bgUrl) return null;

  const data = await fetchBackgroundImage(post.bgUrl);
  if (!data) return null;

  const name = post.bgAuthorName?.trim();
  return {
    data,
    attribution: name ? { name, url: post.bgAuthorUrl ?? undefined } : undefined,
  };
}

function renderFingerprint(input: {
  text: string;
  contentType: SplitContentType;
  language: string | null;
  backgroundUrl: string | null;
  usePhotoBehindCode: boolean;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({ version: RENDER_VERSION, ...input }))
    .digest("hex")
    .slice(0, 16);
}

/** Deletes images this post no longer references; other posts stay untouched. */
async function removeStaleImages(
  store: ImageStore,
  options: { prefix: string; previousUrls: string[]; currentUrls: string[] },
): Promise<string[]> {
  const current = new Set(options.currentUrls);
  const removed: string[] = [];

  for (const url of options.previousUrls) {
    if (current.has(url)) continue;

    const key = keyFromPublicUrl(url);
    // Only ever delete this post's own namespace.
    if (!key || !key.startsWith(options.prefix)) continue;

    await store.delete(key);
    removed.push(key);
  }

  return removed;
}
