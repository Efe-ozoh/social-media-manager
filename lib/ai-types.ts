/** Shared AI request and response shapes (no server dependencies). */

export const AI_CONTENT_TYPES = ["text", "code", "auto"] as const;
export type AiContentType = (typeof AI_CONTENT_TYPES)[number];

export const AI_PLATFORMS = ["linkedin", "telegram", "facebook", "instagram"] as const;
export type AiPlatform = (typeof AI_PLATFORMS)[number];

export const CONVERT_MODES = ["auto", "always", "never"] as const;
export type ConvertMode = (typeof CONVERT_MODES)[number];

export type GenerateRequest = {
  prompt: string;
  contentType: AiContentType;
  language: string | null;
  tone: string | null;
  platforms: AiPlatform[];
};

export type GeneratedPost = {
  bodyText: string;
  code: string | null;
  language: string | null;
  contentType: "text" | "code";
  caption: string;
  hashtags: string[];
  variants: Record<AiPlatform, string>;
  imageQuery: string;
};

export type ConvertRequest = {
  text: string;
  mode: ConvertMode;
};

export type ConvertResult = {
  contentType: "text" | "code";
  code: string | null;
  language: string | null;
  explanation: string;
};

/** Cost controls. The output ceiling is deliberately well below model maxima. */
export const MAX_AI_OUTPUT_TOKENS = 8_192;
export const AI_TIMEOUT_MS = 45_000;
export const MAX_AI_IMAGE_QUERY_CHARS = 120;
export const MAX_AI_EXPLANATION_CHARS = 300;
export const MAX_AI_HASHTAGS = 10;
export const MAX_AI_CAPTION_CHARS = 4_096;
