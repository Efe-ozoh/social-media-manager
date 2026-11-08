/**
 * Unsplash download tracking — Phase 5c.
 *
 * Unsplash's guidelines say a download must be reported when a photo is
 * actually used, not when it is searched for or previewed. Phase 2b did that
 * at the moment of selection, which fires for clicks that never become posts.
 * The rule now is: report exactly once per photo, when the post is first
 * scheduled or published.
 *
 * `bg_download_tracked` stores the Unsplash id whose download has been
 * reported, so picking a different photo later means its own report.
 *
 * Nothing here throws and nothing is retried in a loop: tracking is a
 * side-effect of saving/publishing, and failing to report a download must
 * never fail the post. `trackDownload` itself is a fire-and-forget request
 * with an 8-second timeout.
 */

import { getPrisma } from "./prisma";
import { isUnsplashDownloadUrl, trackDownload } from "./unsplash";

/** The photo fields a post carries, plus the id already reported. */
export type TrackedPhoto = {
  /** `bg_unsplash_id`: the photo currently selected on the post. */
  photoId: string | null;
  /** `bg_download_location`: the endpoint to call for that photo. */
  downloadLocation: string | null;
  /** `bg_download_tracked`: the id already reported, if any. */
  trackedId: string | null;
};

export type TrackingOutcome = "tracked" | "skipped" | "failed";

/**
 * True when this photo still needs its download reported: a photo is chosen,
 * its endpoint looks like Unsplash's, and it is not the one already tracked.
 */
export function needsDownloadTracking(photo: TrackedPhoto): boolean {
  if (!photo.photoId || !photo.downloadLocation) return false;
  if (!isUnsplashDownloadUrl(photo.downloadLocation)) return false;
  return photo.trackedId !== photo.photoId;
}

/**
 * Reports one photo's download at most once. The `track` callback is injected
 * so the rules can be tested without a network.
 */
export async function trackDownloadOnce(
  input: TrackedPhoto & { track?: (downloadLocation: string) => Promise<boolean> },
): Promise<TrackingOutcome> {
  if (!needsDownloadTracking(input)) return "skipped";

  const track = input.track ?? trackDownload;
  try {
    const ok = await track(input.downloadLocation as string);
    return ok ? "tracked" : "failed";
  } catch {
    return "failed";
  }
}

/**
 * Tracks a saved post's background photo, if it has not been tracked yet.
 *
 * Called from the posts API (when a post becomes scheduled) and from the
 * dispatcher (when a target is published), so it must be idempotent: the
 * second caller sees `bg_download_tracked` already equal to the photo id and
 * does nothing. Only the id that was tracked is written, and only when the
 * post still points at that photo, so a concurrent change is never
 * overwritten.
 */
export async function trackBackgroundForPost(
  postId: string,
  options: {
    prisma?: ReturnType<typeof getPrisma>;
    track?: (downloadLocation: string) => Promise<boolean>;
  } = {},
): Promise<TrackingOutcome> {
  const prisma = options.prisma ?? getPrisma();

  try {
    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: {
        bgUnsplashId: true,
        bgDownloadLocation: true,
        bgDownloadTracked: true,
      },
    });
    if (!post) return "skipped";

    const photo: TrackedPhoto = {
      photoId: post.bgUnsplashId,
      downloadLocation: post.bgDownloadLocation,
      trackedId: post.bgDownloadTracked,
    };
    const outcome = await trackDownloadOnce({ ...photo, track: options.track });
    if (outcome !== "tracked") return outcome;

    await prisma.post.updateMany({
      where: { id: postId, bgUnsplashId: photo.photoId },
      data: { bgDownloadTracked: photo.photoId },
    });
    return "tracked";
  } catch {
    // A tracking failure is never the reason a save or a publish fails.
    return "failed";
  }
}
