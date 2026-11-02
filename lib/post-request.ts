/**
 * Validation for the posts API — POST /api/posts and PATCH /api/posts/[id].
 *
 * Kept out of the route handlers for the same reason as preview-request.ts: the
 * shape and size checks are pure, so they can be tested without a database or
 * a request object.
 *
 * Two rules from the scope change are enforced here, not in the UI:
 *   - Only schedulable platforms (LinkedIn and Telegram) may be targets.
 *   - Facebook and Instagram are manual-export platforms and are rejected with
 *     an explicit message rather than silently dropped.
 */

import {
  MAX_CODE_CHARS,
  MAX_TEXT_CHARS,
} from "./preview-request";
import {
  PLATFORM_NAMES,
  schedulablePlatforms,
  type PlatformName,
} from "./platforms";
import type { SplitContentType } from "./splitter";
import { isUnsplashImageUrl } from "./unsplash";

export const MAX_CAPTION_CHARS = 4_096;
export const MAX_CAPTION_OVERRIDE_CHARS = 4_096;
export const MAX_TITLE_CHARS = 200;
export const MAX_THEME_CHARS = 50;
export const MAX_AI_PROMPT_CHARS = 4_000;
export const MAX_QUERY_CHARS = 120;
export const MAX_URL_CHARS = 2_048;
export const MAX_AUTHOR_CHARS = 120;

const LANGUAGE_PATTERN = /^[A-Za-z0-9+#._-]{1,40}$/;

export type BackgroundMode = "solid" | "unsplash";
export type CarouselMode = "auto" | "on" | "off";
export type PostSource = "manual" | "ai";
export type PostStatus = "draft" | "scheduled";

export type PostTargetInput = {
  platform: PlatformName;
  captionOverride: string | null;
};

/** Every bg_* column of a post, normalised into one object. */
export type PostBackgroundInput = {
  backgroundMode: BackgroundMode;
  backgroundQuery: string | null;
  bgUnsplashId: string | null;
  bgUrl: string | null;
  bgThumbUrl: string | null;
  bgAuthorName: string | null;
  bgAuthorUrl: string | null;
  bgColor: string | null;
};

export type PostCreateInput = {
  title: string | null;
  bodyText: string;
  contentType: SplitContentType;
  code: string | null;
  language: string | null;
  theme: string;
  caption: string;
  carouselMode: CarouselMode;
  source: PostSource;
  aiPrompt: string | null;
  status: PostStatus;
  scheduledAt: Date | null;
  background: PostBackgroundInput;
  targets: PostTargetInput[];
};

export type PostUpdateInput = {
  title?: string | null;
  bodyText?: string;
  contentType?: SplitContentType;
  code?: string | null;
  language?: string | null;
  theme?: string;
  caption?: string;
  carouselMode?: CarouselMode;
  source?: PostSource;
  aiPrompt?: string | null;
  status?: PostStatus;
  scheduledAt?: Date | null;
  background?: PostBackgroundInput;
  targets?: PostTargetInput[];
};

export type PostParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 413; error: string };

export type ParseOptions = {
  now?: Date;
  env?: Record<string, string | undefined>;
};

export type UpdateParseOptions = ParseOptions & {
  currentContentType?: SplitContentType;
  currentScheduledAt?: Date | null;
};

function fail<T>(status: 400 | 413, error: string): PostParseResult<T> {
  return { ok: false, status, error };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function has(record: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(record, key));
}

function pick(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  }
  return undefined;
}

function optionalString(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed.slice(0, max);
}

function parseContentType(value: unknown): SplitContentType | undefined {
  if (value === undefined) return undefined;
  return value === "text" || value === "code" ? value : undefined;
}

function parseLanguage(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return LANGUAGE_PATTERN.test(trimmed) && trimmed.length <= 40 ? trimmed : undefined;
}

function parseCarouselMode(value: unknown): CarouselMode | undefined {
  if (value === undefined) return undefined;
  return value === "auto" || value === "on" || value === "off" ? value : undefined;
}

function parseSource(value: unknown): PostSource | undefined {
  if (value === undefined) return undefined;
  return value === "manual" || value === "ai" ? value : undefined;
}

function parsePostStatus(value: unknown): PostStatus | undefined {
  if (value === undefined) return undefined;
  return value === "draft" || value === "scheduled" ? value : undefined;
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

/** Parses an ISO timestamp that carries an explicit UTC offset. */
export function parseScheduledAt(
  value: unknown,
  now: Date = new Date(),
): { ok: true; value: Date | null } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") {
    return { ok: true, value: null };
  }
  if (typeof value !== "string") {
    return { ok: false, error: "scheduled_at must be an ISO timestamp string." };
  }

  const trimmed = value.trim();
  if (!/(?:z|[+-]\d{2}:\d{2})$/i.test(trimmed)) {
    return {
      ok: false,
      error: "scheduled_at must include a UTC timezone (for example 2026-01-31T12:00:00Z).",
    };
  }

  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    return { ok: false, error: "scheduled_at is not a valid date." };
  }
  if (date.getTime() <= now.getTime()) {
    return { ok: false, error: "scheduled_at must be in the future." };
  }

  return { ok: true, value: date };
}

function parseBackground(
  record: Record<string, unknown>,
): PostBackgroundInput | { error: string; status: 400 | 413 } {
  const nested = asRecord(record.background);
  const get = (...keys: string[]) => {
    const nestedValue = nested ? pick(nested, ...keys) : undefined;
    return nestedValue !== undefined ? nestedValue : pick(record, ...keys);
  };

  const rawMode = get("mode", "background_mode", "backgroundMode");
  const rawUrl = get("url", "bg_url", "bgUrl");
  const mode: BackgroundMode | undefined =
    rawMode === undefined
      ? rawUrl
        ? "unsplash"
        : "solid"
      : rawMode === "solid" || rawMode === "unsplash"
        ? rawMode
        : undefined;
  if (!mode) {
    return { status: 400, error: 'background.mode must be "solid" or "unsplash".' };
  }

  if (mode === "solid") {
    return {
      backgroundMode: "solid",
      backgroundQuery: null,
      bgUnsplashId: null,
      bgUrl: null,
      bgThumbUrl: null,
      bgAuthorName: null,
      bgAuthorUrl: null,
      bgColor: null,
    };
  }

  if (typeof rawUrl !== "string" || !isUnsplashImageUrl(rawUrl.trim())) {
    return {
      status: 400,
      error: "background.url must be an images.unsplash.com URL.",
    };
  }

  const rawThumb = get("thumbUrl", "bg_thumb_url", "bgThumbUrl");
  if (
    rawThumb !== undefined &&
    rawThumb !== null &&
    (typeof rawThumb !== "string" || !isUnsplashImageUrl(rawThumb.trim()))
  ) {
    return {
      status: 400,
      error: "background.thumbUrl must be an images.unsplash.com URL.",
    };
  }

  const rawAuthorUrl = get("authorUrl", "bg_author_url", "bgAuthorUrl");
  if (
    rawAuthorUrl !== undefined &&
    rawAuthorUrl !== null &&
    (typeof rawAuthorUrl !== "string" || !isUnsplashProfileUrl(rawAuthorUrl.trim()))
  ) {
    return {
      status: 400,
      error: "background.authorUrl must link to an Unsplash profile.",
    };
  }

  const authorName = optionalString(get("authorName", "bg_author_name", "bgAuthorName"), MAX_AUTHOR_CHARS);
  if (authorName === undefined) {
    return { status: 400, error: "background.authorName must be a string." };
  }

  const query = optionalString(get("query", "background_query", "backgroundQuery"), MAX_QUERY_CHARS);
  if (query === undefined) {
    return { status: 400, error: "background.query must be a string." };
  }

  const unsplashId = optionalString(get("unsplashId", "bg_unsplash_id", "bgUnsplashId"), 64);
  if (unsplashId === undefined) {
    return { status: 400, error: "background.unsplashId must be a string." };
  }

  const color = optionalString(get("color", "bg_color", "bgColor"), 16);
  if (color === undefined) {
    return { status: 400, error: "background.color must be a string." };
  }

  return {
    backgroundMode: "unsplash",
    backgroundQuery: query,
    bgUnsplashId: unsplashId,
    bgUrl: rawUrl.trim().slice(0, MAX_URL_CHARS),
    bgThumbUrl: typeof rawThumb === "string" ? rawThumb.trim().slice(0, MAX_URL_CHARS) : null,
    bgAuthorName: authorName,
    bgAuthorUrl:
      typeof rawAuthorUrl === "string" ? rawAuthorUrl.trim().slice(0, MAX_URL_CHARS) : null,
    bgColor: color,
  };
}

function parseTargets(
  value: unknown,
  env: Record<string, string | undefined>,
): PostTargetInput[] | { error: string; status: 400 | 413 } {
  if (!Array.isArray(value)) {
    return { status: 400, error: "targets must be an array of platforms." };
  }
  if (value.length === 0) {
    return { status: 400, error: "At least one target platform is required." };
  }
  if (value.length > PLATFORM_NAMES.length) {
    return { status: 400, error: "Too many target platforms." };
  }

  const allowed = new Set(schedulablePlatforms(env));
  const seen = new Set<PlatformName>();
  const targets: PostTargetInput[] = [];

  for (const item of value) {
    const record = asRecord(item);
    const rawPlatform = record ? pick(record, "platform") : item;
    if (typeof rawPlatform !== "string") {
      return { status: 400, error: "Each target must be a platform name or an object." };
    }

    const platform = rawPlatform.trim().toLowerCase() as PlatformName;
    if (!PLATFORM_NAMES.includes(platform)) {
      return { status: 400, error: `Unknown platform: ${rawPlatform}.` };
    }
    if (!allowed.has(platform)) {
      return {
        status: 400,
        error: `${platform} is a manual-export platform and cannot be scheduled. Post it by hand from the export instead.`,
      };
    }
    if (seen.has(platform)) {
      return { status: 400, error: `${platform} is listed more than once.` };
    }
    seen.add(platform);

    const rawOverride = record ? pick(record, "caption_override", "captionOverride", "caption") : undefined;
    const captionOverride = typeof rawOverride === "string" ? rawOverride.trim() : null;
    if (captionOverride !== null && captionOverride.length > MAX_CAPTION_OVERRIDE_CHARS) {
      return {
        status: 413,
        error: `A caption override is too long (${MAX_CAPTION_OVERRIDE_CHARS} characters max).`,
      };
    }

    targets.push({
      platform,
      captionOverride: captionOverride === "" ? null : captionOverride,
    });
  }

  return targets;
}

/** Validates the body of POST /api/posts. */
export function parsePostCreate(
  body: unknown,
  options: ParseOptions = {},
): PostParseResult<PostCreateInput> {
  const record = asRecord(body);
  if (!record) return fail(400, "Expected a JSON object.");

  const rawText = pick(record, "text", "body_text", "bodyText");
  if (typeof rawText !== "string") return fail(400, "text is required.");
  const bodyText = rawText;

  const rawContentType = pick(record, "content_type", "contentType");
  if (rawContentType !== undefined && rawContentType !== "text" && rawContentType !== "code") {
    return fail(400, 'content_type must be "text" or "code".');
  }
  const contentType: SplitContentType = rawContentType === "code" ? "code" : "text";

  const textLimit = contentType === "code" ? MAX_CODE_CHARS : MAX_TEXT_CHARS;
  if (bodyText.trim().length === 0) return fail(400, "text is required.");
  if (bodyText.length > textLimit) {
    return fail(
      413,
      `text is too long: ${textLimit.toLocaleString("en-US")} characters max for ${contentType}.`,
    );
  }

  const rawCode = pick(record, "code");
  if (rawCode !== undefined && rawCode !== null && typeof rawCode !== "string") {
    return fail(400, "code must be a string.");
  }
  const code = typeof rawCode === "string" ? rawCode : null;
  if (code !== null && code.length > MAX_CODE_CHARS) {
    return fail(413, `code is too long: ${MAX_CODE_CHARS.toLocaleString("en-US")} characters max.`);
  }

  const language = parseLanguage(pick(record, "language"));
  if (language === undefined) return fail(400, "language contains unsupported characters.");

  const rawCaption = pick(record, "caption");
  if (typeof rawCaption !== "string") return fail(400, "caption is required.");
  const caption = rawCaption;
  if (caption.trim().length === 0) return fail(400, "caption is required.");
  if (caption.length > MAX_CAPTION_CHARS) {
    return fail(413, `caption is too long: ${MAX_CAPTION_CHARS.toLocaleString("en-US")} characters max.`);
  }

  const rawTitle = pick(record, "title");
  if (rawTitle !== undefined && rawTitle !== null && typeof rawTitle !== "string") {
    return fail(400, "title must be a string.");
  }
  const title = optionalString(rawTitle, MAX_TITLE_CHARS);
  if (title === undefined) return fail(400, "title must be a string.");

  const rawTheme = pick(record, "theme");
  if (rawTheme !== undefined && rawTheme !== null && typeof rawTheme !== "string") {
    return fail(400, "theme must be a string.");
  }
  const theme = optionalString(rawTheme, MAX_THEME_CHARS) ?? "default";

  const carouselMode = parseCarouselMode(pick(record, "carousel_mode", "carouselMode")) ?? "auto";
  if (
    pick(record, "carousel_mode", "carouselMode") !== undefined &&
    parseCarouselMode(pick(record, "carousel_mode", "carouselMode")) === undefined
  ) {
    return fail(400, 'carousel_mode must be "auto", "on" or "off".');
  }

  const source = parseSource(pick(record, "source")) ?? "manual";
  if (pick(record, "source") !== undefined && parseSource(pick(record, "source")) === undefined) {
    return fail(400, 'source must be "manual" or "ai".');
  }

  const aiPrompt = optionalString(pick(record, "ai_prompt", "aiPrompt"), MAX_AI_PROMPT_CHARS);
  if (aiPrompt === undefined) return fail(400, "ai_prompt must be a string.");

  const rawStatus = pick(record, "status");
  if (rawStatus !== undefined && parsePostStatus(rawStatus) === undefined) {
    return fail(400, 'status must be "draft" or "scheduled".');
  }
  const status = parsePostStatus(rawStatus);

  const parsedScheduledAt = parseScheduledAt(
    pick(record, "scheduled_at", "scheduledAt"),
    options.now ?? new Date(),
  );
  if (!parsedScheduledAt.ok) return fail(400, parsedScheduledAt.error);
  const scheduledAt = parsedScheduledAt.value;

  if (status === "draft" && scheduledAt !== null) {
    return fail(400, "A draft cannot have scheduled_at; use status scheduled.");
  }
  if (status === "scheduled" && scheduledAt === null) {
    return fail(400, "scheduled_at is required when status is scheduled.");
  }
  const finalStatus: PostStatus =
    status ?? (scheduledAt !== null ? "scheduled" : "draft");

  const background = parseBackground(record);
  if ("error" in background) return fail(background.status, background.error);

  const targets = parseTargets(pick(record, "targets"), options.env ?? process.env);
  if (!Array.isArray(targets)) return fail(targets.status, targets.error);

  return {
    ok: true,
    value: {
      title,
      bodyText,
      contentType,
      code,
      language,
      theme,
      caption,
      carouselMode,
      source,
      aiPrompt,
      status: finalStatus,
      scheduledAt,
      background,
      targets,
    },
  };
}

/** Validates a partial body for PATCH /api/posts/[id]. */
export function parsePostUpdate(
  body: unknown,
  options: UpdateParseOptions = {},
): PostParseResult<PostUpdateInput> {
  const record = asRecord(body);
  if (!record) return fail(400, "Expected a JSON object.");

  const update: PostUpdateInput = {};

  if (has(record, "text", "body_text", "bodyText")) {
    const rawText = pick(record, "text", "body_text", "bodyText");
    if (typeof rawText !== "string") return fail(400, "text must be a string.");
    update.bodyText = rawText;
  }

  if (has(record, "content_type", "contentType")) {
    const contentType = parseContentType(pick(record, "content_type", "contentType"));
    if (!contentType) return fail(400, 'content_type must be "text" or "code".');
    update.contentType = contentType;
  }

  const effectiveContentType =
    update.contentType ?? options.currentContentType ?? "text";
  if (update.bodyText !== undefined) {
    if (update.bodyText.trim().length === 0) return fail(400, "text is required.");
    const limit = effectiveContentType === "code" ? MAX_CODE_CHARS : MAX_TEXT_CHARS;
    if (update.bodyText.length > limit) {
      return fail(
        413,
        `text is too long: ${limit.toLocaleString("en-US")} characters max for ${effectiveContentType}.`,
      );
    }
  }

  if (has(record, "code")) {
    const rawCode = pick(record, "code");
    if (rawCode !== null && typeof rawCode !== "string") {
      return fail(400, "code must be a string.");
    }
    update.code = typeof rawCode === "string" ? rawCode : null;
    if (update.code !== null && update.code.length > MAX_CODE_CHARS) {
      return fail(413, `code is too long: ${MAX_CODE_CHARS.toLocaleString("en-US")} characters max.`);
    }
  }

  if (has(record, "language")) {
    const language = parseLanguage(pick(record, "language"));
    if (language === undefined) return fail(400, "language contains unsupported characters.");
    update.language = language;
  }

  if (has(record, "caption")) {
    const rawCaption = pick(record, "caption");
    if (typeof rawCaption !== "string") return fail(400, "caption must be a string.");
    if (rawCaption.trim().length === 0) return fail(400, "caption is required.");
    if (rawCaption.length > MAX_CAPTION_CHARS) {
      return fail(413, `caption is too long: ${MAX_CAPTION_CHARS.toLocaleString("en-US")} characters max.`);
    }
    update.caption = rawCaption;
  }

  if (has(record, "title")) {
    const title = optionalString(pick(record, "title"), MAX_TITLE_CHARS);
    if (title === undefined) return fail(400, "title must be a string.");
    update.title = title;
  }

  if (has(record, "theme")) {
    const theme = optionalString(pick(record, "theme"), MAX_THEME_CHARS);
    if (theme === undefined) return fail(400, "theme must be a string.");
    update.theme = theme ?? "default";
  }

  if (has(record, "carousel_mode", "carouselMode")) {
    const mode = parseCarouselMode(pick(record, "carousel_mode", "carouselMode"));
    if (!mode) return fail(400, 'carousel_mode must be "auto", "on" or "off".');
    update.carouselMode = mode;
  }

  if (has(record, "source")) {
    const source = parseSource(pick(record, "source"));
    if (!source) return fail(400, 'source must be "manual" or "ai".');
    update.source = source;
  }

  if (has(record, "ai_prompt", "aiPrompt")) {
    const aiPrompt = optionalString(pick(record, "ai_prompt", "aiPrompt"), MAX_AI_PROMPT_CHARS);
    if (aiPrompt === undefined) return fail(400, "ai_prompt must be a string.");
    update.aiPrompt = aiPrompt;
  }

  if (has(record, "status")) {
    const status = parsePostStatus(pick(record, "status"));
    if (!status) return fail(400, 'status must be "draft" or "scheduled".');
    update.status = status;
  }

  const hasScheduledAt = has(record, "scheduled_at", "scheduledAt");
  if (hasScheduledAt) {
    const parsed = parseScheduledAt(
      pick(record, "scheduled_at", "scheduledAt"),
      options.now ?? new Date(),
    );
    if (!parsed.ok) return fail(400, parsed.error);
    update.scheduledAt = parsed.value;
  }

  const effectiveScheduledAt = hasScheduledAt
    ? update.scheduledAt ?? null
    : options.currentScheduledAt ?? null;

  if (update.status === "scheduled" && effectiveScheduledAt === null) {
    return fail(400, "scheduled_at is required when status is scheduled.");
  }
  if (update.status === "draft") {
    if (hasScheduledAt && update.scheduledAt !== null) {
      return fail(400, "A draft cannot have scheduled_at; clear scheduled_at or use status scheduled.");
    }
    // Turning a scheduled post back into a draft clears its schedule.
    update.scheduledAt = null;
  }
  if (update.status === undefined && hasScheduledAt) {
    update.status = update.scheduledAt ? "scheduled" : "draft";
    if (update.status === "draft") update.scheduledAt = null;
  }

  if (has(record, "background") || has(record, "background_mode", "backgroundMode", "bg_url", "bgUrl")) {
    const background = parseBackground(record);
    if ("error" in background) return fail(background.status, background.error);
    update.background = background;
  }

  if (has(record, "targets")) {
    const targets = parseTargets(pick(record, "targets"), options.env ?? process.env);
    if (!Array.isArray(targets)) return fail(targets.status, targets.error);
    update.targets = targets;
  }

  if (Object.keys(update).length === 0) {
    return fail(400, "No editable fields were provided.");
  }

  return { ok: true, value: update };
}

/** True when one of the fields a render depends on is being changed. */
export function changesRenderedContent(update: PostUpdateInput): boolean {
  return (
    update.bodyText !== undefined ||
    update.contentType !== undefined ||
    update.code !== undefined ||
    update.language !== undefined ||
    update.background !== undefined
  );
}
