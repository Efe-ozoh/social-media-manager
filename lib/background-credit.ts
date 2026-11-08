/**
 * Unsplash credit in the caption — Phase 5c.
 *
 * The renderer draws "Photo by {name} on Unsplash" on the first slide, but a
 * slide credit alone does not follow the post when the images are re-shared or
 * the caption is read on its own. Unsplash's guidelines therefore also want the
 * photographer credited wherever the photo is used, so automated posts append
 * the same line to the caption unless the owner turns the option off.
 *
 * Pure: no network, no environment, safe to import from the Compose page.
 */

import { UNSPLASH_CREDIT_SUFFIX } from "./publisher-limits";

/** "Photo by {name} on Unsplash", or null when there is no usable name. */
export function photoCreditLine(authorName: string | null | undefined): string | null {
  const name = authorName?.trim();
  if (!name) return null;
  return `Photo by ${name} ${UNSPLASH_CREDIT_SUFFIX}`;
}

/**
 * Appends the credit on its own paragraph, once.
 *
 * If the credit would push the caption past the platform's limit, the caption
 * is returned unchanged: a too-long caption is a publish failure, and the
 * first-slide credit still satisfies the attribution requirement. The check is
 * also what keeps the result publishable when the caption is already at the
 * limit.
 */
export function appendPhotoCredit(
  caption: string,
  authorName: string | null | undefined,
  limit: number,
): string {
  const line = photoCreditLine(authorName);
  if (!line) return caption;
  if (caption.includes(line)) return caption;

  const body = caption.trimEnd();
  const candidate = body === "" ? line : `${body}\n\n${line}`;
  return candidate.length <= limit ? candidate : caption;
}
