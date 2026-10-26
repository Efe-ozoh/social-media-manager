/**
 * Facebook Page publisher — SPEC section 7, "Facebook".
 *
 * Posts to a Page with a Page access token (the Page Feed and Page Photos
 * references both require one; a user token is only how that Page token is
 * obtained):
 *   https://developers.facebook.com/docs/graph-api/reference/page/feed/
 *   https://developers.facebook.com/docs/graph-api/reference/page/photos/
 *
 * One image uses `POST /{page-id}/photos` with `url` and `published=true`,
 * which Meta documents as uploading and publishing a single photo in one
 * request. Several images use the documented multi-photo flow: upload each
 * photo with `published=false`, then create one feed post whose
 * `attached_media[i]` fields reference those photo IDs. Those unpublished
 * uploads stay available for about 24 hours, so the feed post is created
 * immediately after the last upload.
 *
 * Meta does not document a maximum number of `attached_media` entries (its
 * "maximum of 10" applies to multi-link `child_attachments`), so the cap here
 * is our own carousel limit.
 *
 * Meta fetches every image URL itself, which is why the URLs must be public
 * HTTPS: see `assertPublicImageUrls`.
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

/** Documented Page post text limit. */
export const FACEBOOK_MAX_CAPTION = 63_206;
/** Our carousel cap; Meta documents no attached_media maximum. */
export const FACEBOOK_MAX_IMAGES = 10;

type FetchImpl = typeof fetch;

export type FacebookPublisherOptions = {
  fetchImpl?: FetchImpl;
  /** Overrides META_GRAPH_VERSION. */
  version?: string;
  /** When set, every call carries the documented appsecret_proof. */
  appSecret?: string;
  timeoutMs?: number;
};

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

export class FacebookPublisher implements Publisher {
  readonly platform = "facebook" as const;
  readonly maxImages = FACEBOOK_MAX_IMAGES;
  readonly maxCaptionLength = FACEBOOK_MAX_CAPTION;

  private readonly options: FacebookPublisherOptions;

  constructor(options: FacebookPublisherOptions = {}) {
    this.options = options;
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const { account } = input;
    if (account.platform !== "facebook") {
      throw PublishError.validation(
        "facebook",
        `This publisher only handles Facebook accounts, not ${account.platform}.`,
      );
    }

    // Meta fetches the images itself, so the public-URL check goes before the
    // shared one, which tolerates a localhost URL for LinkedIn's byte upload.
    assertPublicImageUrls(input.imageUrls, "facebook");
    validatePublishInput(this, input);
    assertMetaToken(account, "facebook");

    const pageId = account.externalId.trim();
    const caption = input.caption.trim();

    let externalPostId: string;
    if (input.imageUrls.length === 0) {
      externalPostId = await this.postToFeed(pageId, account.accessToken, caption);
    } else if (input.imageUrls.length === 1) {
      externalPostId = await this.postOnePhoto(pageId, account.accessToken, caption, input.imageUrls[0]);
    } else {
      externalPostId = await this.postManyPhotos(
        pageId,
        account.accessToken,
        caption,
        input.imageUrls,
      );
    }

    return { externalPostId, publishedAt: new Date() };
  }

  /** A text-only Page post. */
  private async postToFeed(pageId: string, token: string, message: string): Promise<string> {
    const body = await this.request(pageId, token, "/feed", { message }, "Creating the post");
    return this.requirePostId(body, "Facebook accepted the post but returned no id");
  }

  /** One photo, published in the same request. */
  private async postOnePhoto(
    pageId: string,
    token: string,
    caption: string,
    url: string,
  ): Promise<string> {
    const body = await this.request(
      pageId,
      token,
      "/photos",
      { url, caption, published: "true" },
      "Posting the photo",
    );

    // The photo has an id and the feed story a post_id; the post is the post.
    return this.requirePostId(
      body,
      "Facebook accepted the photo but returned no post id",
      "post_id",
      "id",
    );
  }

  /** Several photos: upload unpublished, then attach the ids to one feed post. */
  private async postManyPhotos(
    pageId: string,
    token: string,
    caption: string,
    urls: string[],
  ): Promise<string> {
    const photoIds: string[] = [];

    for (const [index, url] of urls.entries()) {
      const body = await this.request(
        pageId,
        token,
        "/photos",
        { url, published: "false" },
        `Uploading slide ${index + 1}`,
      );
      const photoId = stringField(body, "id");
      if (!photoId) {
        throw new PublishError({
          code: "provider_error",
          platform: "facebook",
          message: `Facebook accepted slide ${index + 1} but returned no photo id; nothing was posted.`,
          retryable: false,
        });
      }
      photoIds.push(photoId);
    }

    const params: Record<string, string> = { message: caption };
    photoIds.forEach((photoId, index) => {
      params[`attached_media[${index}]`] = JSON.stringify({ media_fbid: photoId });
    });

    const body = await this.request(pageId, token, "/feed", params, "Creating the post");
    return this.requirePostId(body, "Facebook accepted the post but returned no id");
  }

  private requirePostId(
    body: Record<string, unknown>,
    message: string,
    ...keys: string[]
  ): string {
    for (const key of keys.length > 0 ? keys : ["id", "post_id"]) {
      const id = stringField(body, key);
      if (id) return id;
    }
    throw new PublishError({
      code: "provider_error",
      platform: "facebook",
      message: `${message}, so it may not exist. Check the Page before retrying.`,
      retryable: false,
    });
  }

  private request(
    pageId: string,
    token: string,
    path: string,
    params: Record<string, string | undefined>,
    label: string,
  ): Promise<Record<string, unknown>> {
    return metaRequest({
      platform: "facebook" as MetaPlatform,
      path: `/${pageId}${path}`,
      token,
      params,
      label,
      fetchImpl: this.options.fetchImpl,
      version: this.options.version,
      appSecret: this.options.appSecret,
      timeoutMs: this.options.timeoutMs,
    });
  }
}

/** The publisher the dispatcher uses by default. */
export const facebookPublisher = new FacebookPublisher();
