/**
 * Pure Compose-page logic: limits, timezone conversion, validation and the
 * JSON sent to the posts API. The React component owns only UI state.
 */

import {
  MAX_CAPTION_CHARS,
  MAX_CAPTION_OVERRIDE_CHARS,
  type CarouselMode,
} from "./post-request";
import {
  LINKEDIN_MAX_CAPTION,
  TELEGRAM_MAX_CAPTION,
  TELEGRAM_MAX_TEXT,
} from "./publisher-limits";
import { MAX_CODE_CHARS, MAX_TEXT_CHARS } from "./preview-request";
import type { PlatformStatus } from "./platform-status";

export const COMPOSE_PLATFORMS = ["linkedin", "telegram"] as const;
export const SHARED_CAPTION_LIMIT = MAX_CAPTION_CHARS;
export type ComposePlatform = (typeof COMPOSE_PLATFORMS)[number];
export type ComposeContentType = "text" | "code";
export type ComposeIntent = "draft" | "schedule" | "publish-now";

export type ComposeDraft = {
  /** The caption is the whole post; no slides are rendered or stored. */
  textOnly: boolean;
  text: string;
  contentType: ComposeContentType;
  language: string;
  caption: string;
  carouselMode: CarouselMode;
  scheduleLocal: string;
  targets: Record<ComposePlatform, boolean>;
  captionOverrides: Record<ComposePlatform, string>;
};

export function emptyComposeDraft(): ComposeDraft {
  return {
    textOnly: false,
    text: "",
    contentType: "text",
    language: "",
    caption: "",
    carouselMode: "auto",
    scheduleLocal: "",
    targets: { linkedin: false, telegram: false },
    captionOverrides: { linkedin: "", telegram: "" },
  };
}

export function contentLimit(contentType: ComposeContentType): number {
  return contentType === "code" ? MAX_CODE_CHARS : MAX_TEXT_CHARS;
}

export function captionLimit(platform: ComposePlatform): number {
  return platform === "linkedin" ? LINKEDIN_MAX_CAPTION : TELEGRAM_MAX_TEXT;
}

export function captionNote(platform: ComposePlatform): string {
  return platform === "linkedin"
    ? `${LINKEDIN_MAX_CAPTION.toLocaleString("en-US")} characters max.`
    : `${TELEGRAM_MAX_TEXT.toLocaleString("en-US")} characters max; over ` +
        `${TELEGRAM_MAX_CAPTION.toLocaleString("en-US")} the images are sent first ` +
        "and the caption follows as a separate message.";
}

export function selectedPlatforms(draft: ComposeDraft): ComposePlatform[] {
  return COMPOSE_PLATFORMS.filter((platform) => draft.targets[platform]);
}

/**
 * The caption limit for the whole post. A text-only post is sent as one plain
 * message per platform, so the tightest selected limit applies; with no
 * platform selected the shared API ceiling is the only bound.
 */
export function sharedCaptionLimit(draft: ComposeDraft): number {
  const selected = selectedPlatforms(draft);
  if (selected.length === 0) return SHARED_CAPTION_LIMIT;
  return Math.min(...selected.map(captionLimit), SHARED_CAPTION_LIMIT);
}

export function effectiveCaption(
  draft: ComposeDraft,
  platform: ComposePlatform,
): string {
  const override = draft.captionOverrides[platform];
  return override.trim() === "" ? draft.caption : override;
}

export function captionUsage(
  draft: ComposeDraft,
  platform: ComposePlatform,
): { length: number; limit: number; overLimit: boolean; overrideTooLong: boolean } {
  const override = draft.captionOverrides[platform];
  const length = effectiveCaption(draft, platform).length;
  return {
    length,
    limit: captionLimit(platform),
    overLimit: length > captionLimit(platform),
    overrideTooLong: override.length > MAX_CAPTION_OVERRIDE_CHARS,
  };
}

export type ValidateComposeInput = {
  draft: ComposeDraft;
  statuses: PlatformStatus[];
  timeZone: string;
  now?: Date;
  requireSchedule?: boolean;
};

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: string[]; error: string };

/** Validates everything the Compose page must enforce before a submit. */
export function validateComposeDraft(input: ValidateComposeInput): ValidationResult {
  const { draft, statuses, timeZone } = input;
  const now = input.now ?? new Date();
  const errors: string[] = [];

  // A text-only post has no slide body, so the editor rules do not apply.
  if (!draft.textOnly) {
    if (draft.text.trim() === "") {
      errors.push("Add some text before saving.");
    }
    const textLimit = contentLimit(draft.contentType);
    if (draft.text.length > textLimit) {
      errors.push(
        `The editor is ${draft.text.length.toLocaleString("en-US")} characters; ` +
          `${textLimit.toLocaleString("en-US")} is the ${draft.contentType} limit.`,
      );
    }
  }

  if (draft.caption.trim() === "") {
    errors.push(
      draft.textOnly
        ? "Add the caption: a text-only post is published exactly as written."
        : "Add a caption before saving.",
    );
  }
  if (draft.caption.length > MAX_CAPTION_CHARS) {
    errors.push(
      `The caption is over the ${MAX_CAPTION_CHARS.toLocaleString("en-US")}-character shared limit.`,
    );
  }
  if (draft.textOnly) {
    const limit = sharedCaptionLimit(draft);
    if (draft.caption.length > limit) {
      errors.push(
        `A text-only caption is ${draft.caption.length.toLocaleString("en-US")} ` +
          `characters; the limit for the selected platforms is ` +
          `${limit.toLocaleString("en-US")}.`,
      );
    }
  }

  const targets = selectedPlatforms(draft);
  if (targets.length === 0) {
    errors.push("Choose at least one platform.");
  }

  for (const platform of targets) {
    const status = statuses.find((candidate) => candidate.platform === platform);
    if (!status) {
      errors.push(`${platform} is unavailable right now.`);
      continue;
    }
    if (!status.canPublish) {
      errors.push(
        status.disabledReason ?? `${status.label} cannot publish right now.`,
      );
    }

    const usage = captionUsage(draft, platform);
    if (usage.overrideTooLong) {
      errors.push(
        `${status.label}'s caption override is over the ` +
          `${MAX_CAPTION_OVERRIDE_CHARS.toLocaleString("en-US")}-character API limit.`,
      );
    }
    if (usage.overLimit) {
      errors.push(
        `${status.label}'s caption is ${usage.length.toLocaleString("en-US")} ` +
          `characters; the limit is ${usage.limit.toLocaleString("en-US")}.`,
      );
    }
  }

  if (input.requireSchedule) {
    if (draft.scheduleLocal.trim() === "") {
      errors.push("Choose a date and time to schedule.");
    } else {
      const scheduled = zonedDateTimeToUtc(draft.scheduleLocal, timeZone);
      if (!scheduled) {
        errors.push("That date and time is not valid in the selected timezone.");
      } else if (scheduled.getTime() <= now.getTime()) {
        errors.push("Choose a time in the future.");
      }
    }
  }

  return errors.length === 0
    ? { ok: true }
    : { ok: false, errors, error: errors[0] };
}

export type BuildComposePayloadInput = {
  draft: ComposeDraft;
  intent: ComposeIntent;
  timeZone: string;
  /** False for a PATCH before publish-now, so the current status is kept. */
  includeStatus?: boolean;
};

export type ComposePayload = Record<string, unknown>;

/** Builds the body for POST /api/posts or PATCH /api/posts/[id]. */
export function buildComposePayload(
  input: BuildComposePayloadInput,
): ComposePayload {
  const { draft } = input;
  const scheduledAt =
    input.intent === "schedule"
      ? zonedDateTimeToUtc(draft.scheduleLocal, input.timeZone)
      : null;

  const payload: ComposePayload = {
    text: draft.textOnly ? "" : draft.text,
    text_only: draft.textOnly,
    content_type: draft.contentType,
    code:
      !draft.textOnly && draft.contentType === "code" ? draft.text : null,
    language:
      !draft.textOnly && draft.contentType === "code"
        ? draft.language.trim() || null
        : null,
    caption: draft.caption,
    carousel_mode: draft.textOnly ? "off" : draft.carouselMode,
    source: "manual",
    targets: selectedPlatforms(draft).map((platform) => ({
      platform,
      caption_override:
        draft.captionOverrides[platform].trim() === ""
          ? null
          : draft.captionOverrides[platform],
    })),
  };

  if (input.includeStatus !== false) {
    if (input.intent === "schedule" && scheduledAt) {
      payload.status = "scheduled";
      payload.scheduled_at = scheduledAt.toISOString();
    } else {
      // Publish-now is created as a draft, then immediately made due.
      payload.status = "draft";
      payload.scheduled_at = null;
    }
  }

  return payload;
}

export function draftFingerprint(draft: ComposeDraft): string {
  return JSON.stringify({
    textOnly: draft.textOnly,
    text: draft.text,
    contentType: draft.contentType,
    language: draft.language,
    caption: draft.caption,
    carouselMode: draft.carouselMode,
    scheduleLocal: draft.scheduleLocal,
    targets: COMPOSE_PLATFORMS.map((platform) => draft.targets[platform]),
    overrides: COMPOSE_PLATFORMS.map(
      (platform) => draft.captionOverrides[platform],
    ),
  });
}

const LOCAL_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

type LocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function parseLocal(value: string): LocalParts | null {
  const match = LOCAL_DATE_TIME_PATTERN.exec(value.trim());
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? "0"),
  };
}

function zonedParts(date: Date, timeZone: string): LocalParts | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);

    const values = new Map(parts.map((part) => [part.type, part.value]));
    const number = (key: Intl.DateTimeFormatPartTypes) => {
      const raw = values.get(key);
      return raw === undefined ? Number.NaN : Number(raw);
    };

    const result = {
      year: number("year"),
      month: number("month"),
      day: number("day"),
      hour: number("hour"),
      minute: number("minute"),
      second: number("second"),
    };
    return Object.values(result).every(Number.isFinite) ? result : null;
  } catch {
    return null;
  }
}

function offsetAt(date: Date, timeZone: string): number | null {
  const parts = zonedParts(date, timeZone);
  if (!parts) return null;
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - date.getTime();
}

/**
 * Converts a browser datetime-local value ("YYYY-MM-DDTHH:mm") in `timeZone`
 * to the matching UTC instant. Returns null for malformed or nonexistent
 * local times (for example the skipped hour at a DST jump).
 */
export function zonedDateTimeToUtc(
  localValue: string,
  timeZone: string,
): Date | null {
  const parts = parseLocal(localValue);
  if (!parts) return null;

  const targetAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  let candidate = new Date(targetAsUtc);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offset = offsetAt(candidate, timeZone);
    if (offset === null) return null;
    const next = new Date(targetAsUtc - offset);
    if (next.getTime() === candidate.getTime()) break;
    candidate = next;
  }

  const check = zonedParts(candidate, timeZone);
  if (
    !check ||
    check.year !== parts.year ||
    check.month !== parts.month ||
    check.day !== parts.day ||
    check.hour !== parts.hour ||
    check.minute !== parts.minute ||
    check.second !== parts.second
  ) {
    return null;
  }

  return candidate;
}

/** Converts a UTC instant to the datetime-local value shown in that timezone. */
export function utcToLocalDateTime(
  value: Date | string | null | undefined,
  timeZone: string,
): string {
  if (value === null || value === undefined) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const parts = zonedParts(date, timeZone);
  if (!parts) return "";
  return (
    `${parts.year.toString().padStart(4, "0")}-` +
    `${parts.month.toString().padStart(2, "0")}-` +
    `${parts.day.toString().padStart(2, "0")}T` +
    `${parts.hour.toString().padStart(2, "0")}:` +
    `${parts.minute.toString().padStart(2, "0")}`
  );
}

function shortTimeZone(date: Date, timeZone: string): string {
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "short",
  })
    .formatToParts(date)
    .find((candidate) => candidate.type === "timeZoneName");
  return part?.value ?? timeZone;
}

/** Human-readable label for the chosen timezone and UTC instant. */
export function formatScheduleLabel(
  date: Date,
  timeZone: string,
): string {
  const local = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(date);
  const utc = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
  return `${local} ${shortTimeZone(date, timeZone)} (${utc} UTC)`;
}
