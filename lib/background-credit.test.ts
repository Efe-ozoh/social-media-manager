import { describe, expect, it } from "vitest";
import { appendPhotoCredit, photoCreditLine } from "./background-credit";

describe("photoCreditLine", () => {
  it("builds the line Unsplash asks for", () => {
    expect(photoCreditLine("Jane Doe")).toBe("Photo by Jane Doe on Unsplash");
  });

  it("returns null without a usable name", () => {
    expect(photoCreditLine(null)).toBeNull();
    expect(photoCreditLine("   ")).toBeNull();
  });
});

describe("appendPhotoCredit", () => {
  it("adds the credit as its own paragraph", () => {
    expect(appendPhotoCredit("Morning light", "Jane Doe", 4_096)).toBe(
      "Morning light\n\nPhoto by Jane Doe on Unsplash",
    );
  });

  it("trims trailing whitespace before appending", () => {
    expect(appendPhotoCredit("Morning light   \n", "Jane Doe", 4_096)).toBe(
      "Morning light\n\nPhoto by Jane Doe on Unsplash",
    );
  });

  it("never adds the same credit twice", () => {
    const once = appendPhotoCredit("Morning light", "Jane Doe", 4_096);
    expect(appendPhotoCredit(once, "Jane Doe", 4_096)).toBe(once);
  });

  it("leaves the caption alone when there is no photographer", () => {
    expect(appendPhotoCredit("Morning light", null, 4_096)).toBe(
      "Morning light",
    );
  });

  it("keeps the post publishable instead of pushing it over the limit", () => {
    const caption = "x".repeat(3_000);
    // The credit would make it 3,000 + 26 + 2 characters; LinkedIn allows
    // 3,000, so the caption stays as it is rather than failing the publish.
    expect(appendPhotoCredit(caption, "Jane Doe", 3_000)).toBe(caption);
    expect(appendPhotoCredit("short", "Jane Doe", 3_000)).toBe(
      "short\n\nPhoto by Jane Doe on Unsplash",
    );
  });

  it("uses the credit alone for an empty caption", () => {
    expect(appendPhotoCredit("", "Jane Doe", 4_096)).toBe(
      "Photo by Jane Doe on Unsplash",
    );
  });
});
