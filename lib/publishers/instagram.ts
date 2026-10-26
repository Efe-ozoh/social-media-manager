/**
 * Instagram publisher — SPEC section 7, "Instagram".
 *
 * API flavour: Instagram API with Facebook Login (graph.facebook.com), not
 * Instagram Login (graph.instagram.com). See meta-oauth.ts for why; the short
 * version is one Meta app, one consent screen, and the same Page-linked
 * account model the spec requires.
 *
 * Publishing is the documented two-step flow:
 *   1. POST /{ig-user-id}/media to create a container (single image, or one
 *      child container per slide with is_carousel_item=true).
 *   2. Poll GET /{container-id}?fields=status_code until FINISHED, then
 *      POST /{ig-user-id}/media_publish with creation_id.
 *   https://developers.facebook.com/documentation/instagram-platform/content-publishing
 *
 * Limits taken from the current docs:
 *   - caption: 2,200 characters
 *   - carousel: the guide says up to 20 items, while the error-code reference
 *     still documents 2207028 for more than 10. The conservative, documented
 *     ceiling of 10 is enforced here.
 *   - images: JPEG only, 8 MB max, aspect ratio 4:5 to 1.91:1, width 320-1440.
 *   - polling: Meta recommends querying once a minute for no more than five
 *     minutes. This polls more often but gives up sooner, and reports a
 *     retryable failure so the scheduler can try again rather than holding a
 *     request open for five minutes.
 *
 * Instagram fetches the image URLs itself, so they must be public HTTPS URLs;
 * a localhost URL is rejected with a clear error instead of failing inside
 * Meta's queue.
 */

import {
  assertMetaToken,
  assertPublicImageUrls,
  metaRequest,
  type MetaPlatform,
} from "./meta-graph";
import {
  PublishError,
  validatePublishInput,
  type PublishInput,
  type PublishResult,
  type Publisher,
} from "./types";

/** Documented caption limit. */
export const INSTAGRAM_MAX_CAPTION = 2_200;
/** Documented carousel ceiling (see the note above). */
export const INSTAGRAM_MAX_CAROUSEL_ITEMS = 10;

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_POLL_TIMEOUT_MS = 120_000;

type FetchImpl = typeof fetch;

export type InstagramPublisherOptions = {
  fetchImpl?: FetchImpl;
  /** Overrides META_GRAPH_VERSION. */
  version?: string;
  /** When set, every call carries the documented appsecret_proof. */
  appSecret?: string;
  timeoutMs?: number;
  /** Delay between status checks. */
  pollIntervalMs?: number;
  /** How long to wait for a container to finish before giving up. */
  pollTimeoutMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isPngUrl(value: string): boolean {
  try {
    return new URL(value).pathname.toLowerCase().endsWith(".png");
  } catch {
    return false;
  }
}

export class InstagramPublisher implements Publisher {
  readonly platform = "instagram" as const;
  readonly maxImages = INSTAGRAM_MAX_CAROUSEL_ITEMS;
  readonly maxCaptionLength = INSTAGRAM_MAX_CAPTION;

  private readonly options: InstagramPublisherOptions;

  constructor(options: InstagramPublisherOptions = {}) {
    this.options = options;
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const { account } = input;
    if (account.platform !== "instagram") {
      throw PublishError.validation(
        "instagram",
        `This publisher only handles Instagram accounts, not ${account.platform}.`,
      );
    }

    // Instagram fetches the images itself, so the public-URL check goes before
    // the shared one, which tolerates a localhost URL for LinkedIn.
    assertPublicImageUrls(input.imageUrls, "instagram");
    validatePublishInput(this, input);
    assertMetaToken(account, "instagram");

    if (input.imageUrls.length === 0) {
      throw PublishError.validation(
        "instagram",
        "Instagram has no text-only posts: every post needs at least one image.",
      );
    }

    const igUserId = account.externalId.trim();
    const token = account.accessToken;
    const caption = input.caption.trim();
    const notes: string[] = [];

    if (input.imageUrls.some(isPngUrl)) {
      notes.push(
        "Instagram documents JPEG as the only supported image format, but these slides are PNG. " +
          "If publishing fails with 36001 / 2207005, the renderer needs to output JPEG.",
      );
    }

    const containerId =
      input.imageUrls.length === 1
        ? await this.createContainer(
            igUserId,
            token,
            { image_url: input.imageUrls[0], caption },
            "Creating the image container",
          )
        : await this.createCarousel(igUserId, token, input.imageUrls, caption);

    await this.waitUntilReady(token, containerId);

    const published = await this.request(
      token,
      `/${igUserId}/media_publish`,
      { creation_id: containerId },
      "Publishing the post",
    );
    const externalPostId = stringField(published, "id");
    if (!externalPostId) {
      throw new PublishError({
        code: "provider_error",
        platform: "instagram",
        message:
          "Instagram accepted the publish request but returned no media id, so the post may not exist. Check the account before retrying.",
        retryable: false,
      });
    }

    return {
      externalPostId,
      publishedAt: new Date(),
      ...(notes.length > 0 ? { notes } : {}),
    };
  }

  /** One child container per slide, then the parent carousel container. */
  private async createCarousel(
    igUserId: string,
    token: string,
    imageUrls: string[],
    caption: string,
  ): Promise<string> {
    const childIds: string[] = [];

    for (const [index, url] of imageUrls.entries()) {
      childIds.push(
        await this.createContainer(
          igUserId,
          token,
          { image_url: url, is_carousel_item: "true" },
          `Creating slide ${index + 1} of ${imageUrls.length}`,
        ),
      );
    }

    return this.createContainer(
      igUserId,
      token,
      { media_type: "CAROUSEL", children: childIds.join(","), caption },
      "Creating the carousel container",
    );
  }

  private async createContainer(
    igUserId: string,
    token: string,
    params: Record<string, string>,
    label: string,
  ): Promise<string> {
    const body = await this.request(token, `/${igUserId}/media`, params, label);
    const id = stringField(body, "id");
    if (!id) {
      throw new PublishError({
        code: "provider_error",
        platform: "instagram",
        message: `${label} returned no container id, so nothing was published.`,
        retryable: false,
      });
    }
    return id;
  }

  /**
   * Polls the container until Instagram reports FINISHED. ERROR means the
   * input was rejected (usually the image), so it does not retry; a timeout
   * does, because the container may still finish.
   */
  private async waitUntilReady(token: string, containerId: string): Promise<void> {
    const sleep =
      this.options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const now = this.options.now ?? Date.now;
    const interval = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeout = this.options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    const deadline = now() + timeout;

    for (;;) {
      const body = await this.request(
        token,
        `/${containerId}`,
        { fields: "status_code" },
        "Checking the container",
        "GET",
      );
      const status = typeof body.status_code === "string" ? body.status_code : "";

      if (status === "FINISHED") return;

      if (status === "ERROR") {
        throw new PublishError({
          code: "validation",
          platform: "instagram",
          message:
            "Instagram could not process these images (container status ERROR). Check that they are JPEG, under 8 MB, and between 4:5 and 1.91:1.",
        });
      }

      if (status === "EXPIRED") {
        throw new PublishError({
          code: "provider_error",
          platform: "instagram",
          message:
            "The Instagram container expired before it could be published. This will be retried with a fresh one.",
        });
      }

      if (now() >= deadline) {
        throw new PublishError({
          code: "provider_error",
          platform: "instagram",
          message: `Instagram was still processing the container after ${Math.round(
            timeout / 1000,
          )}s${status ? ` (status ${status})` : ""}. This will be retried.`,
        });
      }

      await sleep(interval);
    }
  }

  private request(
    token: string,
    path: string,
    params: Record<string, string | undefined>,
    label: string,
    method: "GET" | "POST" = "POST",
  ): Promise<Record<string, unknown>> {
    return metaRequest({
      platform: "instagram" as MetaPlatform,
      path,
      token,
      params,
      label,
      method,
      fetchImpl: this.options.fetchImpl,
      version: this.options.version,
      appSecret: this.options.appSecret,
      timeoutMs: this.options.timeoutMs,
    });
  }
}

/** The publisher the dispatcher uses by default. */
export const instagramPublisher = new InstagramPublisher();
