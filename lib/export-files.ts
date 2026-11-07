/**
 * File names for the manual-export screens — pure, so both the client buttons
 * and the server routes produce exactly the same names.
 *
 * Instagram and Facebook downloads are named after the post and the slide
 * number the owner sees, 1-based, because slide_index in post_media is 0-based.
 * A short id keeps the name readable while still identifying the post.
 */

/** Slide images are stored as JPEG (see lib/image-store.ts). */
export const EXPORT_IMAGE_TYPE = "image/jpeg";

/** First eight characters of the id without dashes, e.g. b1946ac9. */
export function shortPostId(id: string): string {
  const compact = id.replace(/-/g, "");
  return compact.slice(0, 8) || "post";
}

/** post-b1946ac9-slide-1.jpg */
export function slideFileName(postId: string, slideNumber: number): string {
  return `post-${shortPostId(postId)}-slide-${slideNumber}.jpg`;
}

/** post-b1946ac9-slides.zip */
export function zipFileName(postId: string): string {
  return `post-${shortPostId(postId)}-slides.zip`;
}
