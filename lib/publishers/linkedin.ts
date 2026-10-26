/**
 * LinkedIn publisher — SPEC section 7, "LinkedIn".
 *
 * API version: `Linkedin-Version: 202610` (October 2026). LinkedIn's Marketing
 * API versioning page lists 202610 as the latest at the time of writing, and
 * versions are supported for a minimum of one year before sunset:
 *   https://learn.microsoft.com/en-us/linkedin/marketing/versioning
 * The override is a constructor option so a sunset version is a one-line fix.
 *
 * Flow (all REST calls need `Linkedin-Version` and
 * `X-Restli-Protocol-Version: 2.0.0`):
 *   1. POST /rest/images?action=initializeUpload with
 *      { initializeUploadRequest: { owner: "urn:li:person:<sub>" } }
 *      → { value: { uploadUrl, image } }.
 *      https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api
 *   2. PUT the raw bytes to that presigned uploadUrl. It is a signed URL, so
 *      no Authorization or version headers are sent with it.
 *   3. POST /rest/posts with the image URN(s) and the commentary.
 *      https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
 *
 * Multi-image posts use `content.multiImage.images` (2–20 images), which is
 * distinct from the single-image `content.media`. LinkedIn documents
 * multi-image as available to API partners for non-sponsored posts, so an app
 * without that access can be refused: this publisher then republishes with
 * the first slide only, and says so in `notes`, rather than failing the post.
 *   https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/multiimage-post-api
 *
 * Tokens are never logged: error messages are built from the platform's
 * message only, after redaction, and never from request headers.
 */

import {
  PublishError,
  redactSecrets,
  validatePublishInput,
  type PublishInput,
  type PublishResult,
  type Publisher,
  type SocialAccount,
} from "./types";

/** October 2026; see the note at the top of this file. */
export const LINKEDIN_API_VERSION = "202610";
export const LINKEDIN_REST_BASE = "https://api.linkedin.com/rest";
export const LINKEDIN_POSTS_URL = `${LINKEDIN_REST_BASE}/posts`;
export const LINKEDIN_IMAGES_URL = `${LINKEDIN_REST_BASE}/images?action=initializeUpload`;

/** Documented post text limit. */
export const LINKEDIN_MAX_CAPTION = 3_000;
/** Documented multi-image range is 2–20; the splitter caps at 10 anyway. */
export const LINKEDIN_MAX_IMAGES = 20;

const REQUEST_TIMEOUT_MS = 20_000;
/** Treat a token that expires within a minute as already expired. */
const EXPIRY_SKEW_MS = 60_000;

type FetchImpl = typeof fetch;

export type LinkedInPublisherOptions = {
  fetchImpl?: typeof fetch;
  /** Overrides LINKEDIN_API_VERSION, e.g. after a version sunset. */
  apiVersion?: string;
  timeoutMs?: number;
};

type UploadedImage = { urn: string; altText: string };

/**
 * social_accounts stores the member URN, but a bare member id is accepted so
 * an older row (or a manual entry) still posts.
 */
export function personUrn(externalId: string): string {
  const value = externalId.trim();
  return value.startsWith("urn:li:") ? value : `urn:li:person:${value}`;
}

/** LinkedIn presigned upload URLs, and nothing else, may receive our bytes. */
function isLinkedInUploadUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return host === "linkedin.com" || host.endsWith(".linkedin.com") || host.endsWith(".licdn.com");
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);

  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

/** Short, redacted message from a LinkedIn error body; never the raw body. */
function messageFromBody(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;

  const text = [record.message, record.error]
    .find((value): value is string => typeof value === "string" && value.trim() !== "")
    ?.trim();
  if (!text) return undefined;

  const code = record.serviceErrorCode;
  return typeof code === "number" ? redactSecrets(`${text} (${code})`) : redactSecrets(text);
}

export class LinkedInPublisher implements Publisher {
  readonly platform = "linkedin" as const;
  readonly maxImages = LINKEDIN_MAX_IMAGES;
  readonly maxCaptionLength = LINKEDIN_MAX_CAPTION;

  private readonly fetchImpl: FetchImpl;
  private readonly apiVersion: string;
  private readonly timeoutMs: number;

  constructor(options: LinkedInPublisherOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiVersion = options.apiVersion ?? LINKEDIN_API_VERSION;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /** LinkedIn's self-service tokens cannot be refreshed; reconnect instead. */
  async publish(input: PublishInput): Promise<PublishResult> {
    validatePublishInput(this, input);

    const { account } = input;
    if (account.platform !== "linkedin") {
      throw PublishError.validation(
        "linkedin",
        `This publisher only handles LinkedIn accounts, not ${account.platform}.`,
      );
    }
    this.assertTokenUsable(account);

    const author = personUrn(account.externalId);
    const notes: string[] = [];

    const images: UploadedImage[] = [];
    for (const [index, url] of input.imageUrls.entries()) {
      images.push(
        await this.uploadImage({
          url,
          author,
          account,
          position: index + 1,
          total: input.imageUrls.length,
        }),
      );
    }

    const externalPostId = await this.createPost({
      author,
      commentary: input.caption.trim(),
      images,
      account,
      notes,
    });

    return {
      externalPostId,
      publishedAt: new Date(),
      ...(notes.length > 0 ? { notes } : {}),
    };
  }

  private assertTokenUsable(account: SocialAccount): void {
    if (!account.accessToken) {
      throw PublishError.tokenExpired("linkedin", "No LinkedIn access token is stored. Reconnect the account.");
    }
    if (account.expiresAt && account.expiresAt.getTime() <= Date.now() + EXPIRY_SKEW_MS) {
      throw PublishError.tokenExpired(
        "linkedin",
        "The LinkedIn access token has expired. Reconnect the account.",
      );
    }
    if (!account.externalId.trim()) {
      throw PublishError.validation("linkedin", "The LinkedIn account has no member id stored.");
    }
  }

  private headers(account: SocialAccount, json: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${account.accessToken}`,
      "Linkedin-Version": this.apiVersion,
      "X-Restli-Protocol-Version": "2.0.0",
      ...(json ? { "Content-Type": "application/json" } : {}),
    };
  }

  /** Thin fetch wrapper: every transport failure becomes a retryable error. */
  private async send(url: string, init: RequestInit, label: string): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw PublishError.network(
        "linkedin",
        `${label} could not reach LinkedIn. This will be retried.`,
        error,
      );
    }
  }

  /** Builds a PublishError from a failed REST response. */
  private async httpError(response: Response, label: string): Promise<PublishError> {
    const detail = messageFromBody(await response.json().catch(() => null));
    const status = response.status;
    const base = `${label} failed (HTTP ${status}).`;

    if (status === 401) {
      return new PublishError({
        code: "token_expired",
        platform: "linkedin",
        status,
        message: "LinkedIn rejected the access token. Reconnect the account.",
        detail,
      });
    }
    if (status === 403) {
      return new PublishError({
        code: "permission_denied",
        platform: "linkedin",
        status,
        message:
          "LinkedIn refused the request for lack of permission. Reconnect the account and grant posting access.",
        detail,
      });
    }

    return PublishError.fromStatus(status, detail ? `${base} ${detail}` : base, {
      platform: "linkedin",
      retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")),
      detail,
    });
  }

  /** Downloads a slide and registers it with LinkedIn, returning its image URN. */
  private async uploadImage(options: {
    url: string;
    author: string;
    account: SocialAccount;
    position: number;
    total: number;
  }): Promise<UploadedImage> {
    const label = `Slide ${options.position}`;

    // 1. Our own slide, fetched from the image store.
    let download: Response;
    try {
      download = await this.fetchImpl(options.url, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw PublishError.network(
        "linkedin",
        `${label} could not be downloaded from the image store. This will be retried.`,
        error,
      );
    }
    if (!download.ok) {
      throw PublishError.fromStatus(
        download.status,
        `${label} could not be downloaded from the image store (HTTP ${download.status}).`,
        { platform: "linkedin" },
      );
    }

    const bytes = Buffer.from(await download.arrayBuffer());
    if (bytes.length === 0) {
      throw new PublishError({
        code: "provider_error",
        platform: "linkedin",
        message: `${label} downloaded as an empty file. This will be retried.`,
      });
    }

    // 2. Register the upload and get a presigned URL plus the image URN.
    const init = await this.send(
      LINKEDIN_IMAGES_URL,
      {
        method: "POST",
        headers: this.headers(options.account, true),
        body: JSON.stringify({ initializeUploadRequest: { owner: options.author } }),
      },
      `Registering ${label.toLowerCase()}`,
    );
    if (!init.ok) throw await this.httpError(init, `Registering ${label.toLowerCase()}`);

    const payload = (await init.json().catch(() => null)) as {
      value?: { uploadUrl?: unknown; image?: unknown };
    } | null;
    const uploadUrl = payload?.value?.uploadUrl;
    const imageUrn = payload?.value?.image;

    if (typeof uploadUrl !== "string" || typeof imageUrn !== "string" || !imageUrn) {
      throw new PublishError({
        code: "provider_error",
        platform: "linkedin",
        message: `LinkedIn did not return an upload URL for ${label.toLowerCase()}. This will be retried.`,
      });
    }
    if (!isLinkedInUploadUrl(uploadUrl)) {
      // Not transient: retrying cannot make the host trustworthy.
      throw new PublishError({
        code: "provider_error",
        platform: "linkedin",
        message: "LinkedIn returned an upload URL on an unexpected host; refusing to upload.",
        retryable: false,
      });
    }

    // 3. PUT the bytes to the signed URL. No Authorization header here: the
    //    signature is the credential, and an extra header can invalidate it.
    const upload = await this.send(
      uploadUrl,
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(bytes),
      },
      `Uploading ${label.toLowerCase()}`,
    );
    if (!upload.ok) throw await this.httpError(upload, `Uploading ${label.toLowerCase()}`);

    return { urn: imageUrn, altText: `Slide ${options.position} of ${options.total}` };
  }

  private postBody(options: {
    author: string;
    commentary: string;
    images: UploadedImage[];
  }): Record<string, unknown> {
    const body: Record<string, unknown> = {
      author: options.author,
      commentary: options.commentary,
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    };

    if (options.images.length === 1) {
      body.content = {
        media: { id: options.images[0].urn, altText: options.images[0].altText },
      };
    } else if (options.images.length > 1) {
      body.content = {
        multiImage: {
          images: options.images.map((image) => ({ id: image.urn, altText: image.altText })),
        },
      };
    }

    return body;
  }

  /** Creates the post, falling back to one image if multi-image is refused. */
  private async createPost(options: {
    author: string;
    commentary: string;
    images: UploadedImage[];
    account: SocialAccount;
    notes: string[];
  }): Promise<string> {
    const attempt = async (images: UploadedImage[]) => {
      const response = await this.send(
        LINKEDIN_POSTS_URL,
        {
          method: "POST",
          headers: this.headers(options.account, true),
          body: JSON.stringify(
            this.postBody({
              author: options.author,
              commentary: options.commentary,
              images,
            }),
          ),
        },
        "Creating the post",
      );

      if (!response.ok) return { ok: false as const, error: await this.httpError(response, "Creating the post") };

      // LinkedIn returns 201 and the post URN in the x-restli-id header.
      const headerId = response.headers.get("x-restli-id");
      if (headerId) return { ok: true as const, externalPostId: headerId };

      const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
      if (typeof body?.id === "string" && body.id) {
        return { ok: true as const, externalPostId: body.id };
      }

      return {
        ok: false as const,
        error: new PublishError({
          code: "provider_error",
          platform: "linkedin",
          status: response.status,
          message:
            "LinkedIn accepted the request but returned no post id, so the post may not exist. Check the LinkedIn feed before retrying.",
          retryable: false,
        }),
      };
    };

    const first = await attempt(options.images);
    if (first.ok) return first.externalPostId;

    // 400/403/422 on a multi-image post usually means this app type may not
    // create them. One image is always allowed, so republish with the first
    // slide rather than failing the whole post. Never fall back on 401, 429 or
    // 5xx: those would fail the single-image attempt too, or be retried.
    const refusedMultiImage =
      options.images.length > 1 && [400, 403, 422].includes(first.error.status ?? 0);

    if (refusedMultiImage) {
      const single = await attempt([options.images[0]]);
      if (single.ok) {
        options.notes.push(
          `LinkedIn did not accept a multi-image post, so it was published with the first slide only (${first.error.status}).`,
        );
        return single.externalPostId;
      }
      throw single.error;
    }

    throw first.error;
  }
}

/** The publisher the dispatcher uses by default. */
export const linkedinPublisher = new LinkedInPublisher();
