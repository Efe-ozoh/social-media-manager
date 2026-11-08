import { describe, expect, it, vi } from "vitest";
import {
  needsDownloadTracking,
  trackBackgroundForPost,
  trackDownloadOnce,
} from "./background-tracking";
import type { getPrisma } from "./prisma";

const ENDPOINT = "https://api.unsplash.com/photos/photo-1/download?ixid=abc";

describe("needsDownloadTracking", () => {
  it("needs a photo and its Unsplash endpoint", () => {
    expect(
      needsDownloadTracking({
        photoId: null,
        downloadLocation: ENDPOINT,
        trackedId: null,
      }),
    ).toBe(false);
    expect(
      needsDownloadTracking({
        photoId: "photo-1",
        downloadLocation: null,
        trackedId: null,
      }),
    ).toBe(false);
    expect(
      needsDownloadTracking({
        photoId: "photo-1",
        downloadLocation: "https://evil.example/photo-1/download",
        trackedId: null,
      }),
    ).toBe(false);
  });

  it("is done once the same photo has been tracked", () => {
    expect(
      needsDownloadTracking({
        photoId: "photo-1",
        downloadLocation: ENDPOINT,
        trackedId: "photo-1",
      }),
    ).toBe(false);
  });

  it("tracks again when the photo changed after tracking", () => {
    expect(
      needsDownloadTracking({
        photoId: "photo-2",
        downloadLocation: ENDPOINT.replace("photo-1", "photo-2"),
        trackedId: "photo-1",
      }),
    ).toBe(true);
  });
});

describe("trackDownloadOnce", () => {
  it("calls the endpoint once and reports success", async () => {
    const track = vi.fn(async () => true);
    const photo = {
      photoId: "photo-1",
      downloadLocation: ENDPOINT,
      trackedId: null,
      track,
    };

    expect(await trackDownloadOnce(photo)).toBe("tracked");
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(ENDPOINT);

    // The caller records the id, so the next run is a no-op.
    expect(await trackDownloadOnce({ ...photo, trackedId: "photo-1" })).toBe(
      "skipped",
    );
    expect(track).toHaveBeenCalledTimes(1);
  });

  it("never throws when the report fails", async () => {
    await expect(
      trackDownloadOnce({
        photoId: "photo-1",
        downloadLocation: ENDPOINT,
        trackedId: null,
        track: async () => false,
      }),
    ).resolves.toBe("failed");

    await expect(
      trackDownloadOnce({
        photoId: "photo-1",
        downloadLocation: ENDPOINT,
        trackedId: null,
        track: async () => {
          throw new Error("network down");
        },
      }),
    ).resolves.toBe("failed");
  });
});

describe("trackBackgroundForPost", () => {
  function fakePrisma(post: {
    bgUnsplashId: string | null;
    bgDownloadLocation: string | null;
    bgDownloadTracked: string | null;
  }) {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const prisma = {
      post: {
        findUnique: vi.fn(async () => post),
        updateMany,
      },
    } as unknown as ReturnType<typeof getPrisma>;
    return { prisma, updateMany };
  }

  it("reports the download and records the tracked photo id", async () => {
    const { prisma, updateMany } = fakePrisma({
      bgUnsplashId: "photo-1",
      bgDownloadLocation: ENDPOINT,
      bgDownloadTracked: null,
    });
    const track = vi.fn(async () => true);

    expect(await trackBackgroundForPost("post-1", { prisma, track })).toBe(
      "tracked",
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "post-1", bgUnsplashId: "photo-1" },
      data: { bgDownloadTracked: "photo-1" },
    });
  });

  it("does nothing when this photo was already tracked", async () => {
    const { prisma, updateMany } = fakePrisma({
      bgUnsplashId: "photo-1",
      bgDownloadLocation: ENDPOINT,
      bgDownloadTracked: "photo-1",
    });
    const track = vi.fn(async () => true);

    expect(await trackBackgroundForPost("post-1", { prisma, track })).toBe(
      "skipped",
    );
    expect(track).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("does not record a failed report, so a later attempt can retry", async () => {
    const { prisma, updateMany } = fakePrisma({
      bgUnsplashId: "photo-1",
      bgDownloadLocation: ENDPOINT,
      bgDownloadTracked: null,
    });

    expect(
      await trackBackgroundForPost("post-1", {
        prisma,
        track: async () => false,
      }),
    ).toBe("failed");
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("never throws, even when the database is down", async () => {
    const prisma = {
      post: {
        findUnique: async () => {
          throw new Error("connection closed");
        },
      },
    } as unknown as ReturnType<typeof getPrisma>;

    expect(
      await trackBackgroundForPost("post-1", {
        prisma,
        track: async () => true,
      }),
    ).toBe("failed");
  });
});
