import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeminiProvider, type GeminiProviderOptions } from "./gemini";

const KEY = "AIzaSyD-test-key-must-never-be-logged";
const PROMPT = "PROMPT-SENTINEL: private post text that must never be logged";
const SYSTEM = "SYSTEM-SENTINEL: private instructions";

const INPUT = {
  system: SYSTEM,
  prompt: PROMPT,
  schema: { type: "object" },
  maxOutputTokens: 100,
  timeoutMs: 1_000,
};

let lines: string[] = [];

function captureLogs(): void {
  lines = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map((value) => String(value)).join(" "));
  });
}

function providerWithClient(client: unknown): ReturnType<typeof createGeminiProvider> {
  return createGeminiProvider({ apiKey: KEY, client } as GeminiProviderOptions);
}

function loggedMessage(line: string): string | null {
  const match = / message="(.*)"$/.exec(line);
  return match ? match[1] : null;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Gemini failure diagnostics", () => {
  it("logs one redacted line without the key, token, URL or prompt", async () => {
    captureLogs();
    const provider = providerWithClient({
      models: {
        generateContent: vi.fn().mockRejectedValue({
          status: 401,
          name: "ApiError",
          message:
            `API key not valid: ${KEY}. See https://generativelanguage.googleapis.com/v1beta/models?key=${KEY}` +
            ` and access_token=${"z".repeat(40)} for details.`,
        }),
      },
    });

    await expect(provider.generateJson(INPUT)).rejects.toMatchObject({
      code: "invalid_key",
      message:
        "The AI service rejected the configured API key. Check GEMINI_API_KEY.",
    });

    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line.startsWith("[gemini] ")).toBe(true);
    expect(line).toContain("code=invalid_key");
    expect(line).toContain("status=401");
    expect(line).toContain('name="ApiError"');
    expect(line).toContain("[redacted]");

    expect(line).not.toContain("AIzaSyD");
    expect(line).not.toContain(KEY);
    expect(line).not.toContain("z".repeat(40));
    expect(line).not.toContain("https://");
    expect(line).toContain("access_token=[redacted]");
    expect(line).not.toContain(PROMPT);
    expect(line).not.toContain("PROMPT-SENTINEL");
    expect(line).not.toContain(SYSTEM);
    expect(line).not.toContain("\n");
  });

  it("cuts the provider message to 300 characters after redaction", async () => {
    captureLogs();
    const provider = providerWithClient({
      models: {
        generateContent: vi
          .fn()
          .mockRejectedValue({ status: 500, message: "word ".repeat(120) }),
      },
    });

    await expect(provider.generateJson(INPUT)).rejects.toMatchObject({
      code: "unknown",
    });

    expect(lines).toHaveLength(1);
    expect(loggedMessage(lines[0])).toHaveLength(300);
  });

  it("keeps each failure case distinguishable in the log", async () => {
    const cases: Array<{
      code: string;
      note?: string;
      run: () => Promise<unknown> | unknown;
    }> = [
      {
        code: "missing_key",
        note: "note=empty_key",
        run: () => createGeminiProvider({ apiKey: "  " }),
      },
      {
        code: "invalid_key",
        run: async () =>
          providerWithClient({
            models: {
              generateContent: vi.fn().mockRejectedValue({
                status: 403,
                name: "ApiError",
                message: "PERMISSION_DENIED: API key not valid",
              }),
            },
          }).generateJson(INPUT),
      },
      {
        code: "model_not_found",
        run: async () =>
          providerWithClient({
            models: {
              generateContent: vi.fn().mockRejectedValue({
                status: 404,
                name: "ApiError",
                message:
                  "models/gemini-3.8-flash is not found for API version v1beta",
              }),
            },
          }).generateJson(INPUT),
      },
      {
        code: "quota",
        run: async () =>
          providerWithClient({
            models: {
              generateContent: vi.fn().mockRejectedValue({
                status: 429,
                name: "ApiError",
                message: "RESOURCE_EXHAUSTED: quota exceeded",
              }),
            },
          }).generateJson(INPUT),
      },
      {
        code: "safety",
        note: "note=SAFETY",
        run: async () =>
          providerWithClient({
            models: {
              generateContent: vi
                .fn()
                .mockResolvedValue({ promptFeedback: { blockReason: "SAFETY" } }),
            },
          }).generateJson(INPUT),
      },
      {
        code: "timeout",
        run: async () =>
          providerWithClient({
            models: {
              generateContent: vi
                .fn()
                .mockRejectedValue({ name: "TimeoutError", message: "timed out" }),
            },
          }).generateJson(INPUT),
      },
      {
        code: "malformed_output",
        note: "note=invalid_json",
        run: async () =>
          providerWithClient({
            models: {
              generateContent: vi.fn().mockResolvedValue({ text: "not json" }),
            },
          }).generateJson(INPUT),
      },
      {
        code: "network",
        run: async () =>
          providerWithClient({
            models: {
              generateContent: vi
                .fn()
                .mockRejectedValue({ name: "TypeError", message: "fetch failed" }),
            },
          }).generateJson(INPUT),
      },
    ];

    for (const testCase of cases) {
      captureLogs();
      await expect((async () => testCase.run())()).rejects.toBeDefined();

      expect(lines).toHaveLength(1);
      const [line] = lines;
      expect(line).toContain(`code=${testCase.code}`);
      if (testCase.note) expect(line).toContain(testCase.note);
      expect(line).not.toContain(KEY);
      expect(line).not.toContain(PROMPT);
      expect(line).not.toContain("\n");
    }
  });
});
