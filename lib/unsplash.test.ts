import { afterEach, describe, expect, it } from "vitest";
import {
  fetchBackgroundImage,
  isUnsplashDownloadUrl,
  isUnsplashImageUrl,
  searchPortraitPhotos,
} from "./unsplash";

const originalKey = process.env.UNSPLASH_ACCESS_KEY;

afterEach(() => {
  if (originalKey === undefined) delete process.env.UNSPLASH_ACCESS_KEY;
  else process.env.UNSPLASH_ACCESS_KEY = originalKey;
});

describe("searchPortraitPhotos fallbacks", () => {
  it("returns an empty result with a reason when Unsplash is not configured", async () => {
    delete process.env.UNSPLASH_ACCESS_KEY;

    const result = await searchPortraitPhotos("ocean");

    expect(result.photos).toEqual([]);
    expect(result.error).toContain("UNSPLASH_ACCESS_KEY");
    expect(result.cached).toBe(false);
  });

  it("asks for at least two characters instead of calling Unsplash", async () => {
    const result = await searchPortraitPhotos(" a ");

    expect(result.photos).toEqual([]);
    expect(result.error).toBeTruthy();
  });
});

describe("background image guards", () => {
  it("only fetches hotlinked Unsplash images", async () => {
    await expect(
      fetchBackgroundImage("https://evil.example/photo.jpg"),
    ).resolves.toBeNull();
    await expect(
      fetchBackgroundImage("http://images.unsplash.com/photo-1"),
    ).resolves.toBeNull();
  });

  it("recognises Unsplash image and download URLs", () => {
    expect(isUnsplashImageUrl("https://images.unsplash.com/photo-1?w=1080")).toBe(
      true,
    );
    expect(isUnsplashImageUrl("https://plus.unsplash.com/photo-1")).toBe(true);
    expect(isUnsplashImageUrl("https://unsplash.com/photos/abc")).toBe(false);

    expect(
      isUnsplashDownloadUrl("https://api.unsplash.com/photos/abc/download?ixid=1"),
    ).toBe(true);
    expect(isUnsplashDownloadUrl("https://api.unsplash.com/search/photos")).toBe(
      false,
    );
    expect(isUnsplashDownloadUrl("https://example.com/photos/abc/download")).toBe(
      false,
    );
  });
});
