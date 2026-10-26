/**
 * Shared Meta Graph API plumbing for the Facebook and Instagram publishers.
 *
 * API version: v26.0 (July 2026), the current version at the time of writing.
 * Meta supports a version for at least two years after the next one ships, so
 * this is safe into 2028; the constructor option makes a future bump a
 * one-line change.
 *   https://developers.facebook.com/docs/graph-api/changelog/versions/
 *   https://developers.facebook.com/docs/graph-api/guides/versioning/
 *
 * Calls are form-encoded and carry the token as `access_token`, which is how
 * the Page Feed, Page Photos and Instagram media references document it. When
 * META_APP_SECRET is configured, every call also sends `appsecret_proof`, the
 * documented HMAC-SHA256 of the token keyed by the app secret. It is
 * recommended for server-side calls and mandatory when the app's "Require App
 * Secret" setting is enabled:
 *   https://developers.facebook.com/docs/graph-api/guides/secure-requests/
 *
 * Failures are translated in one place, here, into PublishError, so neither
 * publisher (nor the dispatcher) ever branches on Meta's error shape:
 *   https://developers.facebook.com/docs/graph-api/guides/error-handling/
 *   https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/error-codes
 */

import { createHmac } from "node:crypto";
import {
  PublishError,
  redactSecrets,
  type PublishErrorCode,
  type SocialAccount,
} from "./types";

/** Pinned Graph API version; see the note at the top of this file. */
export const META_GRAPH_VERSION = "v26.0";
export const META_GRAPH_ORIGIN = "https://graph.facebook.com";

/** The two platforms this module's helpers cover. */
export type MetaPlatform = "facebook" | "instagram";

const REQUEST_TIMEOUT_MS = 20_000;
/** Treat a token that expires within a minute as already expired. */
const EXPIRY_SKEW_MS = 60_000;

export function graphUrl(path: string, version: string = META_GRAPH_VERSION): string {
  return `${META_GRAPH_ORIGIN}/${version}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Meta's documented server-side proof: HMAC-SHA256 of the access token, using
 * the app secret as the key.
 */
export function appSecretProof(accessToken: string, appSecret: string): string {
  return createHmac("sha256", appSecret).update(accessToken).digest("hex");
}

/**
 * Meta fetches images by URL, so a URL it cannot reach is useless. This is
 * stricter than `isFetchableImageUrl` (which allows localhost for LinkedIn's
 * byte upload): both Meta publishers need a public HTTPS host.
 */
export function assertPublicImageUrls(urls: string[], platform: MetaPlatform): void {
  for (const value of urls) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw PublishError.validation(
        platform,
        `"${value}" is not a valid image URL.`,
      );
    }

    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const isLoopback =
      host === "localhost" || host === "0.0.0.0" || host === "::1" || host.startsWith("127.");
    const isPrivate =
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      !host.includes(".");

    if (isLoopback || isPrivate) {
      throw PublishError.validation(
        platform,
        `${platform === "instagram" ? "Instagram" : "Facebook"} fetches images from its own servers, ` +
          `so it cannot reach "${host}". Set BLOB_READ_WRITE_TOKEN (or another public HTTPS host) ` +
          "before publishing.",
      );
    }

    if (url.protocol !== "https:") {
      throw PublishError.validation(
        platform,
        `${platform === "instagram" ? "Instagram" : "Facebook"} requires public HTTPS image URLs; ` +
          `"${value}" is not HTTPS. Set BLOB_READ_WRITE_TOKEN so slides are hosted publicly.`,
      );
    }
  }
}

/** Rejects an account that cannot be used before any network call is made. */
export function assertMetaToken(account: SocialAccount, platform: MetaPlatform): void {
  if (!account.accessToken) {
    throw PublishError.tokenExpired(
      platform,
      `No ${platform === "facebook" ? "Facebook Page" : "Instagram"} access token is stored. Reconnect the account.`,
    );
  }
  if (account.expiresAt && account.expiresAt.getTime() <= Date.now() + EXPIRY_SKEW_MS) {
    throw PublishError.tokenExpired(
      platform,
      `The stored ${platform === "facebook" ? "Facebook" : "Instagram"} access token has expired. Reconnect the account.`,
    );
  }
  if (!account.externalId.trim()) {
    throw PublishError.validation(
      platform,
      platform === "facebook"
        ? "The Facebook account has no Page id stored."
        : "The Instagram account has no IG user id stored.",
    );
  }
}

export type MetaRequestOptions = {
  platform: MetaPlatform;
  /** Path after the version, e.g. "/{page-id}/feed". */
  path: string;
  token: string;
  /** Used in the error message, e.g. "Creating the post". */
  label: string;
  method?: "GET" | "POST";
  params?: Record<string, string | undefined>;
  appSecret?: string;
  version?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Sends one Graph API call and returns its parsed JSON body. Any non-2xx
 * response is turned into a PublishError; transport failures become a
 * retryable network error.
 */
export async function metaRequest(options: MetaRequestOptions): Promise<Record<string, unknown>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const method = options.method ?? "POST";

  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (value !== undefined) form.set(key, value);
  }
  form.set("access_token", options.token);
  if (options.appSecret) form.set("appsecret_proof", appSecretProof(options.token, options.appSecret));

  const base = graphUrl(options.path, options.version);
  const url = method === "GET" ? `${base}?${form.toString()}` : base;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      ...(method === "POST"
        ? {
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: form.toString(),
          }
        : {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw PublishError.network(
      options.platform,
      `${options.label} could not reach Meta. This will be retried.`,
      error,
    );
  }

  if (!response.ok) {
    throw await metaErrorFromResponse(response, options.label, options.platform);
  }

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return body ?? {};
}

/** Graph error codes that mean the stored token has to be replaced. */
const TOKEN_ERROR_CODES = new Set([102, 190]);
/** Page/IG permission problems (code 200-299 is Meta's permission range). */
function isPermissionCode(code: number): boolean {
  return code === 10 || (code >= 200 && code <= 299);
}
/** App, user, Page and BUC rate limits. */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80001, 80002, 80003, 80004, 80006, 80008]);

/**
 * Subcodes that name a more specific cause than the code alone, taken from
 * Meta's error table. Meta documents 190 subcodes 458-467 as authentication
 * problems (app removed, checkpoint, password change, expired/invalid token).
 */
const AUTH_SUBCODES: Record<number, string> = {
  458: "The Facebook app was removed from the account. Reconnect it.",
  459: "Facebook is showing the account owner a login checkpoint. Clear it, then reconnect.",
  460: "The Facebook account's password changed, which invalidated the token. Reconnect.",
  463: "The token expired or was revoked. Reconnect the account.",
  464: "The account is unconfirmed or restricted. Resolve it on Facebook, then reconnect.",
  467: "Facebook reports the token as invalid. Reconnect the account.",
};

/** Instagram publishing failures, keyed by error_subcode. */
const INSTAGRAM_SUBCODES: Record<
  number,
  { code: PublishErrorCode; message: string; retryable?: boolean }
> = {
  2207004: {
    code: "validation",
    message: "Instagram rejected an image for being larger than its 8 MB limit.",
  },
  2207005: {
    code: "validation",
    message:
      "Instagram does not accept this image format. Its documentation allows JPEG only (36001).",
  },
  2207009: {
    code: "validation",
    message: "Instagram rejected an image aspect ratio outside 4:5 to 1.91:1 (36003).",
  },
  2207027: {
    code: "provider_error",
    message: "Instagram says the container is not ready to publish yet. This will be retried.",
  },
  2207006: {
    code: "validation",
    message: "Instagram cannot find that media container; it was probably never created.",
  },
  2207008: {
    code: "provider_error",
    message: "The Instagram media container expired before publishing. This will be retried.",
  },
  2207020: {
    code: "provider_error",
    message: "The Instagram media container expired. This will be retried with a fresh one.",
  },
  2207003: {
    code: "provider_error",
    message:
      "Instagram timed out downloading an image. Check that the URL is publicly reachable; this will be retried.",
  },
  2207001: {
    code: "provider_error",
    message: "Instagram reported a server error. This will be retried.",
  },
  2207032: {
    code: "provider_error",
    message: "Instagram failed to create the media container. This will be retried.",
  },
  2207050: {
    code: "permission_denied",
    message:
      "Instagram restricted or checkpointed this account. Resolve it in the Instagram app, then reconnect.",
  },
  2207042: {
    code: "rate_limited",
    message: "Instagram's daily publishing limit for this account has been reached.",
  },
  2207051: {
    code: "permission_denied",
    message: "Instagram flagged this publishing attempt as spam and refused it. Do not retry blindly.",
  },
};

type GraphErrorBody = {
  error?: {
    message?: unknown;
    type?: unknown;
    code?: unknown;
    error_subcode?: unknown;
    error_user_msg?: unknown;
    fbtrace_id?: unknown;
  } | null;
};

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Meta's BUC rate limits do not use Retry-After; they report an
 * `estimated_time_to_regain_access` (in minutes) inside the
 * X-Business-Use-Case-Usage header.
 */
export function retryAfterSeconds(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  }

  const usage = response.headers.get("x-business-use-case-usage");
  if (!usage) return undefined;

  try {
    const parsed = JSON.parse(usage) as Record<string, unknown>;
    let longestMinutes = 0;
    for (const value of Object.values(parsed)) {
      if (!Array.isArray(value)) continue;
      for (const entry of value) {
        const minutes = (entry as { estimated_time_to_regain_access?: unknown })
          .estimated_time_to_regain_access;
        if (typeof minutes === "number" && minutes > longestMinutes) longestMinutes = minutes;
      }
    }
    return longestMinutes > 0 ? Math.ceil(longestMinutes * 60) : undefined;
  } catch {
    // A malformed usage header is not worth failing the publish over.
    return undefined;
  }
}

/**
 * Maps a failed Graph response to a PublishError: reconnect for auth and
 * permission problems, retry for rate limits and server errors, and a
 * non-retryable validation error for a request Meta will never accept.
 */
export async function metaErrorFromResponse(
  response: Response,
  label: string,
  platform: MetaPlatform,
): Promise<PublishError> {
  const body = (await response.json().catch(() => null)) as GraphErrorBody | null;
  const error = body?.error ?? null;

  const rawDetail = text(error?.error_user_msg) ?? text(error?.message);
  const detail = rawDetail ? redactSecrets(rawDetail) : undefined;
  const code = typeof error?.code === "number" ? error.code : undefined;
  const subcode = typeof error?.error_subcode === "number" ? error.error_subcode : undefined;
  const status = response.status;

  const base = `${label} failed (HTTP ${status})`;
  const message = (textValue: string) => (detail ? `${textValue} ${detail}` : textValue);
  const common = { platform, status, detail, retryAfterSeconds: retryAfterSeconds(response) };

  if (subcode !== undefined) {
    const auth = AUTH_SUBCODES[subcode];
    if (auth) {
      return new PublishError({ ...common, code: "token_expired", message: `${base} ${auth}` });
    }

    if (platform === "instagram") {
      const specific = INSTAGRAM_SUBCODES[subcode];
      if (specific) {
        return new PublishError({
          ...common,
          code: specific.code,
          message: message(`${base} ${specific.message}`),
          ...(specific.retryable !== undefined ? { retryable: specific.retryable } : {}),
        });
      }
    }
  }

  if (code !== undefined && TOKEN_ERROR_CODES.has(code)) {
    return new PublishError({
      ...common,
      code: "token_expired",
      message: `${base} Meta rejected the access token (code ${code}). Reconnect the account.`,
    });
  }

  if (code !== undefined && isPermissionCode(code)) {
    return new PublishError({
      ...common,
      code: "permission_denied",
      message: `${base} The app lacks a permission this post needs (code ${code}). Reconnect and grant posting access.`,
    });
  }

  if (code !== undefined && RATE_LIMIT_CODES.has(code)) {
    return new PublishError({
      ...common,
      code: "rate_limited",
      message: `${base} Meta is rate limiting this app for now (code ${code}).`,
    });
  }

  // 100 is an invalid parameter: the request itself is wrong, so stop.
  if (code === 100 || status === 400 || status === 422) {
    return new PublishError({
      ...common,
      code: "validation",
      message: message(base),
    });
  }

  return PublishError.fromStatus(status, message(base), {
    platform,
    retryAfterSeconds: common.retryAfterSeconds,
    detail,
  });
}
