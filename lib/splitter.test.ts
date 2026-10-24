import { describe, expect, it } from "vitest";
import { splitSlides, type SplitInput, type SplitterConfig } from "./splitter";

/**
 * Tests for SPEC section 8, "Tests required":
 *   - Empty input; one-line input; exactly linesPerSlide lines; one more than that.
 *   - Very long single line (wrapping).
 *   - Nested blocks where the preferred break is far from the limit.
 *   - One giant function with no blank lines.
 *   - Mixed tabs and spaces.
 *   - More than the slide cap.
 * plus the rules those bullets exercise (capacity, preferred breaks, line
 * numbers, the tooLong flag, the single-slide indicator, plain-text splitting).
 */

/** 100 x 100 slide, zero padding: 10 lines per slide, 10 characters per line. */
const cfg: SplitterConfig = {
  slideWidth: 100,
  slideHeight: 100,
  verticalPadding: 0,
  horizontalPadding: 0,
  lineNumberGutter: 0,
  fontSize: 10,
  lineHeight: 10,
  charAspectRatio: 1,
};

/** Same slide, 1000 px wide: still 10 lines per slide, but 100 characters. */
const wide: SplitterConfig = { ...cfg, slideWidth: 1000 };

const code = (text: string, config: SplitterConfig = wide): SplitInput => ({
  text,
  contentType: "code",
  config,
});

const texts = (result: { slides: { lines: { text: string }[] }[] }): string[][] =>
  result.slides.map((slide) => slide.lines.map((line) => line.text));

describe("capacity", () => {
  it("computes linesPerSlide from the SPEC formula", () => {
    const result = splitSlides({
      text: "x",
      contentType: "code",
      config: {
        slideHeight: 1350,
        verticalPadding: 120,
        lineHeight: 44,
        slideWidth: 1080,
        horizontalPadding: 80,
        lineNumberGutter: 56,
        fontSize: 30,
        charAspectRatio: 0.6,
      },
    });

    expect(result.linesPerSlide).toBe(Math.floor((1350 - 120) / 44)); // 27
    expect(result.charCapacity).toBe(
      Math.floor((1080 - 80 * 2 - 56) / (30 * 0.6)), // 48
    );
  });

  it("uses the SPEC defaults of 8 lookback lines and a cap of 10", () => {
    const result = splitSlides({ text: "x" });
    expect(result.config.lookback).toBe(8);
    expect(result.config.carouselCap).toBe(10);
  });

  it("gives plain text a larger proportional font than code", () => {
    const text = splitSlides({ text: "hi" });
    const codeResult = splitSlides({ text: "hi", contentType: "code" });

    expect(text.contentType).toBe("text"); // plain text is the default input
    expect(text.config.fontSize).toBeGreaterThan(codeResult.config.fontSize);
    expect(text.config.lineHeight).toBeGreaterThan(codeResult.config.lineHeight);
    expect(text.charCapacity).toBeLessThan(codeResult.charCapacity);
    expect(text.linesPerSlide).toBeLessThan(codeResult.linesPerSlide);
  });

  it("rejects a config that cannot hold a single line", () => {
    expect(() => splitSlides({ text: "x", config: { lineHeight: 0 } })).toThrow(
      RangeError,
    );
    expect(() =>
      splitSlides({ text: "x", config: { verticalPadding: 100, slideHeight: 100 } }),
    ).toThrow(RangeError);
  });
});

describe("SPEC tests required — empty and one-line input", () => {
  it("returns no slides for empty input", () => {
    const result = splitSlides({ text: "", config: cfg });

    expect(result).toMatchObject({
      slides: [],
      slideCount: 0,
      tooLong: false,
      showIndicator: false,
    });
  });

  it("treats whitespace-only input as empty", () => {
    expect(splitSlides({ text: "   \n\n  ", config: cfg }).slideCount).toBe(0);
    expect(splitSlides({ text: "\n", config: cfg }).slideCount).toBe(0);
  });

  it("returns one slide for one-line input", () => {
    const result = splitSlides({ text: "hello", contentType: "code", config: cfg });

    expect(result.slideCount).toBe(1);
    expect(result.showIndicator).toBe(false);
    expect(result.tooLong).toBe(false);
    expect(result.slides[0]).toMatchObject({ index: 0, startLine: 1 });
    expect(result.slides[0].lines).toEqual([
      { number: 1, text: "hello", continuation: false },
    ]);
  });
});

describe("SPEC tests required — exactly linesPerSlide, then one more", () => {
  const line = (n: number) => `line ${n}`;

  it("fills a single slide when the input is exactly linesPerSlide lines", () => {
    const text = Array.from({ length: 10 }, (_, i) => line(i + 1)).join("\n");
    const result = splitSlides({ text, contentType: "code", config: cfg });

    expect(result.linesPerSlide).toBe(10);
    expect(result.slideCount).toBe(1);
    expect(result.slides[0].lines).toHaveLength(10);
    expect(result.slides[0].lines[0]).toMatchObject({ number: 1, text: "line 1" });
    expect(result.slides[0].lines[9]).toMatchObject({ number: 10, text: "line 10" });
    // SPEC rule 6: everything fits on one slide -> no indicator.
    expect(result.showIndicator).toBe(false);
  });

  it("adds a second slide at one more than linesPerSlide, continuing line numbers", () => {
    const text = Array.from({ length: 11 }, (_, i) => line(i + 1)).join("\n");
    const result = splitSlides({ text, contentType: "code", config: cfg });

    expect(result.slideCount).toBe(2);
    expect(result.slides.map((slide) => slide.lines.length)).toEqual([10, 1]);
    // SPEC rule 4: line numbers continue across slides.
    expect(result.slides[1]).toMatchObject({ index: 1, startLine: 11 });
    expect(result.slides[1].lines[0]).toMatchObject({ number: 11, text: "line 11" });
    expect(result.showIndicator).toBe(true);
    expect(result.tooLong).toBe(false);
  });
});

describe("SPEC tests required — very long single line (wrapping)", () => {
  it("wraps the line and counts every wrapped chunk toward capacity", () => {
    const line = "abcdefghij".repeat(25); // 250 characters, 10 per line
    const result = splitSlides({ text: line, contentType: "code", config: cfg });

    expect(result.charCapacity).toBe(10);
    expect(result.slideCount).toBe(3); // 25 chunks, not 1 line
    expect(result.slides.map((slide) => slide.lines.length)).toEqual([10, 10, 5]);

    // The whole line survives wrapping unchanged.
    expect(texts(result).flat().join("")).toBe(line);
  });

  it("marks wrapped chunks as continuations with no line number", () => {
    const result = splitSlides({
      text: "abcdefghij".repeat(25),
      contentType: "code",
      config: cfg,
    });

    const first = result.slides[0].lines;
    expect(first[0]).toEqual({ number: 1, text: "abcdefghij", continuation: false });
    expect(first.slice(1).every((entry) => entry.continuation)).toBe(true);
    expect(first.slice(1).every((entry) => entry.number === null)).toBe(true);
    // A slide can start mid-line: it still reports the source line it starts on.
    expect(result.slides[1].startLine).toBe(1);
    expect(result.slides[1].lines[0]).toMatchObject({ number: null, continuation: true });
  });

  it("wraps plain text at word boundaries instead of mid-word", () => {
    const result = splitSlides({
      text: "hello world hello world",
      contentType: "text",
      config: cfg,
    });

    expect(texts(result)).toEqual([["hello", "world", "hello", "world"]]);
    expect(result.slideCount).toBe(1);
  });
});

describe("SPEC tests required — nested blocks, preferred break far from the limit", () => {
  it("hard-splits when the only break candidate is outside the 8-line lookback", () => {
    // The blank line sits on the slide (line 1) but 9 lines above the limit.
    const text = [
      "",
      "function outer() {",
      "  function inner() {",
      "    if (value) {",
      "      push(a);",
      "      push(b);",
      "      push(c);",
      "      push(d);",
      "    }",
      "  }",
      "    return value;",
    ].join("\n");

    const result = splitSlides(code(text));

    expect(result.config.lookback).toBe(8);
    expect(result.slides.map((slide) => slide.lines.length)).toEqual([10, 1]);
    expect(result.slides[0].lines[0]).toEqual({
      number: 1,
      text: "",
      continuation: false,
    });
    expect(result.slides[1].startLine).toBe(11);
  });

  it("breaks at a blank line that is inside the lookback window", () => {
    const text = [
      "  a1;",
      "  a2;",
      "  a3;",
      "  a4;",
      "  a5;",
      "",
      "  b1;",
      "  b2;",
      "  b3;",
      "  b4;",
      "  b5;",
    ].join("\n");

    const result = splitSlides(code(text));

    expect(result.slides.map((slide) => slide.lines.length)).toEqual([6, 5]);
    expect(result.slides[0].lines[5]).toEqual({ number: 6, text: "", continuation: false });
    expect(result.slides[1].startLine).toBe(7);
  });

  it("breaks after a block closer at indentation level 0", () => {
    const text = [
      "function one() {",
      "  work();",
      "}",
      "  more();",
      "  more();",
      "  more();",
      "  more();",
      "  more();",
      "  more();",
      "  more();",
      "  tail();",
    ].join("\n");

    const result = splitSlides(code(text));

    expect(result.slides[0].lines.map((line) => line.text)).toEqual([
      "function one() {",
      "  work();",
      "}",
    ]);
    expect(result.slides[0].lines[2]).toMatchObject({ number: 3, text: "}" });
    expect(result.slides[1].startLine).toBe(4);
  });
});

describe("SPEC tests required — one giant function with no blank lines", () => {
  const text = [
    "function giant() {",
    ...Array.from({ length: 25 }, (_, i) => `  body${i}();`),
    "}",
  ].join("\n");

  it("hard-splits every full slide until the closing brace", () => {
    const result = splitSlides(code(text));

    expect(result.slideCount).toBe(3);
    expect(result.slides.map((slide) => slide.lines.length)).toEqual([10, 10, 7]);
    expect(result.showIndicator).toBe(true);
    expect(result.tooLong).toBe(false);
  });

  it("keeps line numbers running and ends on the closing brace", () => {
    const result = splitSlides(code(text));

    expect(result.slides.map((slide) => slide.startLine)).toEqual([1, 11, 21]);
    expect(result.slides[2].lines.at(-1)).toEqual({ number: 27, text: "}", continuation: false });
    expect(texts(result).flat().some((line) => line === "")).toBe(false);
    expect(texts(result).flat().join("\n")).toBe(text);
  });
});

describe("SPEC tests required — mixed tabs and spaces", () => {
  it("expands tabs to tab stops and preserves indentation", () => {
    const result = splitSlides(code("\ta;\n\t\tb;\n  \tc;\n  \tvalue;"));

    expect(texts(result)).toEqual([["    a;", "        b;", "    c;", "    value;"]]);
    expect(texts(result).flat().some((line) => line.includes("\t"))).toBe(false);
    expect(result.slides[0].lines.map((line) => line.number)).toEqual([1, 2, 3, 4]);
  });

  it("normalizes CRLF and CR line endings", () => {
    const result = splitSlides(code("a\r\nb\rc"));

    expect(texts(result)).toEqual([["a", "b", "c"]]);
    expect(result.slides[0].lines.map((line) => line.number)).toEqual([1, 2, 3]);
  });
});

describe("SPEC tests required — more than the slide cap", () => {
  const manyLines = (count: number) =>
    Array.from({ length: count }, (_, i) => `  v${i};`).join("\n");

  it("sets tooLong with the slide count above the cap of 10", () => {
    const result = splitSlides(code(manyLines(110)));

    expect(result.slideCount).toBe(11);
    expect(result.config.carouselCap).toBe(10);
    expect(result.tooLong).toBe(true);
    expect(result.showIndicator).toBe(true);
    expect(result.slides.every((slide) => slide.lines.length === 10)).toBe(true);
  });

  it("stays under the cap at exactly 10 slides", () => {
    const result = splitSlides(code(manyLines(100)));

    expect(result.slideCount).toBe(10);
    expect(result.tooLong).toBe(false);
  });
});

describe("SPEC rule 7 — plain text splits on paragraphs, then sentences", () => {
  it("prefers a paragraph boundary over a nearer sentence ending", () => {
    const text = [
      "Hello.",
      "World.",
      "",
      "More.",
      "Text.",
      "Here.",
      "Goes.",
      "Again.",
      "Fine.",
      "End.",
      "Extra.",
    ].join("\n");

    const result = splitSlides({ text, contentType: "text", config: cfg });

    expect(result.slideCount).toBe(2);
    expect(result.slides[0].lines.map((line) => line.text)).toEqual([
      "Hello.",
      "World.",
      "",
    ]);
    expect(result.slides[1].startLine).toBe(4);
  });

  it("falls back to a sentence boundary when no paragraph is in the window", () => {
    const text = [
      "First.",
      "Second.",
      "Third.",
      "Fourth.",
      "Fifth.",
      "Sixth.",
      "Seventh.",
      "Eighth.",
      "Ninth.",
      "no end",
      "more",
    ].join("\n");

    const result = splitSlides({ text, contentType: "text", config: cfg });

    expect(result.slides.map((slide) => slide.lines.length)).toEqual([9, 2]);
    expect(result.slides[1].startLine).toBe(10);
    expect(result.slides[0].lines.at(-1)).toMatchObject({ number: 9, text: "Ninth." });
  });
});
