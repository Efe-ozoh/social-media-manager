/**
 * JSON shape for the posts API.
 *
 * Dates become ISO strings and the Prisma enums become plain strings, so the
 * dashboard can consume the response without importing Prisma types.
 */

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

type MediaRecord = {
  id: string;
  slideIndex: number;
  url: string;
  width: number;
  height: number;
};

type TargetRecord = {
  id: string;
  platform: string;
  captionOverride: string | null;
  status: string;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: Date | null;
  processingStartedAt: Date | null;
  notes: string | null;
  requiresReconnect: boolean;
  externalPostId: string | null;
  publishedAt: Date | null;
};

export type PostRecord = {
  id: string;
  title: string | null;
  bodyText: string;
  contentType: string;
  code: string | null;
  language: string | null;
  theme: string;
  caption: string;
  textOnly: boolean;
  carouselMode: string;
  backgroundMode: string;
  backgroundQuery: string | null;
  bgUnsplashId: string | null;
  bgUrl: string | null;
  bgThumbUrl: string | null;
  bgAuthorName: string | null;
  bgAuthorUrl: string | null;
  bgColor: string | null;
  bgDownloadLocation: string | null;
  bgDownloadTracked: string | null;
  usePhotoBehindCode: boolean;
  bgCreditCaption: boolean;
  source: string;
  aiPrompt: string | null;
  status: string;
  scheduledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  media: MediaRecord[];
  targets: TargetRecord[];
};

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function serializePost(post: PostRecord) {
  return {
    id: post.id,
    title: post.title,
    bodyText: post.bodyText,
    contentType: post.contentType,
    code: post.code,
    language: post.language,
    theme: post.theme,
    caption: post.caption,
    textOnly: post.textOnly,
    carouselMode: post.carouselMode,
    background: {
      mode: post.backgroundMode,
      query: post.backgroundQuery,
      unsplashId: post.bgUnsplashId,
      url: post.bgUrl,
      thumbUrl: post.bgThumbUrl,
      authorName: post.bgAuthorName,
      authorUrl: post.bgAuthorUrl,
      color: post.bgColor,
      // Needed when editing: re-saving an unchanged photo must not lose the
      // endpoint that reports its download. It is a public API URL, not a key.
      downloadLocation: post.bgDownloadLocation,
      downloadTracked: post.bgDownloadTracked,
    },
    usePhotoBehindCode: post.usePhotoBehindCode,
    creditCaption: post.bgCreditCaption,
    source: post.source,
    aiPrompt: post.aiPrompt,
    status: post.status,
    scheduledAt: iso(post.scheduledAt),
    createdAt: post.createdAt.toISOString(),
    updatedAt: post.updatedAt.toISOString(),
    media: post.media.map((row) => ({
      id: row.id,
      slideIndex: row.slideIndex,
      url: row.url,
      width: row.width,
      height: row.height,
    })),
    targets: post.targets.map((target) => ({
      id: target.id,
      platform: target.platform,
      captionOverride: target.captionOverride,
      status: target.status,
      attempts: target.attempts,
      lastError: target.lastError,
      nextAttemptAt: iso(target.nextAttemptAt),
      processingStartedAt: iso(target.processingStartedAt),
      notes: target.notes,
      requiresReconnect: target.requiresReconnect,
      externalPostId: target.externalPostId,
      publishedAt: iso(target.publishedAt),
    })),
  };
}

/** The common Prisma include for a post and everything the API returns. */
export const POST_INCLUDE = {
  media: { orderBy: { slideIndex: "asc" as const } },
  targets: { orderBy: { platform: "asc" as const } },
} as const;
