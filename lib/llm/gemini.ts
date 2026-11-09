/**
 * Gemini implementation of LlmProvider.
 *
 * The API key is read only on the server and is never placed in an error,
 * response or log line. Provider messages are classified into a small set of
 * typed errors so the routes can show clear, safe guidance instead of raw API
 * bodies.
 */

import {
  ApiError,
  FinishReason,
  GoogleGenAI,
  type GenerateContentResponse,
} from "@google/genai";
import { parseJsonObject } from "./json";
import {
  LlmError,
  type GenerateJsonInput,
  type LlmProvider,
} from "./types";

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

type GeminiClientLike = {
  models: {
    generateContent: GoogleGenAI["models"]["generateContent"];
  };
};

export type GeminiProviderOptions = {
  apiKey?: string;
  model?: string;
  client?: GeminiClientLike;
};

const SAFETY_FINISH_REASONS = new Set<string>([
  FinishReason.SAFETY,
  FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII,
  FinishReason.IMAGE_SAFETY,
]);

function errorStatus(error: unknown): number | null {
  if (error instanceof ApiError) return error.status;
  const status =
    typeof error === "object" && error !== null
      ? (error as { status?: unknown }).status
      : undefined;
  return typeof status === "number" ? status : null;
}

function mapError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;

  const name =
    typeof error === "object" && error !== null
      ? (error as { name?: unknown }).name
      : undefined;
  if (name === "TimeoutError" || name === "AbortError") {
    return new LlmError("timeout");
  }

  const status = errorStatus(error);
  const rawMessage =
    typeof error === "object" &&
    error !== null &&
    typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : String(error);
  const message = rawMessage.toLowerCase();

  if (
    status === 429 ||
    message.includes("resource_exhausted") ||
    message.includes("rate limit") ||
    message.includes("quota")
  ) {
    return new LlmError("quota", { status: status ?? 429, retryAfterSeconds: 60 });
  }

  if (
    status === 401 ||
    status === 403 ||
    message.includes("api key not valid") ||
    message.includes("api_key_invalid") ||
    message.includes("unauthenticated") ||
    (status === 400 && message.includes("api key"))
  ) {
    return new LlmError("invalid_key", { status: status ?? 401 });
  }

  if (message.includes("safety") || message.includes("blocked")) {
    return new LlmError("safety", { status: status ?? undefined });
  }

  if (
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("econn") ||
    message.includes("enotfound") ||
    message.includes("etimedout") ||
    message.includes("socket")
  ) {
    return new LlmError("network", { status: status ?? undefined });
  }

  return new LlmError("unknown", { status: status ?? undefined });
}

function safetyFailure(response: GenerateContentResponse): boolean {
  if (response.promptFeedback?.blockReason) return true;
  const finish = response.candidates?.[0]?.finishReason;
  return typeof finish === "string" && SAFETY_FINISH_REASONS.has(finish);
}

/** Builds a provider from GEMINI_API_KEY / GEMINI_MODEL (or explicit options). */
export function createGeminiProvider(
  options: GeminiProviderOptions = {},
): LlmProvider {
  const apiKey = (options.apiKey ?? process.env.GEMINI_API_KEY ?? "").trim();
  if (apiKey === "") throw new LlmError("missing_key");

  const model =
    (options.model ?? process.env.GEMINI_MODEL ?? "").trim() || DEFAULT_GEMINI_MODEL;
  const client: GeminiClientLike =
    options.client ?? new GoogleGenAI({ apiKey });

  return {
    async generateJson(input: GenerateJsonInput): Promise<unknown> {
      const controller = new AbortController();
      const timeout = setTimeout(() => {
        const abort = new Error("AI request timed out");
        abort.name = "TimeoutError";
        controller.abort(abort);
      }, input.timeoutMs);

      let response: GenerateContentResponse;
      try {
        response = await client.models.generateContent({
          model,
          contents: input.prompt,
          config: {
            systemInstruction: input.system,
            responseMimeType: "application/json",
            responseJsonSchema: input.schema,
            maxOutputTokens: input.maxOutputTokens,
            abortSignal: controller.signal,
          },
        });
      } catch (error) {
        throw mapError(error);
      } finally {
        clearTimeout(timeout);
      }

      if (safetyFailure(response)) throw new LlmError("safety");

      if (response.candidates?.[0]?.finishReason === FinishReason.MAX_TOKENS) {
        throw new LlmError("malformed_output", {
          message: "The AI response was cut off. Try a shorter prompt.",
        });
      }

      const text = response.text?.trim();
      if (!text) throw new LlmError("malformed_output");

      return parseJsonObject(text);
    },
  };
}
