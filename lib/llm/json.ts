/**
 * Reads the JSON object a model was asked to return.
 *
 * Even with structured output enabled a model can wrap its answer in a
 * markdown fence, so fences are removed before parsing. Nothing else is
 * repaired: malformed JSON becomes a typed error and the caller may retry.
 */

import { LlmError } from "./types";

/** Removes one surrounding ``` / ```json fence, if present. */
export function stripJsonFence(text: string): string {
  let value = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(value);
  if (fenced) {
    value = fenced[1].trim();
  } else if (value.startsWith("```")) {
    value = value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  }
  return value;
}

/**
 * Parses a JSON object from model text. When a model adds a sentence around an
 * otherwise valid object, the outermost braces are tried as a fallback.
 */
export function parseJsonObject(text: string): Record<string, unknown> {
  const cleaned = stripJsonFence(text);

  const candidates = [cleaned];
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(cleaned.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }

  throw new LlmError("malformed_output");
}
