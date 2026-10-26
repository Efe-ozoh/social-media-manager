import { describe, expect, it } from "vitest";
import { FacebookPublisher, FACEBOOK_MAX_CAPTION, FACEBOOK_MAX_IMAGES } from "./facebook";
import { graphUrl } from "./meta-graph";
import { PublishError, type PublishInput, type SocialAccount } from "./types";

const TOKEN = "EAAsecret-page-token-do-not-leak-0123456789";
const PAGE_ID = "1234567890";
const VERSION = "v26.0";

type Call = { url: string; init: RequestInit; body: string | null };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function account(overrides: Partial<SocialAccount> = {}): SocialAccount {
  return {
    id: "acc-1",
    platform: "facebook",
    externalId: PAGE_ID,
    displayName: "CodeSync Hub Page",
    accessToken: TOKEN,
    refreshToken: null,
    // Page tokens from long-lived user tokens have no expiry.
    expiresAt: null,
    ...overrides,
  };
}

function input(overrides: Partial<PublishInput> = {}): PublishInput {
  return {
    caption: "A short post about rendering slides.",
    imageUrls: [],
    account: account(),
    ...overrides,
  };
}

type Route = (call: Call) => Response | Promise<Response> | undefined;

function mockFetch(route: Route): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];

  const fetchImpl = (async (resource: RequestInfo | URL, init: RequestInit = {}) => {
    const url =
      typeof resource === "string"
        ? resource
        : resource instanceof URL
          ? resource.toString()
          : resource.url;
    const body =
      typeof init.body === "string"
        ? init.body
        : init.body instanceof URLSearchParams
          ? init.body.toString()
          : null;
    const call: Call = { url, init, body };
    calls.push(call);

    const response = await route(call);
    if (!response) throw new Error(`unexpected request: ${init.method ?? "GET"} ${url}`);
    return response;
  }) as typeof fetch;

  return { fetchImpl, calls };
}

const photosUrl = graphUrl(`/${PAGE_ID}/photos`, VERSION);
const feedUrl = graphUrl(`/${PAGE_ID}/feed`, VERSION);
const slideUrl = (index: number) => `https://cdn.example.com/slide-${index}.png`;

function form(call: Call): URLSearchParams {
  return new URLSearchParams(call.body ?? "");
}

async function publishError(promise: Promise<unknown>): Promise<PublishError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PublishError);
    return error as PublishError;
  }
  throw new Error("expected the publish to fail");
}

describe("FacebookPublisher", () => {
  it("declares its limits", () => {
    const publisher = new FacebookPublisher();
    expect(publisher.platform).toBe("facebook");
    expect(publisher.maxCaptionLength).toBe(FACEBOOK_MAX_CAPTION);
    expect(publisher.maxImages).toBe(FACEBOOK_MAX_IMAGES);
  });

  it("posts text to the Page feed with the Page token", async () => {
    const { fetchImpl, calls } = mockFetch(() => json({ id: `${PAGE_ID}_777` }));
    const publisher = new FacebookPublisher({ fetchImpl });

    const result = await publisher.publish(input());

    expect(result.externalPostId).toBe(`${PAGE_ID}_777`);
    expect(result.publishedAt).toBeInstanceOf(Date);
    expect(result.notes).toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(feedUrl);
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );

    const params = form(calls[0]);
    expect(params.get("message")).toBe("A short post about rendering slides.");
    expect(params.get("access_token")).toBe(TOKEN);
  });

  it("publishes one photo in a single request and prefers post_id", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      json({ id: "photo-1", post_id: `${PAGE_ID}_888` }),
    );
    const publisher = new FacebookPublisher({ fetchImpl });

    const result = await publisher.publish(input({ imageUrls: [slideUrl(1)] }));

    expect(result.externalPostId).toBe(`${PAGE_ID}_888`);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(photosUrl);

    const params = form(calls[0]);
    expect(params.get("url")).toBe(slideUrl(1));
    expect(params.get("caption")).toBe("A short post about rendering slides.");
    expect(params.get("published")).toBe("true");
  });

  it("uploads unpublished photos and attaches their ids to one feed post", async () => {
    let uploads = 0;
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.url === photosUrl) {
        uploads += 1;
        return json({ id: `photo-${uploads}` });
      }
      if (call.url === feedUrl) return json({ id: `${PAGE_ID}_999` });
      return undefined;
    });
    const publisher = new FacebookPublisher({ fetchImpl });

    const result = await publisher.publish(
      input({ imageUrls: [slideUrl(1), slideUrl(2), slideUrl(3)] }),
    );

    expect(result.externalPostId).toBe(`${PAGE_ID}_999`);
    expect(calls).toHaveLength(4);
    expect(result.notes).toBeUndefined();

    const uploadsCalls = calls.filter((call) => call.url === photosUrl);
    expect(uploadsCalls).toHaveLength(3);
    for (const [index, call] of uploadsCalls.entries()) {
      const params = form(call);
      expect(params.get("url")).toBe(slideUrl(index + 1));
      expect(params.get("published")).toBe("false");
      // Unpublished uploads carry no caption; the feed post has the text.
      expect(params.get("caption")).toBeNull();
    }

    const feedParams = form(calls[3]);
    expect(feedParams.get("message")).toBe("A short post about rendering slides.");
    expect(feedParams.get("attached_media[0]")).toBe(JSON.stringify({ media_fbid: "photo-1" }));
    expect(feedParams.get("attached_media[1]")).toBe(JSON.stringify({ media_fbid: "photo-2" }));
    expect(feedParams.get("attached_media[2]")).toBe(JSON.stringify({ media_fbid: "photo-3" }));
  });

  it("refuses a localhost image URL before calling Meta", async () => {
    const { fetchImpl, calls } = mockFetch(() => json({ id: "x" }));
    const publisher = new FacebookPublisher({ fetchImpl });

    const error = await publishError(
      publisher.publish(input({ imageUrls: ["http://localhost:3000/uploads/slide-1.png"] })),
    );

    expect(error.code).toBe("validation");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("cannot reach");
    expect(calls).toHaveLength(0);
  });

  it("rejects input the Page cannot accept, without a network call", async () => {
    const { fetchImpl, calls } = mockFetch(() => json({ id: "x" }));
    const publisher = new FacebookPublisher({ fetchImpl });

    await expect(publisher.publish(input({ caption: "x".repeat(FACEBOOK_MAX_CAPTION + 1) }))).rejects.toMatchObject({
      code: "validation",
    });
    await expect(publisher.publish(input({ caption: "  " }))).rejects.toMatchObject({
      code: "validation",
    });
    await expect(
      publisher.publish(
        input({ imageUrls: Array.from({ length: FACEBOOK_MAX_IMAGES + 1 }, (_, i) => slideUrl(i)) }),
      ),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      publisher.publish(input({ account: account({ platform: "instagram" }) })),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      publisher.publish(input({ account: account({ expiresAt: new Date(Date.now() - 1_000) }) })),
    ).rejects.toMatchObject({ code: "token_expired", retryable: false });

    expect(calls).toHaveLength(0);
  });

  it("maps an expired token (code 190) to a reconnect error", async () => {
    const { fetchImpl } = mockFetch(() =>
      json(
        {
          error: {
            message: "Error validating access token",
            type: "OAuthException",
            code: 190,
            error_subcode: 463,
            fbtrace_id: "abc",
          },
        },
        400,
      ),
    );
    const publisher = new FacebookPublisher({ fetchImpl });

    const error = await publishError(publisher.publish(input()));

    expect(error.code).toBe("token_expired");
    expect(error.retryable).toBe(false);
    expect(error.requiresReconnect).toBe(true);
    expect(error.status).toBe(400);
  });

  it("maps a missing permission (code 10) to a reconnect error", async () => {
    const { fetchImpl } = mockFetch(() =>
      json({ error: { message: "Permissions error", code: 10 } }, 403),
    );
    const publisher = new FacebookPublisher({ fetchImpl });

    const error = await publishError(publisher.publish(input()));

    expect(error.code).toBe("permission_denied");
    expect(error.requiresReconnect).toBe(true);
    expect(error.retryable).toBe(false);
  });

  it("reads the BUC rate-limit window into retryAfterSeconds", async () => {
    const usage = JSON.stringify({
      "1234": [
        {
          type: "pages",
          call_count: 100,
          total_cputime: 90,
          total_time: 90,
          estimated_time_to_regain_access: 12,
        },
      ],
    });
    const { fetchImpl } = mockFetch(() =>
      json({ error: { message: "Calls to this api have exceeded the rate limit", code: 80001 } }, 400, {
        "x-business-use-case-usage": usage,
      }),
    );
    const publisher = new FacebookPublisher({ fetchImpl });

    const error = await publishError(publisher.publish(input()));

    expect(error.code).toBe("rate_limited");
    expect(error.retryable).toBe(true);
    expect(error.retryAfterSeconds).toBe(12 * 60);
  });

  it("treats an invalid parameter as a permanent validation error", async () => {
    const { fetchImpl } = mockFetch(() =>
      json({ error: { message: "(#100) Invalid parameter", code: 100 } }, 400),
    );
    const publisher = new FacebookPublisher({ fetchImpl });

    const error = await publishError(publisher.publish(input()));

    expect(error.code).toBe("validation");
    expect(error.retryable).toBe(false);
    expect(error.detail).toContain("Invalid parameter");
  });

  it("retries server errors and transport failures", async () => {
    const failing = mockFetch(() => json({ error: { message: "Unknown" } }, 500));
    const error = await publishError(
      new FacebookPublisher({ fetchImpl: failing.fetchImpl }).publish(input()),
    );
    expect(error.code).toBe("provider_error");
    expect(error.retryable).toBe(true);

    const offline = mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    const networkError = await publishError(
      new FacebookPublisher({ fetchImpl: offline.fetchImpl }).publish(input()),
    );
    expect(networkError.code).toBe("network");
    expect(networkError.retryable).toBe(true);
  });

  it("adds appsecret_proof only when an app secret is configured", async () => {
    const withSecret = mockFetch(() => json({ id: "1" }));
    await new FacebookPublisher({ fetchImpl: withSecret.fetchImpl, appSecret: "s3cret" }).publish(
      input(),
    );
    const proof = form(withSecret.calls[0]).get("appsecret_proof");
    expect(proof).toMatch(/^[a-f0-9]{64}$/);

    const withoutSecret = mockFetch(() => json({ id: "1" }));
    await new FacebookPublisher({ fetchImpl: withoutSecret.fetchImpl }).publish(input());
    expect(form(withoutSecret.calls[0]).get("appsecret_proof")).toBeNull();
  });

  it("never puts the access token in an error", async () => {
    const { fetchImpl } = mockFetch(() =>
      json({ error: { message: `Bad token EAA${"x".repeat(30)}`, code: 190 } }, 401),
    );
    const publisher = new FacebookPublisher({ fetchImpl });

    const error = await publishError(publisher.publish(input()));

    expect(error.message).not.toContain(TOKEN);
    expect(error.detail).not.toContain(TOKEN);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });

  it("fails rather than posting a carousel missing a photo id", async () => {
    let uploads = 0;
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.url === photosUrl) {
        uploads += 1;
        return json(uploads === 2 ? { success: true } : { id: `photo-${uploads}` });
      }
      return json({ id: "feed" });
    });
    const publisher = new FacebookPublisher({ fetchImpl });

    const error = await publishError(
      publisher.publish(input({ imageUrls: [slideUrl(1), slideUrl(2)] })),
    );

    expect(error.retryable).toBe(false);
    expect(error.message).toContain("no photo id");
    // Nothing was posted to the feed.
    expect(calls.some((call) => call.url === feedUrl)).toBe(false);
  });
});
