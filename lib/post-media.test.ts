import { describe, expect, it } from "vitest";
import { renderSaveAndCleanup } from "./post-media";
import type { PostMediaRow } from "./render-post";

const MEDIA: PostMediaRow[] = [
  {
    slideIndex: 0,
    url: "https://example.com/uploads/posts/p/slide-1.jpg",
    width: 1080,
    height: 1350,
  },
];

describe("renderSaveAndCleanup", () => {
  it("deletes stale images only after the new rows are saved", async () => {
    const calls: string[] = [];

    await renderSaveAndCleanup({
      render: async () => {
        calls.push("render");
        return { media: MEDIA, staleKeys: ["posts/p/old/slide-1.jpg"] };
      },
      save: async (media) => {
        calls.push(`save:${media.length}`);
      },
      deleteStale: async (keys) => {
        calls.push(`delete:${keys.join(",")}`);
      },
    });

    expect(calls).toEqual([
      "render",
      "save:1",
      "delete:posts/p/old/slide-1.jpg",
    ]);
  });

  it("does not delete anything when the save fails", async () => {
    const calls: string[] = [];

    await expect(
      renderSaveAndCleanup({
        render: async () => {
          calls.push("render");
          return { media: MEDIA, staleKeys: ["posts/p/old/slide-1.jpg"] };
        },
        save: async () => {
          calls.push("save");
          throw new Error("database unavailable");
        },
        deleteStale: async () => {
          calls.push("delete");
        },
      }),
    ).rejects.toThrow("database unavailable");

    expect(calls).toEqual(["render", "save"]);
  });
});
