/**
 * Unsplash background photos — Phase 2b.
 *
 * Follows Unsplash's API guidelines (help.unsplash.com):
 *
 *  - Hotlinking: image bytes always come from the API's own imgix URLs. Only
 *    supported resize/crop parameters are added, and the original `ixid` is
 *    preserved. Nothing is re-hosted.
 *  - Attribution: each photo carries "Photo by {name} on Unsplash", with the
 *    photographer linked to their Unsplash profile plus the required
 *    utm_source / utm_medium=referral parameters.
 *  - Download tracking: `trackDownload()` calls a photo's
 *    `links.download_location` only when the photo is actually chosen for a
 *    post. Search and preview never call it — those are views, which the
 *    hotlinked image request already tracks.
 *  - Rate limits: `X-Ratelimit-Limit` / `X-Ratelimit-Remaining` are read on
 *    every response; once remaining hits 0 the client stops calling out.
 *
 * Every failure path returns an empty result with an `error` string. Nothing
 * in this module throws, so callers can always fall back to a solid slide.
 */

const API_BASE = "https://api.unsplash.com";
const SEARCH_ENDPOINT = `${API_BASE}/search/photos`;

/** App name used as utm_source on every link back to Unsplash. */
export const UNSPLASH_APP_NAME = "codesync_hub";

/** SPEC: the picker shows 6 portrait results. */
export const UNSPLASH_RESULTS_PER_PAGE = 6;

/** Slide size; the imgix URLs are requested already cropped to it. */
export const BACKGROUND_WIDTH = 1080;
export const BACKGROUND_HEIGHT = 1350;

const THUMB_WIDTH = 360;
const THUMB_HEIGHT = 450;

const FETCH_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 40;

/** Unsplash serves originals from images.unsplash.com; Unsplash+ from plus. */
const UNSPLASH_IMAGE_HOSTS = new Set(["images.unsplash.com", "plus.unsplash.com"]);

export type UnsplashPhoto = {
  id: string;
  description: string | null;
  /** Average colour, used as the picker placeholder and the fallback tint. */
  color: string | null;
  width: number;
  height: number;
  /** Hotlinked URL, already cropped to 1080 x 1350. */
  url: string;
  /** Same crop, small enough for a picker grid. */
  thumbUrl: string;
  authorName: string;
  /** Photographer profile, with the required UTM parameters. */
  authorUrl: string;
  /** Ready-to-render credit line: "Photo by {name} on Unsplash". */
  attribution: string;
  /** Photo page on Unsplash, with UTM parameters. */
  pageUrl: string;
  /**
   * Endpoint to ping when this photo is used. Never call it for search or
   * preview results (see the module comment).
   */
  downloadLocation: string;
};

export type UnsplashRateLimit = {
  limit: number | null;
  remaining: number | null;
};

export type BackgroundSearchResult = {
  photos: UnsplashPhoto[];
  /** null when the search succeeded; a human-readable reason otherwise. */
  error: string | null;
  /** True when the result came from the in-memory cache. */
  cached: boolean;
  rateLimit: UnsplashRateLimit;
};

type CacheEntry = { at: number; photos: UnsplashPhoto[] };

const searchCache = new Map<string, CacheEntry>();
let lastRateLimit: UnsplashRateLimit = { limit: null, remaining: null };

/** The configured Unsplash access key, or null when backgrounds are disabled. */
export function getUnsplashAccessKey(): string | null {
  const key = process.env.UNSPLASH_ACCESS_KEY?.trim();
  return key ? key : null;
}

export function hasUnsplashAccessKey(): boolean {
  return getUnsplashAccessKey() !== null;
}

/** The most recent rate-limit headers seen (for the dashboard/status UI). */
export function getUnsplashRateLimit(): UnsplashRateLimit {
  return lastRateLimit;
}

/**
 * Searches portrait photos for a slide background. Returns at most
 * `perPage` (default 6) already-cropped 1080 x 1350 candidates.
 */
export async function searchPortraitPhotos(
  query: string,
  perPage: number = UNSPLASH_RESULTS_PER_PAGE,
): Promise<BackgroundSearchResult> {
  const text = query.trim().slice(0, 120);
  const key = getUnsplashAccessKey();
  const empty = (error: string, cached = false): BackgroundSearchResult => ({
    photos: [],
    error,
    cached,
    rateLimit: lastRateLimit,
  });

  if (text.length < 2) return empty("Enter at least 2 characters to search.");
  if (!key) {
    return empty(
      "UNSPLASH_ACCESS_KEY is not set, so only solid backgrounds are available.",
    );
  }
  // The hourly budget is gone: do not spend a request to learn that again.
  if (lastRateLimit.remaining !== null && lastRateLimit.remaining <= 0) {
    return empty(
      "Unsplash's hourly request limit is used up. Solid backgrounds still work.",
    );
  }

  const cacheKey = `${text.toLowerCase()}|${perPage}`;
  const hit = searchCache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { photos: hit.photos, error: null, cached: true, rateLimit: lastRateLimit };
  }

  const url = new URL(SEARCH_ENDPOINT);
  url.searchParams.set("query", text);
  // SPEC: portrait orientation, so the 4:5 crop loses as little as possible.
  url.searchParams.set("orientation", "portrait");
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("content_filter", "high");

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Client-ID ${key}`,
        "Accept-Version": "v1",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    });

    lastRateLimit = readRateLimit(response.headers);

    if (!response.ok) {
      if (response.status === 401) {
        return empty("Unsplash rejected the access key. Check UNSPLASH_ACCESS_KEY.");
      }
      if (response.status === 403 || response.status === 429) {
        return empty(
          "Unsplash's request limit was reached. Try again later, or keep the solid background.",
        );
      }
      return empty(`Unsplash search failed (HTTP ${response.status}).`);
    }

    const payload = (await response.json()) as { results?: unknown };
    const results = Array.isArray(payload.results) ? payload.results : [];
    const photos = results
      .map(normalizePhoto)
      .filter((photo): photo is UnsplashPhoto => photo !== null);

    remember(cacheKey, photos);
    return { photos, error: null, cached: false, rateLimit: lastRateLimit };
  } catch {
    // Network error, timeout, or malformed JSON.
    return empty("Could not reach Unsplash. Using a solid background instead.");
  }
}

/**
 * Downloads a hotlinked photo for rendering. Returns null on any failure so
 * the renderer can fall back to the solid theme.
 */
export async function fetchBackgroundImage(url: string): Promise<Buffer | null> {
  if (!isUnsplashImageUrl(url)) return null;

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) return null;
    if (!(response.headers.get("content-type") ?? "").startsWith("image/")) return null;

    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.length > 0 ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Tracks a download, as Unsplash requires once a photo is actually used.
 * Call this from the moment the owner picks a photo for a post — never from
 * search results or a preview. Fire-and-forget: failures are swallowed.
 */
export async function trackDownload(downloadLocation: string): Promise<boolean> {
  const key = getUnsplashAccessKey();
  if (!key || !downloadLocation) return false;

  try {
    const url = new URL(downloadLocation);
    if (url.protocol !== "https:" || url.hostname !== "api.unsplash.com") return false;
    // Preserve existing parameters (such as ixid) and authenticate with the key.
    url.searchParams.set("client_id", key);

    const response = await fetch(url, {
      headers: { "Accept-Version": "v1" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** True for https URLs on Unsplash's own image hosts (SSRF guard). */
export function isUnsplashImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && UNSPLASH_IMAGE_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Adds imgix resize/crop parameters to an Unsplash `urls.raw` URL. This is the
 * supported way to ask for a given size; the photo is still hotlinked.
 */
export function croppedImageUrl(
  rawUrl: string,
  width: number,
  height: number,
): string | null {
  if (!isUnsplashImageUrl(rawUrl)) return null;

  try {
    const url = new URL(rawUrl);
    url.searchParams.set("w", String(Math.round(width)));
    url.searchParams.set("h", String(Math.round(height)));
    url.searchParams.set("fit", "crop");
    url.searchParams.set("crop", "entropy");
    url.searchParams.set("fm", "jpg");
    url.searchParams.set("q", "80");
    return url.toString();
  } catch {
    return null;
  }
}

/** Reads Unsplash's rate-limit headers. */
export function readRateLimit(headers: Headers): UnsplashRateLimit {
  return {
    limit: toInt(headers.get("x-ratelimit-limit")),
    remaining: toInt(headers.get("x-ratelimit-remaining")),
  };
}

function toInt(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function remember(cacheKey: string, photos: UnsplashPhoto[]): void {
  // Re-inserting refreshes recency, so the oldest key is evicted first.
  searchCache.delete(cacheKey);
  searchCache.set(cacheKey, { at: Date.now(), photos });

  while (searchCache.size > CACHE_MAX_ENTRIES) {
    const oldest = searchCache.keys().next().value;
    if (oldest === undefined) break;
    searchCache.delete(oldest);
  }
}

function normalizePhoto(raw: unknown): UnsplashPhoto | null {
  const photo = asRecord(raw);
  if (!photo) return null;

  const id = asString(photo.id);
  const rawUrl = asString(asRecord(photo.urls)?.raw);
  const user = asRecord(photo.user);
  const name = asString(user?.name) ?? asString(user?.username);
  const profile = asString(asRecord(user?.links)?.html);
  const downloadLocation = asString(asRecord(photo.links)?.download_location);

  // Attribution is mandatory, so a photo missing its credit is unusable.
  if (!id || !rawUrl || !name || !profile || !downloadLocation) return null;

  const url = croppedImageUrl(rawUrl, BACKGROUND_WIDTH, BACKGROUND_HEIGHT);
  const thumbUrl = croppedImageUrl(rawUrl, THUMB_WIDTH, THUMB_HEIGHT);
  if (!url || !thumbUrl) return null;

  const profileWithUtm = withUtm(profile);
  const pageUrl = asString(asRecord(photo.links)?.html);

  return {
    id,
    description: asString(photo.description) ?? asString(photo.alt),
    color: asString(photo.color),
    width: Math.round(asNumber(photo.width) ?? BACKGROUND_WIDTH),
    height: Math.round(asNumber(photo.height) ?? BACKGROUND_HEIGHT),
    url,
    thumbUrl,
    authorName: name,
    authorUrl: profileWithUtm,
    attribution: `Photo by ${name} on Unsplash`,
    pageUrl: pageUrl ? withUtm(pageUrl) : profileWithUtm,
    downloadLocation,
  };
}

function withUtm(link: string): string {
  try {
    const url = new URL(link);
    url.searchParams.set("utm_source", UNSPLASH_APP_NAME);
    url.searchParams.set("utm_medium", "referral");
    return url.toString();
  } catch {
    return link;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
