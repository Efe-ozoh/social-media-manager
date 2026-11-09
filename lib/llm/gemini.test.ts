import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GEMINI_MODEL,
  createGeminiProvider,
  type GeminiProviderOptions,
} from "./gemini";
import { LlmError } from "./types";

const INPUT = {
  system: "system",
  prompt: "prompt",
  schema: { type: "object" },
  maxOutputTokens: 123,
  timeoutMs: 1_000,
};

function providerWith(client: unknown): ReturnType<typeof createGeminiProvider> {
  return createGeminiProvider({
    apiKey: "test-key",
    client,
  } as GeminiProviderOptions);
}

describe("createGeminiProvider", () => {
  it("requires a key", () => {
    expect(() => createGeminiProvider({ apiKey: "  " })).toThrow(LlmError);
    try {
      createGeminiProvider({ apiKey: "  " });
    } catch (error) {
      expect(error).toMatchObject({ code: "missing_key" });
    }
  });

  it("calls structured output with the configured model and limits", async () => {
    const generateContent = vi.fn().mockResolvedValue({
      text: '```json\n{"ok":true}\n```',
    });
    const provider = providerWith({ models: { generateContent } });

    await expect(provider.generateJson(INPUT)).resolves.toEqual({ ok: true });

    expect(generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: DEFAULT_GEMINI_MODEL,
        contents: "prompt",
        config: expect.objectContaining({
          systemInstruction: "system",
          responseMimeType: "application/json",
          responseJsonSchema: { type: "object" },
          maxOutputTokens: 123,
          abortSignal: expect.any(AbortSignal),
        }),
      }),
    );
  });

  it("uses an explicit model", async () => {
    const generateContent = vi.fn().mockResolvedValue({ text: "{}" });
    const provider = createGeminiProvider({
      apiKey: "test-key",
      model: "custom-model",
      client: { models: { generateContent } },
    } as GeminiProviderOptions);

    await provider.generateJson(INPUT);
    expect(generateContent.mock.calls[0][0]).toMatchObject({
      model: "custom-model",
    });
  });

  it("turns a safety block into a typed error", async () => {
    const provider = providerWith({
      models: {
        generateContent: vi
          .fn()
          .mockResolvedValue({ promptFeedback: { blockReason: "SAFETY" } }),
      },
    });

    await expect(provider.generateJson(INPUT)).rejects.toMatchObject({
      code: "safety",
    });
  });

  it("reports truncated output with a safe message", async () => {
    const provider = providerWith({
      models: {
        generateContent: vi.fn().mockResolvedValue({
          text: "{}",
          candidates: [{ finishReason: "MAX_TOKENS" }],
        }),
      },
    });

    await expect(provider.generateJson(INPUT)).rejects.toMatchObject({
      code: "malformed_output",
      message: expect.stringContaining("cut off"),
    });
  });

  it("classifies provider failures without leaking their message", async () => {
    const cases: Array<[unknown, string]> = [
      [{ status: 429, message: "quota raw body" }, "quota"],
      [{ status: 401, message: "key raw body" }, "invalid_key"],
      [{ name: "AbortError", message: "raw" }, "timeout"],
      [{ message: "fetch failed raw" }, "network"],
      [{ message: "something odd" }, "unknown"],
    ];

    for (const [error, code] of cases) {
      const provider = providerWith({
        models: { generateContent: vi.fn().mockRejectedValue(error) },
      });

      await expect(provider.generateJson(INPUT)).rejects.toMatchObject({ code });
      try {
        await provider.generateJson(INPUT);
      } catch (caught) {
        expect(caught).toBeInstanceOf(LlmError);
        expect((caught as Error).message).not.toContain("raw");
      }
    }
  });

  it("classifies malformed JSON", async () => {
    const provider = providerWith({
      models: { generateContent: vi.fn().mockResolvedValue({ text: "not json" }) },
    });
    await expect(provider.generateJson(INPUT)).rejects.toMatchObject({
      code: "malformed_output",
    });
  });
});
