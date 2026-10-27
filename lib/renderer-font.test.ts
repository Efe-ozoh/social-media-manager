import { describe, expect, it } from "vitest";
import {
  computePerSlideFont,
  lineEm,
  TEXT_FONT_MAX,
  TEXT_FONT_MIN,
} from "./renderer";
import { splitSlides } from "./splitter";

/**
 * The font size decides whether text stays inside the card, so these tests pin
 * the two invariants: text scales with the room a slide has, and it is never
 * scaled past the width of the block it is drawn into.
 *
 * Note the width bound is only as good as `lineEm`'s estimate; the sizes these
 * tests allow were checked against rendered PNGs separately.
 */

const WORDS = "the quick brown fox jumps over a lazy dog while shipping code";

function line(n: number): string {
  return WORDS.repeat(4).slice(0, n).trimEnd();
}

function split(text: string) {
  return splitSlides({ text, contentType: "text" });
}

function sizeOf(text: string, index = 0): number {
  const result = split(text);
  return computePerSlideFont(result.slides[index], true, result.config);
}

function usableWidth(config: ReturnType<typeof split>["config"]): number {
  return config.slideWidth - config.horizontalPadding * 2 - config.lineNumberGutter;
}

describe("computePerSlideFont", () => {
  it("keeps code cards on the splitter's monospace size", () => {
    const result = splitSlides({ text: "const a = 1;\nconst b = 2;", contentType: "code" });

    expect(computePerSlideFont(result.slides[0], false, result.config)).toBe(
      result.config.fontSize,
    );
  });

  it("scales a sparse text slide above the base size", () => {
    const text = [line(20), line(18)].join("\n");
    const result = split(text);
    const size = sizeOf(text);

    expect(result.slides.length).toBe(1);
    expect(size).toBeGreaterThan(result.config.fontSize);
    expect(size).toBeLessThanOrEqual(TEXT_FONT_MAX);
  });

  it("gives a sparse slide a larger font than a dense one", () => {
    const dense = Array.from({ length: 18 }, () => line(30)).join("\n");

    expect(sizeOf([line(20), line(20)].join("\n"))).toBeGreaterThan(sizeOf(dense));
  });

  it("stays within the floor and ceiling on every slide", () => {
    const result = split(Array.from({ length: 18 }, () => line(35)).join("\n"));

    for (const slide of result.slides) {
      const size = computePerSlideFont(slide, true, result.config);
      expect(size).toBeGreaterThanOrEqual(TEXT_FONT_MIN);
      expect(size).toBeLessThanOrEqual(TEXT_FONT_MAX);
    }
  });

  it("keeps the widest line inside the text block for every glyph class", () => {
    const cases = [
      line(32),
      line(35),
      "ATTENTION EVERYONE READ THIS",
      "M".repeat(20),
      "W".repeat(18),
      "@".repeat(22),
      "1234567890 1234567890 1234",
    ];

    for (const text of cases) {
      const result = split(text);
      const size = computePerSlideFont(result.slides[0], true, result.config);
      const widest = Math.max(...result.slides[0].lines.map((l) => lineEm(l.text)));

      expect(size * widest).toBeLessThanOrEqual(usableWidth(result.config));
    }
  });

  it("scales wide glyphs down further than prose of the same length", () => {
    // Same character count, much wider glyphs: the width bound has to bite.
    expect(sizeOf("M".repeat(22))).toBeLessThan(sizeOf(line(22)));
  });

  it("honours an explicit config", () => {
    const result = splitSlides({
      text: line(20),
      contentType: "text",
      config: { fontSize: 30, lineHeight: 40, charAspectRatio: 0.5 },
    });
    const size = computePerSlideFont(result.slides[0], true, result.config);

    expect(size).toBeGreaterThanOrEqual(30);
    expect(size).toBeLessThanOrEqual(TEXT_FONT_MAX);
  });
});
