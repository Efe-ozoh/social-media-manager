/**
 * The render → save → clean-up boundary shared by the posts API.
 *
 * renderPost deliberately leaves the previous render's images in storage and
 * returns the keys the new set no longer uses. Those keys may only be deleted
 * after the new post_media rows are committed: if the save fails, the old rows
 * must still point at images that exist.
 *
 * Keeping the three steps in one helper means a route cannot accidentally
 * reverse the order.
 */

import type { PostMediaRow, RenderPostResult } from "./render-post";

export type RenderedMedia = Pick<RenderPostResult, "media" | "staleKeys">;

export type DeleteStaleResult = unknown;

/**
 * Renders first, saves the returned rows, then deletes stale images. A failed
 * save propagates and the clean-up never runs.
 */
export async function renderSaveAndCleanup<T extends RenderedMedia>(options: {
  render: () => Promise<T>;
  save: (media: PostMediaRow[], rendered: T) => Promise<void>;
  deleteStale: (keys: string[]) => Promise<DeleteStaleResult>;
}): Promise<T> {
  const rendered = await options.render();
  await options.save(rendered.media, rendered);
  await options.deleteStale(rendered.staleKeys);
  return rendered;
}
