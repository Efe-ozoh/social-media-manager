/**
 * Validation for POST /api/generate and POST /api/convert.
 *
 * Pure, so the shape/size rules are tested without a model, a database or a
 * Next request. Nothing here reads the environment or the network.
 */

import { MAX_CODE_CHARS } from "./preview-request";
import { MAX_AI_PROMPT_CHARS } from "./post-request";
import {
  AI_CONTENT_TYPES,
  AI_PLATFORMS,
  CONVERT_MODES,
  type AiContentType,
  type AiPlatform,
  type ConvertMode,
  type ConvertRequest,
  type GenerateRequest,
} from "./ai-types";

export const MAX_TONE_CHARS = 40;
const TONE_PATTERN = /^[A-Za-z][A-Za-z0-9 ,'&/+.-]{0,39}$/;

/** Kept in sync with the Compose language selector. */
export const SUPPORTED_LANGUAGES = new Set([
  "javascript",
  "typescript",
  "python",
  "java",
  "go",
  "rust",
  "csharp",
  "cpp",
  "sql",
  "bash",
  "json",
  "yaml",
  "html",
  "css",
  "php",
  "ruby",
  "swift",
  "kotlin",
]);

export type AiParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 413; error: string };

function fail<T>(status: 400 | 413, error: string): AiParseResult<T> {
  return { ok: false, status, error };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Returns the canonical language name, or null when it is not allowlisted. */
export function normalizeLanguage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const language = value.trim().toLowerCase();
  return SUPPORTED_LANGUAGES.has(language) ? language : null;
}

function parseContentType(value: unknown): AiContentType | undefined {
  if (value === undefined || value === null) return "auto";
  return typeof value === "string" &&
    (AI_CONTENT_TYPES as readonly string[]).includes(value)
    ? (value as AiContentType)
    : undefined;
}

function parseTone(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const tone = value.trim();
  if (tone === "") return null;
  return tone.length <= MAX_TONE_CHARS && TONE_PATTERN.test(tone) ? tone : undefined;
}

function parsePlatforms(value: unknown): AiPlatform[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > AI_PLATFORMS.length) return undefined;

  const seen = new Set<AiPlatform>();
  const platforms: AiPlatform[] = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    const platform = item.trim().toLowerCase();
    if (!(AI_PLATFORMS as readonly string[]).includes(platform)) return undefined;
    const typed = platform as AiPlatform;
    if (seen.has(typed)) continue;
    seen.add(typed);
    platforms.push(typed);
  }
  return platforms;
}

/** Validates the body of POST /api/generate. */
export function parseGenerateRequest(body: unknown): AiParseResult<GenerateRequest> {
  const record = asRecord(body);
  if (!record) return fail(400, "Expected a JSON object.");

  if (typeof record.prompt !== "string") return fail(400, "prompt is required.");
  const prompt = record.prompt.trim();
  if (prompt === "") return fail(400, "prompt is required.");
  if (prompt.length > MAX_AI_PROMPT_CHARS) {
    return fail(413, `prompt is too long: ${MAX_AI_PROMPT_CHARS} characters max.`);
  }

  const contentType = parseContentType(record.contentType);
  if (!contentType) {
    return fail(400, 'contentType must be "text", "code" or "auto".');
  }

  const rawLanguage = record.language;
  let language: string | null = null;
  if (rawLanguage !== undefined && rawLanguage !== null && rawLanguage !== "") {
    language = normalizeLanguage(rawLanguage);
    if (!language) {
      return fail(400, "language is not supported.");
    }
  }

  const tone = parseTone(record.tone);
  if (tone === undefined) {
    return fail(
      400,
      `tone must be a short label (${MAX_TONE_CHARS} characters max).`,
    );
  }

  const platforms = parsePlatforms(record.platforms);
  if (platforms === undefined) {
    return fail(400, "platforms must be an array of known platform names.");
  }

  return {
    ok: true,
    value: { prompt, contentType, language, tone, platforms },
  };
}

/** Validates the body of POST /api/convert. */
export function parseConvertRequest(body: unknown): AiParseResult<ConvertRequest> {
  const record = asRecord(body);
  if (!record) return fail(400, "Expected a JSON object.");

  if (typeof record.text !== "string") return fail(400, "text is required.");
  const text = record.text;
  if (text.trim() === "") return fail(400, "text is required.");
  if (text.length > MAX_CODE_CHARS) {
    return fail(413, `text is too long: ${MAX_CODE_CHARS} characters max.`);
  }

  const rawMode = record.mode;
  let mode: ConvertMode = "auto";
  if (rawMode !== undefined && rawMode !== null) {
    if (
      typeof rawMode !== "string" ||
      !(CONVERT_MODES as readonly string[]).includes(rawMode)
    ) {
      return fail(400, 'mode must be "auto", "always" or "never".');
    }
    mode = rawMode as ConvertMode;
  }

  // Text posts use the smaller editor ceiling; convert exists to turn that
  // text into a code card, so the code ceiling is the useful outer bound.
  return { ok: true, value: { text, mode } };
}
