import { describe, expect, it } from "vitest";
import { MAX_AI_PROMPT_CHARS } from "./post-request";
import { MAX_CODE_CHARS } from "./preview-request";
import { normalizeLanguage, parseConvertRequest, parseGenerateRequest } from "./ai-request";

describe("parseGenerateRequest", () => {
  it("defaults optional fields", () => {
    const result = parseGenerateRequest({ prompt: "  closures  " });
    expect(result).toEqual({
      ok: true,
      value: {
        prompt: "closures",
        contentType: "auto",
        language: null,
        tone: null,
        platforms: [],
      },
    });
  });

  it("accepts known options", () => {
    const result = parseGenerateRequest({
      prompt: "closures",
      contentType: "code",
      language: "JavaScript",
      tone: "Friendly & concise",
      platforms: ["linkedin", "telegram", "linkedin"],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        prompt: "closures",
        contentType: "code",
        language: "javascript",
        tone: "Friendly & concise",
        platforms: ["linkedin", "telegram"],
      },
    });
  });

  it("rejects missing, oversized and invalid fields", () => {
    expect(parseGenerateRequest({})).toMatchObject({ ok: false, status: 400 });
    expect(
      parseGenerateRequest({ prompt: "x".repeat(MAX_AI_PROMPT_CHARS + 1) }),
    ).toMatchObject({ ok: false, status: 413 });
    expect(
      parseGenerateRequest({ prompt: "x", contentType: "image" }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      parseGenerateRequest({ prompt: "x", language: "brainfuck" }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(parseGenerateRequest({ prompt: "x", tone: "<script>" })).toMatchObject(
      { ok: false, status: 400 },
    );
    expect(
      parseGenerateRequest({ prompt: "x", platforms: ["myspace"] }),
    ).toMatchObject({ ok: false, status: 400 });
  });
});

describe("parseConvertRequest", () => {
  it("defaults to auto mode and keeps the text", () => {
    expect(parseConvertRequest({ text: "  const x = 1;  " })).toEqual({
      ok: true,
      value: { text: "  const x = 1;  ", mode: "auto" },
    });
  });

  it("accepts all modes", () => {
    for (const mode of ["auto", "always", "never"] as const) {
      expect(parseConvertRequest({ text: "x", mode })).toMatchObject({
        ok: true,
        value: { mode },
      });
    }
  });

  it("rejects empty, oversized and invalid input", () => {
    expect(parseConvertRequest({ text: "   " })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(
      parseConvertRequest({ text: "x".repeat(MAX_CODE_CHARS + 1) }),
    ).toMatchObject({ ok: false, status: 413 });
    expect(parseConvertRequest({ text: "x", mode: "sometimes" })).toMatchObject({
      ok: false,
      status: 400,
    });
  });
});

describe("normalizeLanguage", () => {
  it("returns only allowlisted canonical names", () => {
    expect(normalizeLanguage("TypeScript")).toBe("typescript");
    expect(normalizeLanguage("c++")).toBeNull();
    expect(normalizeLanguage(null)).toBeNull();
  });
});
