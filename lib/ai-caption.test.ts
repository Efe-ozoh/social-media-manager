import { describe, expect, it } from "vitest";
import { captionWithHashtags, normalizeHashtags } from "./ai-caption";

describe("normalizeHashtags", () => {
  it("normalizes, deduplicates and caps tags", () => {
    expect(
      normalizeHashtags([
        "#JavaScript",
        " javascript ",
        "##TypeScript",
        "bad tag!",
        42,
        "#ok_2",
      ]),
    ).toEqual(["#JavaScript", "#TypeScript", "#ok_2"]);
  });

  it("ignores non-arrays", () => {
    expect(normalizeHashtags("nope")).toEqual([]);
  });

  it("keeps at most ten tags", () => {
    const tags = normalizeHashtags(
      Array.from({ length: 20 }, (_, index) => `#tag${index}`),
    );
    expect(tags).toHaveLength(10);
  });
});

describe("captionWithHashtags", () => {
  it("appends tags on their own line when they fit", () => {
    expect(captionWithHashtags("Hello", ["#one", "#two"], 20)).toBe(
      "Hello\n\n#one #two",
    );
  });

  it("never grows past the platform limit", () => {
    const result = captionWithHashtags("Hello", ["#one", "#two-long"], 12);
    expect(result.length).toBeLessThanOrEqual(12);
    expect(result).toBe("Hello\n\n#one");
  });

  it("returns the bounded caption when no tag fits", () => {
    expect(captionWithHashtags("Hello", ["#toolong"], 7)).toBe("Hello");
  });

  it("bounds an already oversized caption", () => {
    expect(captionWithHashtags("abcdefghij", ["#x"], 5)).toBe("abcde");
  });
});
