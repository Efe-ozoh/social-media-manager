/**
 * Validation for POST /api/render/preview.
 *
 * Kept separate from the route so the size limits and shape checks can be
 * tested without Next's request object or any rendering.
 */

import type { SplitContentType } from "./splitter";
import { isUnsplashImageUrl } from "./unsplash";

/** Plain posts split into cards; this is far past the 10-slide cap. */
export const MAX_TEXT_CHARS = 12_000;
/** Code is denser, so it gets a larger ceiling. */
export const MAX_CODE_CHARS = 20_000;
/** Whole JSON request body, checked before parsing. */
export const MAX_BODY_BYTES = 64 * 1024;

export const PREVIEW_RATE_LIMIT = 20;
export const PREVIEW_RATE_WINDOW_MS = 10 * 60 * 1000;

const MAX_AUTHOR_CHARS = 120;
const MAX_URL_CHARS = 2_048;

const LANGUAGE_PATTERN = /^[A-Za-z0-9+#._-]{1,40}$/;

export type PreviewBackground = {
  /** Hotlinked Unsplash image, already cropped by imgix. */
  url: string;
  authorName: string | null;
  authorUrl: string | null;
};

export type PreviewRequest = {
  text: string;
  contentType: SplitContentType;
  language: string | null;
  background: PreviewBackground | null;
  usePhotoBehindCode: boolean;
};

export type PreviewParseResult =
  | { ok: true; value: PreviewRequest }
  | { ok: false; status: 400 | 413; error: string };

function fail(status: 400 | 413, error: string): PreviewParseResult {
  return { ok: false, status, error };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, max);
}

/** Validates the json body of a preview request. */
export function parsePreviewRequest(body: unknown): PreviewParseResult {
  const record = asRecord(body);
  if (!record) return fail(400, "Expected a JSON object.");

  const rawType = record.contentType;
  if (rawType !== undefined && rawType !== "text" && rawType !== "code") {
    return fail(400, 'contentType must be "text" or "code".');
  }
  const contentType: SplitContentType = rawType === "code" ? "code" : "text";

  if (typeof record.text !== "string") return fail(400, "text is required.");
  const text = record.text;
  if (text.trim().length === 0) return fail(400, "text is required.");

  const limit = contentType === "code" ? MAX_CODE_CHARS : MAX_TEXT_CHARS;
  if (text.length > limit) {
    return fail(
      413,
      `text is too long: ${limit.toLocaleString("en-US")} characters max for ${contentType}.`,
    );
  }

  let language: string | null = null;
  if (record.language !== undefined && record.language !== null) {
    if (typeof record.language !== "string") {
      return fail(400, "language must be a string.");
    }
    const trimmed = record.language.trim();
    if (trimmed !== "" && !LANGUAGE_PATTERN.test(trimmed)) {
      return fail(400, "language contains unsupported characters.");
    }
    language = trimmed === "" ? null : trimmed;
  }

  let usePhotoBehindCode = false;
  if (record.usePhotoBehindCode !== undefined) {
    if (typeof record.usePhotoBehindCode !== "boolean") {
      return fail(400, "usePhotoBehindCode must be a boolean.");
    }
    usePhotoBehindCode = record.usePhotoBehindCode;
  }

  let background: PreviewBackground | null = null;
  if (record.background !== undefined && record.background !== null) {
    const raw = asRecord(record.background);
    if (!raw) return fail(400, "background must be an object.");

    if (typeof raw.url !== "string") return fail(400, "background.url is required.");
    const url = raw.url.trim();
    if (url.length > MAX_URL_CHARS || !isUnsplashImageUrl(url)) {
      return fail(400, "background.url must be an images.unsplash.com URL.");
    }

    const authorName = optionalText(raw.authorName, MAX_AUTHOR_CHARS);
    if (authorName === undefined) return fail(400, "background.authorName must be a string.");

    const authorUrl = optionalText(raw.authorUrl, MAX_URL_CHARS);
    if (authorUrl === undefined) return fail(400, "background.authorUrl must be a string.");
    if (authorUrl !== null && !isUnsplashProfileUrl(authorUrl)) {
      return fail(400, "background.authorUrl must link to an Unsplash profile.");
    }

    background = { url, authorName, authorUrl };
  }

  return {
    ok: true,
    value: { text, contentType, language, background, usePhotoBehindCode },
  };
}

function isUnsplashProfileUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "unsplash.com" || url.hostname.endsWith(".unsplash.com"))
    );
  } catch {
    return false;
  }
}
