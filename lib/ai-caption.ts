/**
 * Caption helpers shared by the AI API and the Compose page.
 *
 * These use the real publisher limits and stay free of network/environment
 * imports so the client bundle can safely reuse them.
 */

import {
  FACEBOOK_MAX_CAPTION,
  INSTAGRAM_MAX_CAPTION,
  LINKEDIN_MAX_CAPTION,
  TELEGRAM_MAX_TEXT,
} from "./publisher-limits";
import { MAX_AI_HASHTAGS, type AiPlatform } from "./ai-types";

export const AI_PLATFORM_CAPTION_LIMITS: Record<AiPlatform, number> = {
  linkedin: LINKEDIN_MAX_CAPTION,
  telegram: TELEGRAM_MAX_TEXT,
  facebook: FACEBOOK_MAX_CAPTION,
  instagram: INSTAGRAM_MAX_CAPTION,
};

/** Normalises model output into unique, safe #hashtags. */
export function normalizeHashtags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const raw = item.trim().replace(/^#+/, "").replace(/\s+/g, "");
    if (raw === "" || !/^[A-Za-z0-9_]+$/.test(raw)) continue;
    const tag = `#${raw}`;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length >= MAX_AI_HASHTAGS) break;
  }
  return tags;
}

/**
 * Appends as many hashtags as fit under the platform limit. The text keeps its
 * own line; if no tag fits, the caption is returned without them rather than
 * growing past a publisher's hard limit.
 */
export function captionWithHashtags(
  caption: string,
  hashtags: readonly string[],
  limit: number,
): string {
  const base = caption.trim();
  const boundedBase = base.length > limit ? base.slice(0, limit) : base;
  if (hashtags.length === 0) return boundedBase;

  const separator = boundedBase === "" ? 0 : 2;
  let available = limit - boundedBase.length - separator;
  if (available <= 0) return boundedBase;

  const selected: string[] = [];
  for (const raw of hashtags) {
    const tag = raw.trim();
    if (tag === "") continue;
    const cost = tag.length + (selected.length > 0 ? 1 : 0);
    if (cost > available) continue;
    selected.push(tag);
    available -= cost;
  }

  if (selected.length === 0) return boundedBase;
  return boundedBase === ""
    ? selected.join(" ")
    : `${boundedBase}\n\n${selected.join(" ")}`;
}
