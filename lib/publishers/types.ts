/**
 * Shared publisher contract — SPEC section 6.
 *
 * One file per platform implements Publisher; the dispatcher only ever talks
 * to this interface, so adding a platform later means adding one module.
 *
 * Failures are always a PublishError, which records whether another attempt
 * could succeed. Expired tokens, missing permissions and validation problems
 * are not retryable — retrying them just burns attempts until the post is
 * marked failed — while network blips, rate limits and 5xx responses are.
 */

import { decryptToken } from "@/lib/crypto";

export type PlatformName = "linkedin" | "facebook" | "instagram";

/** A social_accounts row with its token already decrypted, in memory only. */
export type SocialAccount = {
  id: string;
  platform: PlatformName;
  /** Member URN, Page ID or IG user ID, depending on the platform. */
  externalId: string;
  displayName: string;
  /** Decrypted — never persist this, and never log it. */
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
};

/** The shape of a social_accounts row, as read from the database. */
export type StoredAccountRow = {
  id: string;
  platform: PlatformName;
  externalId: string;
  displayName: string;
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  expiresAt: Date | null;
};

/**
 * Decrypts a stored account for use by a publisher. The key comes from
 * TOKEN_ENCRYPTION_KEY unless one is passed in.
 */
export function toSocialAccount(row: StoredAccountRow, key?: Buffer): SocialAccount {
  return {
    id: row.id,
    platform: row.platform,
    externalId: row.externalId,
    displayName: row.displayName,
    accessToken: decryptToken(row.accessTokenEnc, key),
    refreshToken: row.refreshTokenEnc ? decryptToken(row.refreshTokenEnc, key) : null,
    expiresAt: row.expiresAt,
  };
}

export type PublishInput = {
  /** Ready-to-post text; the caller has already applied caption overrides. */
  caption: string;
  /** Public image URLs in slide order. Empty for a text-only post. */
  imageUrls: string[];
  account: SocialAccount;
};

export type PublishResult = {
  /** The platform's own identifier for the created post. */
  externalPostId: string;
  publishedAt: Date;
  /** Non-fatal remarks, e.g. "published with one image instead of five". */
  notes?: string[];
};

export interface Publisher {
  readonly platform: PlatformName;
  /** Most images this platform accepts in one post. */
  readonly maxImages: number;
  /** Longest caption/commentary it accepts, in characters. */
  readonly maxCaptionLength: number;
  publish(input: PublishInput): Promise<PublishResult>;
  /** Only platforms that issue refresh tokens implement this. */
  refreshToken?(account: SocialAccount): Promise<SocialAccount>;
}

export type PublishErrorCode =
  | "token_expired"
  | "token_invalid"
  | "permission_denied"
  | "validation"
  | "unsupported"
  | "rate_limited"
  | "network"
  | "provider_error";

/** Codes where another attempt cannot help. */
const NON_RETRYABLE: ReadonlySet<PublishErrorCode> = new Set<PublishErrorCode>([
  "token_expired",
  "token_invalid",
  "permission_denied",
  "validation",
  "unsupported",
]);

/** Codes that mean the owner has to reconnect the account. */
const RECONNECT_CODES: ReadonlySet<PublishErrorCode> = new Set<PublishErrorCode>([
  "token_expired",
  "token_invalid",
  "permission_denied",
]);

export type PublishErrorInit = {
  code: PublishErrorCode;
  message: string;
  platform?: PlatformName;
  /** HTTP status from the platform, when there was one. */
  status?: number;
  /** For rate limits: how long to wait before retrying. */
  retryAfterSeconds?: number;
  /** Platform error code/message, already stripped of anything secret. */
  detail?: string;
  /** Overrides the code's default; rarely needed. */
  retryable?: boolean;
};

/**
 * A publishing failure. `message` is safe to show the owner and to store in
 * post_targets.last_error: it never contains a token or a raw response body.
 */
export class PublishError extends Error {
  readonly code: PublishErrorCode;
  readonly platform?: PlatformName;
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  readonly detail?: string;
  readonly retryable: boolean;

  constructor(init: PublishErrorInit) {
    super(init.message);
    this.name = "PublishError";
    this.code = init.code;
    this.platform = init.platform;
    this.status = init.status;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.detail = init.detail;
    this.retryable = init.retryable ?? !NON_RETRYABLE.has(init.code);
  }

  /** The account must be reconnected before this can succeed. */
  get requiresReconnect(): boolean {
    return RECONNECT_CODES.has(this.code);
  }

  /**
   * Maps an HTTP status to a failure. 401/403 are terminal (reconnect),
   * 408/429/5xx are worth retrying, and other 4xx mean the request itself
   * was wrong.
   */
  static fromStatus(
    status: number,
    message: string,
    options: {
      platform?: PlatformName;
      retryAfterSeconds?: number;
      detail?: string;
    } = {},
  ): PublishError {
    const common = { platform: options.platform, status, detail: options.detail };

    if (status === 401) return new PublishError({ ...common, code: "token_expired", message });
    if (status === 403) {
      return new PublishError({ ...common, code: "permission_denied", message });
    }
    if (status === 429) {
      return new PublishError({
        ...common,
        code: "rate_limited",
        message,
        retryAfterSeconds: options.retryAfterSeconds,
      });
    }
    if (status === 408 || status >= 500) {
      return new PublishError({ ...common, code: "provider_error", message });
    }
    if (status >= 400) return new PublishError({ ...common, code: "validation", message });

    return new PublishError({ ...common, code: "provider_error", message });
  }

  static tokenExpired(platform?: PlatformName, message?: string): PublishError {
    return new PublishError({
      code: "token_expired",
      platform,
      message: message ?? "The access token has expired. Reconnect the account.",
    });
  }

  static permissionDenied(platform?: PlatformName, message?: string): PublishError {
    return new PublishError({
      code: "permission_denied",
      platform,
      message:
        message ??
        "The account is missing the permission this post needs. Reconnect and grant the posting scope.",
    });
  }

  static validation(platform: PlatformName | undefined, message: string): PublishError {
    return new PublishError({ code: "validation", platform, message });
  }

  static network(platform?: PlatformName, message?: string, cause?: unknown): PublishError {
    const error = new PublishError({
      code: "network",
      platform,
      message: message ?? "The platform could not be reached. This will be retried.",
    });
    if (cause !== undefined) error.cause = cause;
    return error;
  }
}

/**
 * Removes anything token-shaped from provider text before it can reach a log
 * or post_targets.last_error. LinkedIn access tokens start with "AQ" and
 * Meta's start with "EAA".
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bAQ[A-Za-z0-9_-]{20,}\b/g, "[redacted token]")
    .replace(/\bEAA[A-Za-z0-9_-]{16,}\b/g, "[redacted token]")
    .slice(0, 300);
}

/** True when another attempt could still succeed. */
export function isRetryable(error: unknown): boolean {
  return error instanceof PublishError ? error.retryable : true;
}

/**
 * Normalises anything thrown during publishing into a PublishError, so the
 * dispatcher never has to branch on error shape. Unknown errors are treated
 * as retryable rather than silently abandoning a post.
 */
export function toPublishError(error: unknown, platform?: PlatformName): PublishError {
  if (error instanceof PublishError) return error;
  const message = error instanceof Error ? error.message : "Unknown error";
  return new PublishError({ code: "provider_error", platform, message, retryable: true });
}

/**
 * Checks a post against a platform's limits before any network call, so an
 * unusable post fails immediately and non-retryably.
 */
export function validatePublishInput(
  publisher: Pick<Publisher, "platform" | "maxImages" | "maxCaptionLength">,
  input: PublishInput,
): void {
  const caption = input.caption.trim();
  if (caption.length === 0) {
    throw PublishError.validation(publisher.platform, "The caption is empty.");
  }
  if (caption.length > publisher.maxCaptionLength) {
    throw PublishError.validation(
      publisher.platform,
      `The caption is ${caption.length} characters, but ${publisher.platform} allows ${publisher.maxCaptionLength}.`,
    );
  }
  if (input.imageUrls.length > publisher.maxImages) {
    throw PublishError.validation(
      publisher.platform,
      `The post has ${input.imageUrls.length} images, but ${publisher.platform} allows ${publisher.maxImages}.`,
    );
  }
  for (const url of input.imageUrls) {
    if (!isFetchableImageUrl(url)) {
      throw PublishError.validation(
        publisher.platform,
        "Image URLs must be public https URLs (http is only allowed for a localhost APP_URL).",
      );
    }
  }
}

/**
 * LinkedIn and Meta both fetch images by URL, so links must be publicly
 * reachable. http is tolerated for localhost so the local disk image store
 * still works in development.
 */
export function isFetchableImageUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}
