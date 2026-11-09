import { describe, expect, it, vi } from "vitest";
import type { ConvertRequest, GeneratedPost, GenerateRequest } from "./ai-types";
import {
  convertText,
  generatePost,
  noConversion,
  normalizeConvertResult,
  normalizeGeneratedPost,
  stripCodeFence,
} from "./ai-service";
import { LlmError, type LlmProvider } from "./llm/types";
import { MAX_AI_EXPLANATION_CHARS, MAX_AI_OUTPUT_TOKENS } from "./ai-types";

const GENERATE_REQUEST: GenerateRequest = {
  prompt: "Explain closures",
  contentType: "auto",
  language: null,
  tone: "friendly",
  platforms: ["linkedin"],
};

function rawGenerated(overrides: Record<string, unknown> = {}) {
  return {
    contentType: "text",
    bodyText: "A closure keeps its scope.",
    code: "",
    language: "",
    caption: "A closure keeps its scope.",
    hashtags: ["#javascript"],
    variants: {
      linkedin: "LinkedIn version",
      telegram: "Telegram version",
      facebook: "Facebook version",
      instagram: "Instagram version",
    },
    imageQuery: "developer desk",
    ...overrides,
  };
}

function validGenerated(): GeneratedPost {
  return normalizeGeneratedPost(rawGenerated(), GENERATE_REQUEST);
}

function fakeProvider(
  implementation: LlmProvider["generateJson"],
): LlmProvider & { generateJson: ReturnType<typeof vi.fn> } {
  return { generateJson: vi.fn(implementation) };
}

describe("stripCodeFence", () => {
  it("removes one fence", () => {
    expect(stripCodeFence("```ts\nconst x = 1;\n```")).toBe("const x = 1;");
    expect(stripCodeFence("const x = 1;")).toBe("const x = 1;");
  });
});

describe("normalizeGeneratedPost", () => {
  it("validates and bounds a text result", () => {
    const result = normalizeGeneratedPost(rawGenerated(), GENERATE_REQUEST);

    expect(result).toMatchObject({
      contentType: "text",
      bodyText: "A closure keeps its scope.",
      code: null,
      language: null,
      caption: "A closure keeps its scope.",
      hashtags: ["#javascript"],
      imageQuery: "developer desk",
    });
  });

  it("forces code and stores it as bodyText", () => {
    const result = normalizeGeneratedPost(
      rawGenerated({
        contentType: "code",
        bodyText: "",
        code: "```js\nconst add = (a, b) => a + b;\n```",
        language: "javascript",
      }),
      { ...GENERATE_REQUEST, contentType: "code" },
    );

    expect(result.contentType).toBe("code");
    expect(result.code).toBe("const add = (a, b) => a + b;");
    expect(result.bodyText).toBe(result.code);
    expect(result.language).toBe("javascript");
  });

  it("honours the requested text type even when the model returns code", () => {
    const result = normalizeGeneratedPost(
      rawGenerated({ contentType: "code", bodyText: "text version", code: "x" }),
      { ...GENERATE_REQUEST, contentType: "text" },
    );

    expect(result.contentType).toBe("text");
    expect(result.code).toBeNull();
    expect(result.bodyText).toBe("text version");
  });

  it("infers code in auto mode when code is present", () => {
    const result = normalizeGeneratedPost(
      rawGenerated({ contentType: "weird", bodyText: "", code: "const x = 1;" }),
      GENERATE_REQUEST,
    );
    expect(result.contentType).toBe("code");
  });

  it("rejects missing captions, empty code and oversized code", () => {
    for (const value of [
      rawGenerated({ caption: "  " }),
      rawGenerated({ contentType: "code", code: "``` \n ```" }),
      rawGenerated({ contentType: "code", code: "x".repeat(20_001) }),
      {}, 
    ]) {
      expect(() => normalizeGeneratedPost(value, GENERATE_REQUEST)).toThrow(
        LlmError,
      );
    }
  });

  it("falls back to keywords when imageQuery is missing", () => {
    const result = normalizeGeneratedPost(
      rawGenerated({ imageQuery: "" }),
      GENERATE_REQUEST,
    );
    expect(result.imageQuery.length).toBeGreaterThan(0);
    expect(result.imageQuery.length).toBeLessThanOrEqual(120);
  });
});

describe("generatePost", () => {
  it("returns a validated result", async () => {
    const provider = fakeProvider(async () => rawGenerated());
    await expect(generatePost(GENERATE_REQUEST, provider)).resolves.toEqual(
      validGenerated(),
    );
    expect(provider.generateJson).toHaveBeenCalledTimes(1);
  });

  it("retries malformed output once", async () => {
    const provider = fakeProvider(async () =>
      provider.generateJson.mock.calls.length === 1 ? {} : rawGenerated(),
    );

    await expect(generatePost(GENERATE_REQUEST, provider)).resolves.toMatchObject(
      { contentType: "text" },
    );
    expect(provider.generateJson).toHaveBeenCalledTimes(2);
  });

  it("stops after a second malformed response", async () => {
    const provider = fakeProvider(async () => ({}));
    await expect(generatePost(GENERATE_REQUEST, provider)).rejects.toMatchObject({
      code: "malformed_output",
    });
    expect(provider.generateJson).toHaveBeenCalledTimes(2);
  });

  it("does not retry quota or safety failures", async () => {
    for (const code of ["quota", "safety"] as const) {
      const provider = fakeProvider(async () => {
        throw new LlmError(code);
      });

      await expect(
        generatePost(GENERATE_REQUEST, provider),
      ).rejects.toMatchObject({ code });
      expect(provider.generateJson).toHaveBeenCalledTimes(1);
    }
  });

  it("passes the output and timeout limits to the provider", async () => {
    const provider = fakeProvider(async () => rawGenerated());
    await generatePost(GENERATE_REQUEST, provider);

    expect(provider.generateJson).toHaveBeenCalledWith(
      expect.objectContaining({
        maxOutputTokens: MAX_AI_OUTPUT_TOKENS,
        timeoutMs: 45_000,
      }),
    );
  });
});

describe("normalizeConvertResult", () => {
  it("returns text unchanged in auto mode", () => {
    expect(
      normalizeConvertResult(
        { contentType: "text", code: "", language: "", explanation: "No need." },
        "auto",
      ),
    ).toEqual({
      contentType: "text",
      code: null,
      language: null,
      explanation: "No need.",
    });
  });

  it("forces code in always mode", () => {
    expect(
      normalizeConvertResult(
        {
          contentType: "text",
          code: "```py\nprint('hi')\n```",
          language: "python",
          explanation: "Useful.",
        },
        "always",
      ),
    ).toMatchObject({
      contentType: "code",
      code: "print('hi')",
      language: "python",
    });
  });

  it("rejects missing forced code", () => {
    expect(() =>
      normalizeConvertResult(
        { contentType: "text", code: "", language: "", explanation: "No." },
        "always",
      ),
    ).toThrow(LlmError);
  });

  it("bounds the explanation", () => {
    const result = normalizeConvertResult(
      {
        contentType: "text",
        code: "",
        language: "",
        explanation: "x".repeat(MAX_AI_EXPLANATION_CHARS + 10),
      },
      "auto",
    );
    expect(result.explanation).toHaveLength(MAX_AI_EXPLANATION_CHARS);
  });
});

describe("convertText", () => {
  const request: ConvertRequest = { text: "const x = 1;", mode: "auto" };

  it("never calls the model when conversion is off", async () => {
    const provider = fakeProvider(async () => {
      throw new Error("should not run");
    });

    await expect(
      convertText({ ...request, mode: "never" }, provider),
    ).resolves.toEqual(noConversion());
    expect(provider.generateJson).not.toHaveBeenCalled();
  });

  it("requires a provider otherwise", async () => {
    await expect(convertText(request, null)).rejects.toMatchObject({
      code: "missing_key",
    });
  });

  it("retries malformed output once", async () => {
    const provider = fakeProvider(async () =>
      provider.generateJson.mock.calls.length === 1
        ? { contentType: "code", code: "", language: "", explanation: "No code." }
        : {
            contentType: "code",
            code: "const x = 1;",
            language: "javascript",
            explanation: "Converted.",
          },
    );

    await expect(convertText(request, provider)).resolves.toMatchObject({
      contentType: "code",
      code: "const x = 1;",
    });
    expect(provider.generateJson).toHaveBeenCalledTimes(2);
  });
});
