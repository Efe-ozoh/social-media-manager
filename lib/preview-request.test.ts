import { describe, expect, it } from "vitest";
import {
  MAX_CODE_CHARS,
  MAX_TEXT_CHARS,
  parsePreviewRequest,
} from "./preview-request";

function expectError(body: unknown, status: number, fragment?: string) {
  const result = parsePreviewRequest(body);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.status).toBe(status);
  if (fragment) expect(result.error.toLowerCase()).toContain(fragment.toLowerCase());
}

describe("parsePreviewRequest", () => {
  it("applies defaults", () => {
    const result = parsePreviewRequest({ text: "Hello" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      text: "Hello",
      contentType: "text",
      language: null,
      background: null,
      usePhotoBehindCode: false,
    });
  });

  it("rejects a body that is not an object", () => {
    expectError(null, 400);
    expectError("text", 400);
    expectError([], 400);
  });

  it("requires non-empty text", () => {
    expectError({}, 400, "text is required");
    expectError({ text: 42 }, 400, "text is required");
    expectError({ text: "   \n\t " }, 400, "text is required");
  });

  it("accepts text exactly at the limit and rejects one character more", () => {
    const atLimit = parsePreviewRequest({ text: "a".repeat(MAX_TEXT_CHARS) });
    expect(atLimit.ok).toBe(true);

    expectError({ text: "a".repeat(MAX_TEXT_CHARS + 1) }, 413, "too long");
  });

  it("gives code a larger ceiling than plain text", () => {
    const codeOnly = "a".repeat(MAX_TEXT_CHARS + 1);

    expectError({ text: codeOnly, contentType: "text" }, 413);
    const asCode = parsePreviewRequest({ text: codeOnly, contentType: "code" });
    expect(asCode.ok).toBe(true);

    expectError({ text: "a".repeat(MAX_CODE_CHARS + 1), contentType: "code" }, 413);
  });

  it("rejects an unknown content type", () => {
    expectError({ text: "hi", contentType: "markdown" }, 400, "contentType");
  });

  it("validates language", () => {
    const ok = parsePreviewRequest({ text: "const a = 1", contentType: "code", language: "typescript" });
    expect(ok.ok && ok.value.language).toBe("typescript");

    const empty = parsePreviewRequest({ text: "hi", language: "  " });
    expect(empty.ok && empty.value.language).toBeNull();

    expectError({ text: "hi", language: 7 }, 400, "language");
    expectError({ text: "hi", language: "ja\nva" }, 400, "language");
  });

  it("accepts a valid Unsplash background", () => {
    const result = parsePreviewRequest({
      text: "hi",
      background: {
        url: "https://images.unsplash.com/photo-1?w=1080&h=1350",
        authorName: "Ada Lovelace",
        authorUrl: "https://unsplash.com/@ada?utm_source=codesync_hub&utm_medium=referral",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.background).toEqual({
      url: "https://images.unsplash.com/photo-1?w=1080&h=1350",
      authorName: "Ada Lovelace",
      authorUrl: "https://unsplash.com/@ada?utm_source=codesync_hub&utm_medium=referral",
    });
  });

  it("rejects backgrounds that are not hotlinked Unsplash images", () => {
    expectError({ text: "hi", background: { url: "https://evil.example/a.jpg" } }, 400, "background.url");
    expectError({ text: "hi", background: { url: "http://images.unsplash.com/a.jpg" } }, 400, "background.url");
    expectError({ text: "hi", background: "https://images.unsplash.com/a.jpg" }, 400, "background");
    expectError({ text: "hi", background: {} }, 400, "background.url");
  });

  it("rejects a credit that does not belong to Unsplash", () => {
    expectError(
      {
        text: "hi",
        background: {
          url: "https://images.unsplash.com/photo-1",
          authorUrl: "https://evil.example/@ada",
        },
      },
      400,
      "authorUrl",
    );
  });

  it("validates the photo-behind-code switch", () => {
    const ok = parsePreviewRequest({ text: "hi", usePhotoBehindCode: true });
    expect(ok.ok && ok.value.usePhotoBehindCode).toBe(true);

    expectError({ text: "hi", usePhotoBehindCode: "yes" }, 400, "usePhotoBehindCode");
  });
});
