/**
 * Gemini implementation of LlmProvider.
 *
 * The API key is read only on the server and is never placed in an error,
 * response or log line. Provider messages are classified into a small set of
 * typed errors so the routes can show clear, safe guidance instead of raw API
 * bodies.
 *
 * Every failed call writes exactly one diagnostic line (see `logFailure`): the
 * typed code, the provider status if any, the SDK error name and the provider
 * message after redaction and truncation. Prompts, post text and the key are
 * never logged.
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
  type LlmErrorCode,
  type LlmProvider,
} from "./types";

export const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";

const REDACTED = "[redacted]";
const MAX_LOGGED_MESSAGE = 300;
const LOG_PREFIX = "[gemini]";

/** Absolute URLs can carry keys in their query string, so they go entirely. */
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>`]+/gi;
/** Authorization headers copied into an error body. */
const AUTH_SCHEME_PATTERN = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi;
/** `key=...`, `token: ...`, `x-goog-api-key: ...` and similar pairs. */
const SECRET_ASSIGNMENT_PATTERN =
  /\b([A-Za-z0-9_.-]*(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|signature|credential)[A-Za-z0-9_.-]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"'&,;)]+)/gi;
/** Signed JSON Web Tokens. */
const JWT_PATTERN = /\beyJ[A-Za-z0-9_\-.]{10,}/g;
/** Opaque high-entropy strings such as Google API keys. */
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9_-]{24,}\b/g;

/**
 * Makes provider text safe to print: secrets and URLs are replaced, whitespace
 * is collapsed to keep the line single and the result is cut to 300 characters.
 * Redaction happens before truncation so a cut never exposes half a key.
 */
function summarizeForLog(text: string, secrets: string[]): string {
  let value = text;

  for (const secret of secrets) {
    if (secret.length < 4) continue;
    value = value.split(secret).join(REDACTED);
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) value = value.split(encoded).join(REDACTED);
  }

  value = value
    .replace(URL_PATTERN, REDACTED)
    .replace(AUTH_SCHEME_PATTERN, REDACTED)
    .replace(
      SECRET_ASSIGNMENT_PATTERN,
      (_match, name: string, separator: string) => `${name}${separator}${REDACTED}`,
    )
    .replace(JWT_PATTERN, REDACTED)
    .replace(LONG_TOKEN_PATTERN, REDACTED)
    .replace(/\s+/g, " ")
    .trim();

  return value.length > MAX_LOGGED_MESSAGE
    ? value.slice(0, MAX_LOGGED_MESSAGE)
    : value;
}

type FailureDiagnostic = {
  code: LlmErrorCode;
  status?: number | null;
  name?: string | null;
  message?: string | null;
  /** Fixed, code-owned detail so each case is distinguishable in the log. */
  note?: string | null;
};

/** Writes the single redacted diagnostic line for a failed Gemini call. */
function logFailure(diagnostic: FailureDiagnostic, secrets: string[]): void {
  const fields = [`code=${diagnostic.code}`];
  if (typeof diagnostic.status === "number") {
    fields.push(`status=${diagnostic.status}`);
  }
  if (diagnostic.name) {
    fields.push(`name=${JSON.stringify(summarizeForLog(diagnostic.name, secrets))}`);
  }
  if (diagnostic.note) {
    fields.push(`note=${summarizeForLog(diagnostic.note, secrets)}`);
  }
  if (diagnostic.message) {
    fields.push(
      `message=${JSON.stringify(summarizeForLog(diagnostic.message, secrets))}`,
    );
  }
  console.error(`${LOG_PREFIX} ${fields.join(" ")}`);
}

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

function errorName(error: unknown): string | null {
  const name =
    typeof error === "object" && error !== null
      ? (error as { name?: unknown }).name
      : undefined;
  return typeof name === "string" && name !== "" ? name : null;
}

function errorMessage(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    typeof (error as { message?: unknown }).message === "string"
    ? (error as { message: string }).message
    : String(error);
}

function mapError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;

  const name = errorName(error);
  if (name === "TimeoutError" || name === "AbortError") {
    return new LlmError("timeout");
  }

  const status = errorStatus(error);
  const message = errorMessage(error).toLowerCase();

  if (
    status === 429 ||
    message.includes("resource_exhausted") ||
    message.includes("rate limit") ||
    message.includes("quota")
  ) {
    return new LlmError("quota", { status: status ?? 429, retryAfterSeconds: 60 });
  }

  if (
    message.includes("model not found") ||
    message.includes("model_not_found") ||
    message.includes("model is not found") ||
    message.includes("invalid model") ||
    message.includes("unsupported model") ||
    (message.includes("model") &&
      (message.includes("not found") ||
        message.includes("does not exist") ||
        message.includes("not supported")))
  ) {
    return new LlmError("model_not_found", { status: status ?? 404 });
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
  if (apiKey === "") {
    logFailure({ code: "missing_key", note: "empty_key" }, []);
    throw new LlmError("missing_key");
  }

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
        const mapped = mapError(error);
        logFailure(
          {
            code: mapped.code,
            status: errorStatus(error),
            name: errorName(error),
            message: errorMessage(error),
          },
          [apiKey],
        );
        throw mapped;
      } finally {
        clearTimeout(timeout);
      }

      if (safetyFailure(response)) {
        const finish = response.candidates?.[0]?.finishReason;
        logFailure(
          {
            code: "safety",
            note:
              response.promptFeedback?.blockReason ??
              (typeof finish === "string" ? finish : "blocked"),
          },
          [apiKey],
        );
        throw new LlmError("safety");
      }

      if (response.candidates?.[0]?.finishReason === FinishReason.MAX_TOKENS) {
        logFailure({ code: "malformed_output", note: "max_tokens" }, [apiKey]);
        throw new LlmError("malformed_output", {
          message: "The AI response was cut off. Try a shorter prompt.",
        });
      }

      const text = response.text?.trim();
      if (!text) {
        logFailure({ code: "malformed_output", note: "empty_response" }, [
          apiKey,
        ]);
        throw new LlmError("malformed_output");
      }

      try {
        return parseJsonObject(text);
      } catch (error) {
        const mapped = mapError(error);
        logFailure({ code: mapped.code, note: "invalid_json" }, [apiKey]);
        throw mapped;
      }
    },
  };
}
