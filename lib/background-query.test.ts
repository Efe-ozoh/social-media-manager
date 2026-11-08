import { describe, expect, it } from "vitest";
import {
  extractKeywords,
  firstSentence,
  isSearchableQuery,
} from "./background-query";

describe("firstSentence", () => {
  it("stops at the first sentence break", () => {
    expect(firstSentence("Sunset over the lake. Then rain.")).toBe(
      "Sunset over the lake.",
    );
    expect(firstSentence("Why is the sky blue? Physics.")).toBe(
      "Why is the sky blue?",
    );
  });

  it("falls back to the first line when there is no punctuation", () => {
    expect(firstSentence("Alpine forest\nsecond line")).toBe("Alpine forest");
  });

  it("ignores fenced code blocks and links", () => {
    expect(firstSentence("```ts\nconst a = 1;\n```\nOcean at dawn")).toBe(
      "Ocean at dawn",
    );
    expect(firstSentence("Read https://example.com/x and relax")).toBe(
      "Read and relax",
    );
  });
});

describe("extractKeywords", () => {
  it("keeps the two or three meaningful words of the first sentence", () => {
    expect(
      extractKeywords(
        "I have been debugging this gnarly Kubernetes ingress problem all morning. It was painful.",
      ),
    ).toBe("debugging gnarly kubernetes");
  });

  it("drops stopwords, short words and bare numbers", () => {
    expect(extractKeywords("The 3 best ways to slice a pineapple")).toBe(
      "ways slice pineapple",
    );
  });

  it("does not search for code tokens", () => {
    const keywords = extractKeywords("const value = 42;\nreturn value;");
    expect(keywords).not.toContain("const");
    expect(keywords).not.toContain("return");
    expect(extractKeywords("```ts\nconst value = 42;\n```\nSunset over the ocean")).toBe(
      "sunset ocean",
    );
  });

  it("returns an empty string when nothing is worth searching", () => {
    expect(extractKeywords("This is the way it is")).toBe("");
    expect(extractKeywords("   ")).toBe("");
  });

  it("dedupes and respects the limit", () => {
    expect(extractKeywords("Ocean ocean ocean sunset")).toBe("ocean sunset");
    expect(extractKeywords("Alpine forest lake cabin", 2)).toBe("alpine forest");
  });
});

describe("isSearchableQuery", () => {
  it("needs at least two characters", () => {
    expect(isSearchableQuery(" a ")).toBe(false);
    expect(isSearchableQuery("ab")).toBe(true);
  });
});
