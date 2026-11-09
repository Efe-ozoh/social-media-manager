/**
 * The small provider boundary used by the AI routes.
 *
 * Everything the rest of the app knows about the model lives here: one method,
 * one typed error. The Gemini implementation can therefore be replaced, and
 * tests can pass a fake provider without touching the SDK or the network.
 */

export type LlmErrorCode =
  | "missing_key"
  | "invalid_key"
  | "quota"
  | "safety"
  | "timeout"
  | "malformed_output"
  | "network"
  | "unknown";

const DEFAULT_MESSAGES: Record<LlmErrorCode, string> = {
  missing_key: "AI generation is not configured. Set GEMINI_API_KEY in the environment.",
  invalid_key: "The AI service rejected the configured API key. Check GEMINI_API_KEY.",
  quota: "The AI service is rate limited or out of quota. Try again later.",
  safety: "The AI service blocked this request. Try rephrasing the prompt.",
  timeout: "The AI service took too long to respond. Try again.",
  malformed_output: "The AI service returned an unusable response. Try again.",
  network: "Could not reach the AI service. Try again.",
  unknown: "The AI service could not complete the request. Try again.",
};

export type LlmErrorOptions = {
  /** Safe for the client: it must never contain keys, prompts or raw bodies. */
  message?: string;
  /** HTTP status returned by the provider, when there was one. */
  status?: number;
  retryAfterSeconds?: number;
};

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly status?: number;
  readonly retryAfterSeconds?: number;

  constructor(code: LlmErrorCode, options: LlmErrorOptions = {}) {
    super(options.message ?? DEFAULT_MESSAGES[code]);
    this.name = "LlmError";
    this.code = code;
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export type GenerateJsonInput = {
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  maxOutputTokens: number;
  timeoutMs: number;
};

export type LlmProvider = {
  generateJson(input: GenerateJsonInput): Promise<unknown>;
};

export type LlmHttpError = {
  status: number;
  body: {
    error: string;
    code: LlmErrorCode;
    retryAfterSeconds?: number;
  };
};

const HTTP_STATUS: Record<LlmErrorCode, number> = {
  missing_key: 503,
  invalid_key: 502,
  quota: 429,
  safety: 422,
  timeout: 504,
  malformed_output: 502,
  network: 502,
  unknown: 502,
};

/** Converts a provider failure into a safe JSON response description. */
export function llmErrorToHttp(error: unknown): LlmHttpError {
  if (!(error instanceof LlmError)) {
    return {
      status: 502,
      body: { error: DEFAULT_MESSAGES.unknown, code: "unknown" },
    };
  }

  return {
    status: HTTP_STATUS[error.code],
    body: {
      error: error.message,
      code: error.code,
      ...(error.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: error.retryAfterSeconds }
        : {}),
    },
  };
}
