import { describe, expect, it } from "vitest";
import { shortPostId, slideFileName, zipFileName } from "./export-files";

const ID = "b1946ac9-2f6c-4e1b-9d5a-0f2f4a7c8d3e";

describe("shortPostId", () => {
  it("takes the first eight characters without dashes", () => {
    expect(shortPostId(ID)).toBe("b1946ac9");
  });

  it("never returns an empty name", () => {
    expect(shortPostId("")).toBe("post");
    expect(shortPostId("---")).toBe("post");
  });
});

describe("file names", () => {
  it("numbers slides from one, as the owner sees them", () => {
    expect(slideFileName(ID, 1)).toBe("post-b1946ac9-slide-1.jpg");
    expect(slideFileName(ID, 12)).toBe("post-b1946ac9-slide-12.jpg");
  });

  it("names the ZIP after the post", () => {
    expect(zipFileName(ID)).toBe("post-b1946ac9-slides.zip");
  });
});
