/**
 * Posts-page logic that needs neither a database nor a request.
 *
 * The list is rendered from the same JSON shape as GET /api/posts, so every
 * rule that decides what the owner may do with a post lives here: which tab a
 * status belongs to, when Edit/Delete/Publish now/Retry are allowed, and
 * whether the page needs to keep polling.
 *
 * Keeping these rules out of the component means the "editable only while
 * draft or scheduled" rule is enforced once here and once in the API, and the
 * two can be compared in a test rather than by reading JSX.
 */

import { platformLabel, type PlatformName } from "./platforms";

export type TargetStatus = "pending" | "processing" | "published" | "failed";

export type PostStatus =
  | "draft"
  | "scheduled"
  | "processing"
  | "published"
  | "partial"
  | "failed";

/** One row of a target as GET /api/posts serialises it. */
export type PostTargetSummary = {
  id: string;
  platform: string;
  status: string;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  notes: string | null;
  requiresReconnect: boolean;
  externalPostId: string | null;
  publishedAt: string | null;
  processingStartedAt: string | null;
};

/** The subset of a serialised post the posts page reads. */
export type PostSummary = {
  id: string;
  bodyText: string;
  caption: string;
  /** True when the caption is the whole post and there are no slides. */
  textOnly: boolean;
  status: string;
  scheduledAt: string | null;
  createdAt: string;
  media: { slideIndex: number; url: string }[];
  targets: PostTargetSummary[];
};

export type StatusFilter =
  | "all"
  | "draft"
  | "scheduled"
  | "published"
  | "partial"
  | "failed";

export const STATUS_FILTERS = [
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "scheduled", label: "Scheduled" },
  { value: "published", label: "Published" },
  { value: "partial", label: "Partial" },
  { value: "failed", label: "Failed" },
] as const satisfies ReadonlyArray<{ value: StatusFilter; label: string }>;

/**
 * The tab a post belongs to. "processing" is a post that is publishing right
 * now, so it stays with the scheduled posts rather than getting a tab of its
 * own; an unknown status falls back to Draft so it stays visible instead of
 * quietly disappearing from every tab.
 */
export function statusFilterOf(status: string): Exclude<StatusFilter, "all"> {
  switch (status) {
    case "draft":
      return "draft";
    case "published":
      return "published";
    case "partial":
      return "partial";
    case "failed":
      return "failed";
    case "scheduled":
    case "processing":
      return "scheduled";
    default:
      return "draft";
  }
}

export function matchesStatusFilter(status: string, filter: StatusFilter): boolean {
  return filter === "all" || statusFilterOf(status) === filter;
}

export function filterPosts<T extends { status: string }>(
  posts: readonly T[],
  filter: StatusFilter,
): T[] {
  return posts.filter((post) => matchesStatusFilter(post.status, filter));
}

/** A one-line preview of the post body, for the card heading. */
export function previewOf(text: string, max = 180): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  if (collapsed.length <= max) return collapsed;

  return `${collapsed.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/**
 * Which timestamp the card shows: when it went out, else when it is due, else
 * when it was written. Drafts have neither of the first two.
 */
export function postTime(post: {
  scheduledAt: string | null;
  createdAt: string;
  targets: readonly { publishedAt: string | null }[];
}): { kind: "published" | "scheduled" | "created"; value: string } {
  const published = post.targets
    .map((target) => target.publishedAt)
    .filter((value): value is string => Boolean(value))
    .sort();

  if (published.length > 0) {
    return { kind: "published", value: published[published.length - 1] };
  }
  if (post.scheduledAt) return { kind: "scheduled", value: post.scheduledAt };
  return { kind: "created", value: post.createdAt };
}

/**
 * Rendering in the browser is what makes the time local, so the label is
 * computed there. An explicit timeZone is only used by tests.
 */
export function formatLocalTime(
  iso: string,
  options: { locale?: string; timeZone?: string } = {},
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";

  try {
    return new Intl.DateTimeFormat(options.locale ?? undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    }).format(date);
  } catch {
    // A weird system locale must not blank the whole card.
    return iso;
  }
}

/**
 * Edit is offered only while nothing has been published or is publishing, which
 * is the same condition PATCH /api/posts/[id] enforces.
 */
export function canEditPost(post: {
  status: string;
  targets: readonly { status: string }[];
}): boolean {
  if (post.status !== "draft" && post.status !== "scheduled") return false;
  return !post.targets.some(
    (target) => target.status === "published" || target.status === "processing",
  );
}

/** Deleting is allowed while the post is still a draft or only scheduled. */
export function canDeletePost(post: { status: string }): boolean {
  return post.status === "draft" || post.status === "scheduled";
}

/** Publish now makes anything not yet published due immediately. */
export function canPublishNow(post: {
  targets: readonly { status: string }[];
}): boolean {
  return post.targets.some(
    (target) => target.status === "pending" || target.status === "failed",
  );
}

/** Only a settled failure can be retried; published targets must never be. */
export function canRetryTarget(target: { status: string }): boolean {
  return target.status === "failed";
}

/**
 * Polling is only needed while something is in flight. Every 30 seconds is
 * frequent enough for a scheduler that runs about once a minute.
 */
export function needsAutoRefresh(
  posts: readonly { targets: readonly { status: string }[] }[],
): boolean {
  return posts.some((post) =>
    post.targets.some(
      (target) => target.status === "pending" || target.status === "processing",
    ),
  );
}

export function attemptsLabel(attempts: number): string {
  if (!Number.isFinite(attempts) || attempts <= 0) return "no attempts yet";
  if (attempts === 1) return "1 attempt";
  return `${attempts} attempts`;
}

export type BadgeTone = "published" | "pending" | "processing" | "failed";

export function targetTone(status: string): BadgeTone {
  switch (status) {
    case "published":
      return "published";
    case "processing":
      return "processing";
    case "failed":
      return "failed";
    default:
      return "pending";
  }
}

export function targetLabel(platform: string): string {
  // Unknown values would only appear after a schema change; show them rather
  // than throwing in the middle of a list.
  return platform in { linkedin: 1, telegram: 1, instagram: 1, facebook: 1 }
    ? platformLabel(platform as PlatformName)
    : platform;
}

/**
 * A link to the published post, where the platform id is enough to build one.
 *
 * LinkedIn's Posts API returns a URN (urn:li:share:… or urn:li:ugcPost:…), and
 * the documented feed URL is /feed/update/<urn>/. Nothing else is guessed: a
 * Telegram message id alone cannot be turned into a t.me link without the
 * channel's public username, so Telegram returns null and the card simply
 * omits the link.
 */
export function publishedPostUrl(
  platform: string,
  externalPostId: string | null,
): string | null {
  if (!externalPostId || platform !== "linkedin") return null;

  const urn = externalPostId.trim();
  if (!/^urn:li:(?:share|ugcPost):[0-9]+$/.test(urn)) return null;

  return `https://www.linkedin.com/feed/update/${urn}/`;
}
