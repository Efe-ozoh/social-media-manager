import { describe, expect, it } from "vitest";
import {
  LINKEDIN_API_VERSION,
  LINKEDIN_IMAGES_URL,
  LINKEDIN_POSTS_URL,
  personUrn,
  LinkedInPublisher,
} from "./linkedin";
import { PublishError, type PublishInput, type SocialAccount } from "./types";

const TOKEN = "AQV-secret-member-token-do-not-leak-0123456789";
const MEMBER_URN = "urn:li:person:abc123";
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

type Call = { url: string; init: RequestInit; body: unknown };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function account(overrides: Partial<SocialAccount> = {}): SocialAccount {
  return {
    id: "acc-1",
    platform: "linkedin",
    externalId: MEMBER_URN,
    displayName: "Ada Lovelace",
    accessToken: TOKEN,
    refreshToken: null,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
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

/** fetch stand-in that records calls and routes by URL. */
function mockFetch(route: Route): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];

  const fetchImpl = (async (resource: RequestInfo | URL, init: RequestInit = {}) => {
    const url =
      typeof resource === "string"
        ? resource
        : resource instanceof URL
          ? resource.toString()
          : resource.url;
    const call: Call = { url, init, body: init.body };
    calls.push(call);

    const response = await route(call);
    if (!response) throw new Error(`unexpected request: ${init.method ?? "GET"} ${url}`);
    return response;
  }) as typeof fetch;

  return { fetchImpl, calls };
}

/** A LinkedIn that accepts everything: uploads, then a 201 post. */
function healthyRoute(options: {
  postResponse?: (call: Call) => Response | undefined;
  imageCount?: () => number;
} = {}): Route {
  let uploads = 0;

  return (call) => {
    if (call.url.startsWith("https://images.test/")) {
      return new Response(new Uint8Array(PNG), { status: 200 });
    }
    if (call.url === LINKEDIN_IMAGES_URL) {
      uploads += 1;
      options.imageCount?.();
      return json({
        value: {
          uploadUrl: `https://www.linkedin.com/dms-uploads/${uploads}`,
          image: `urn:li:image:img${uploads}`,
          uploadUrlExpiresAt: Date.now() + 60_000,
        },
      });
    }
    if (call.url.startsWith("https://www.linkedin.com/dms-uploads/")) {
      return new Response(null, { status: 201 });
    }
    if (call.url === LINKEDIN_POSTS_URL) {
      const override = options.postResponse?.(call);
      if (override) return override;
      return new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:777" } });
    }
    return undefined;
  };
}

const slideUrl = (index: number) => `https://images.test/slide-${index}.png`;

async function publishError(promise: Promise<unknown>): Promise<PublishError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PublishError);
    return error as PublishError;
  }
  throw new Error("expected the publish to fail");
}

describe("personUrn", () => {
  it("accepts a stored URN or a bare member id", () => {
    expect(personUrn("urn:li:person:abc")).toBe("urn:li:person:abc");
    expect(personUrn("abc")).toBe("urn:li:person:abc");
    expect(personUrn("  abc  ")).toBe("urn:li:person:abc");
  });
});

describe("LinkedInPublisher", () => {
  it("declares the documented limits", () => {
    const publisher = new LinkedInPublisher();
    expect(publisher.platform).toBe("linkedin");
    expect(publisher.maxImages).toBe(20);
    expect(publisher.maxCaptionLength).toBe(3_000);
  });

  it("publishes a text-only post with the documented headers", async () => {
    const { fetchImpl, calls } = mockFetch(healthyRoute());
    const publisher = new LinkedInPublisher({ fetchImpl });

    const result = await publisher.publish(input());

    expect(result.externalPostId).toBe("urn:li:share:777");
    expect(result.publishedAt).toBeInstanceOf(Date);
    expect(result.notes).toBeUndefined();
    expect(calls).toHaveLength(1);

    const [call] = calls;
    expect(call.url).toBe(LINKEDIN_POSTS_URL);
    expect(call.init.method).toBe("POST");

    const headers = call.init.headers as Record<string, string>;
    expect(headers["Linkedin-Version"]).toBe(LINKEDIN_API_VERSION);
    expect(headers["X-Restli-Protocol-Version"]).toBe("2.0.0");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);

    const body = JSON.parse(String(call.body));
    expect(body).toMatchObject({
      author: MEMBER_URN,
      commentary: "A short post about rendering slides.",
      visibility: "PUBLIC",
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
    });
    expect(body.content).toBeUndefined();
  });

  it("uploads a single slide and posts it as content.media", async () => {
    const { fetchImpl, calls } = mockFetch(healthyRoute());
    const publisher = new LinkedInPublisher({ fetchImpl });

    await publisher.publish(input({ imageUrls: [slideUrl(1)] }));

    const download = calls[0];
    expect(download.url).toBe(slideUrl(1));

    const init = calls[1];
    expect(init.url).toBe(LINKEDIN_IMAGES_URL);
    expect(JSON.parse(String(init.body))).toEqual({
      initializeUploadRequest: { owner: MEMBER_URN },
    });

    // The presigned PUT carries raw bytes and no bearer token.
    const upload = calls[2];
    expect(upload.url).toBe("https://www.linkedin.com/dms-uploads/1");
    expect(upload.init.method).toBe("PUT");
    expect(upload.init.body).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(upload.init.body as Uint8Array).equals(PNG)).toBe(true);
    const uploadHeaders = upload.init.headers as Record<string, string>;
    expect(uploadHeaders["Content-Type"]).toBe("application/octet-stream");
    expect(uploadHeaders.Authorization).toBeUndefined();
    expect(uploadHeaders["Linkedin-Version"]).toBeUndefined();

    const post = JSON.parse(String(calls[3].body));
    expect(post.content).toEqual({ media: { id: "urn:li:image:img1", altText: "Slide 1 of 1" } });
  });

  it("posts several slides as content.multiImage in slide order", async () => {
    const { fetchImpl, calls } = mockFetch(healthyRoute());
    const publisher = new LinkedInPublisher({ fetchImpl });

    await publisher.publish(input({ imageUrls: [slideUrl(1), slideUrl(2), slideUrl(3)] }));

    const post = calls.filter((call) => call.url === LINKEDIN_POSTS_URL);
    expect(post).toHaveLength(1);

    const body = JSON.parse(String(post[0].body));
    expect(body.content.multiImage.images).toEqual([
      { id: "urn:li:image:img1", altText: "Slide 1 of 3" },
      { id: "urn:li:image:img2", altText: "Slide 2 of 3" },
      { id: "urn:li:image:img3", altText: "Slide 3 of 3" },
    ]);
    expect(body.content.media).toBeUndefined();
  });

  it("falls back to the first slide when multi-image is refused", async () => {
    const { fetchImpl, calls } = mockFetch(
      healthyRoute({
        postResponse: (call) => {
          const body = JSON.parse(String(call.body));
          if (body.content?.multiImage) {
            return json({ message: "multiImage is not available for this app", status: 422 }, 422);
          }
          return new Response(null, {
            status: 201,
            headers: { "x-restli-id": "urn:li:share:888" },
          });
        },
      }),
    );
    const publisher = new LinkedInPublisher({ fetchImpl });

    const result = await publisher.publish(input({ imageUrls: [slideUrl(1), slideUrl(2)] }));

    expect(result.externalPostId).toBe("urn:li:share:888");
    expect(result.notes?.[0]).toContain("first slide only");
    expect(result.notes?.[0]).toContain("422");

    const posts = calls.filter((call) => call.url === LINKEDIN_POSTS_URL);
    expect(posts).toHaveLength(2);
    expect(JSON.parse(String(posts[1].body)).content).toEqual({
      media: { id: "urn:li:image:img1", altText: "Slide 1 of 2" },
    });
  });

  it("does not fall back on an auth failure", async () => {
    const { fetchImpl, calls } = mockFetch(
      healthyRoute({ postResponse: () => json({ message: "Invalid token", status: 401 }, 401) }),
    );
    const publisher = new LinkedInPublisher({ fetchImpl });

    const error = await publishError(
      publisher.publish(input({ imageUrls: [slideUrl(1), slideUrl(2)] })),
    );

    expect(error.code).toBe("token_expired");
    expect(error.retryable).toBe(false);
    expect(error.requiresReconnect).toBe(true);
    expect(calls.filter((call) => call.url === LINKEDIN_POSTS_URL)).toHaveLength(1);
  });

  it("reads the post id from the body when the header is missing", async () => {
    const { fetchImpl } = mockFetch(
      healthyRoute({ postResponse: () => json({ id: "urn:li:share:999" }, 201) }),
    );
    const publisher = new LinkedInPublisher({ fetchImpl });

    const result = await publisher.publish(input());
    expect(result.externalPostId).toBe("urn:li:share:999");
  });

  it("refuses to publish with an expired token, before any network call", async () => {
    const { fetchImpl, calls } = mockFetch(healthyRoute());
    const publisher = new LinkedInPublisher({ fetchImpl });

    const error = await publishError(
      publisher.publish(
        input({
          account: account({ expiresAt: new Date(Date.now() - 1_000) }),
          imageUrls: [slideUrl(1)],
        }),
      ),
    );

    expect(error.code).toBe("token_expired");
    expect(error.retryable).toBe(false);
    expect(error.requiresReconnect).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("rejects input the platform cannot accept, without any network call", async () => {
    const { fetchImpl, calls } = mockFetch(healthyRoute());
    const publisher = new LinkedInPublisher({ fetchImpl });

    await expect(
      publisher.publish(input({ caption: "x".repeat(3_001) })),
    ).rejects.toMatchObject({ code: "validation", retryable: false });

    await expect(publisher.publish(input({ caption: "  " }))).rejects.toMatchObject({
      code: "validation",
    });

    await expect(
      publisher.publish(
        input({ imageUrls: Array.from({ length: 21 }, (_, index) => slideUrl(index)) }),
      ),
    ).rejects.toMatchObject({ code: "validation" });

    await expect(
      publisher.publish(input({ imageUrls: ["http://example.com/slide.png"] })),
    ).rejects.toMatchObject({ code: "validation" });

    await expect(
      publisher.publish(input({ account: account({ platform: "instagram" }) })),
    ).rejects.toMatchObject({ code: "validation" });

    expect(calls).toHaveLength(0);
  });

  it("maps a 403 from the Images API to a reconnect error", async () => {
    const { fetchImpl } = mockFetch((call) => {
      if (call.url.startsWith("https://images.test/")) return new Response(new Uint8Array(PNG));
      if (call.url === LINKEDIN_IMAGES_URL) {
        return json({ message: "Accessing this image resource is forbidden.", status: 403 }, 403);
      }
      return undefined;
    });
    const publisher = new LinkedInPublisher({ fetchImpl });

    const error = await publishError(publisher.publish(input({ imageUrls: [slideUrl(1)] })));

    expect(error.code).toBe("permission_denied");
    expect(error.retryable).toBe(false);
    expect(error.requiresReconnect).toBe(true);
    expect(error.status).toBe(403);
    expect(error.detail).toContain("forbidden");
  });

  it("retries rate limits and keeps the Retry-After value", async () => {
    const { fetchImpl } = mockFetch(
      healthyRoute({
        postResponse: () =>
          json({ message: "Too many requests", status: 429 }, 429, { "retry-after": "30" }),
      }),
    );
    const publisher = new LinkedInPublisher({ fetchImpl });

    const error = await publishError(publisher.publish(input()));

    expect(error.code).toBe("rate_limited");
    expect(error.retryable).toBe(true);
    expect(error.retryAfterSeconds).toBe(30);
  });

  it("treats a 5xx as retryable", async () => {
    const { fetchImpl } = mockFetch(
      healthyRoute({ postResponse: () => json({ message: "Internal error" }, 503) }),
    );
    const publisher = new LinkedInPublisher({ fetchImpl });

    const error = await publishError(publisher.publish(input()));
    expect(error.code).toBe("provider_error");
    expect(error.retryable).toBe(true);
    expect(error.status).toBe(503);
  });

  it("treats a transport failure as retryable", async () => {
    const { fetchImpl } = mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    const publisher = new LinkedInPublisher({ fetchImpl });

    const error = await publishError(publisher.publish(input({ imageUrls: [slideUrl(1)] })));

    expect(error.code).toBe("network");
    expect(error.retryable).toBe(true);
  });

  it("reports a failed slide download as retryable", async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.url.startsWith("https://images.test/")) return new Response("nope", { status: 503 });
      return undefined;
    });
    const publisher = new LinkedInPublisher({ fetchImpl });

    const error = await publishError(publisher.publish(input({ imageUrls: [slideUrl(1)] })));

    expect(error.retryable).toBe(true);
    expect(error.message).toContain("could not be downloaded");
    expect(calls).toHaveLength(1);
  });

  it("refuses to upload to a URL that is not LinkedIn's", async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.url.startsWith("https://images.test/")) return new Response(new Uint8Array(PNG));
      if (call.url === LINKEDIN_IMAGES_URL) {
        return json({
          value: { uploadUrl: "https://evil.example/upload", image: "urn:li:image:img1" },
        });
      }
      return undefined;
    });
    const publisher = new LinkedInPublisher({ fetchImpl });

    const error = await publishError(publisher.publish(input({ imageUrls: [slideUrl(1)] })));

    expect(error.message).toContain("unexpected host");
    expect(error.retryable).toBe(false);
    expect(calls.map((call) => call.url)).not.toContain("https://evil.example/upload");
  });

  it("fails when LinkedIn returns no post id at all", async () => {
    const { fetchImpl } = mockFetch(healthyRoute({ postResponse: () => json({}, 201) }));
    const publisher = new LinkedInPublisher({ fetchImpl });

    const error = await publishError(publisher.publish(input()));

    expect(error.retryable).toBe(false);
    expect(error.message).toContain("no post id");
  });

  it("never puts the access token in an error message", async () => {
    const { fetchImpl } = mockFetch(
      healthyRoute({
        postResponse: () =>
          json({ message: `Bad token Bearer ${TOKEN}`, status: 403 }, 403),
      }),
    );
    const publisher = new LinkedInPublisher({ fetchImpl });

    const error = await publishError(publisher.publish(input()));

    expect(error.message).not.toContain(TOKEN);
    expect(error.detail).not.toContain(TOKEN);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });

  it("honours an overridden API version", async () => {
    const { fetchImpl, calls } = mockFetch(healthyRoute());
    const publisher = new LinkedInPublisher({ fetchImpl, apiVersion: "202701" });

    await publisher.publish(input());

    expect((calls[0].init.headers as Record<string, string>)["Linkedin-Version"]).toBe("202701");
  });
});
