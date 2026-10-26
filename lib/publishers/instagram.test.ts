import { describe, expect, it } from "vitest";
import {
  InstagramPublisher,
  INSTAGRAM_MAX_CAPTION,
  INSTAGRAM_MAX_CAROUSEL_ITEMS,
} from "./instagram";
import { PublishError, type PublishInput, type SocialAccount } from "./types";

const TOKEN = "EAAsecret-user-token-do-not-leak-0123456789";
const IG_ID = "17841400000000000";

type Call = { url: string; init: RequestInit; body: string | null };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function form(call: Call): URLSearchParams {
  return new URLSearchParams(call.body ?? "");
}

function pathOf(call: Call): string {
  return new URL(call.url).pathname;
}

function account(overrides: Partial<SocialAccount> = {}): SocialAccount {
  return {
    id: "acc-2",
    platform: "instagram",
    externalId: IG_ID,
    displayName: "@codesync",
    accessToken: TOKEN,
    refreshToken: null,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    ...overrides,
  };
}

function input(overrides: Partial<PublishInput> = {}): PublishInput {
  return {
    caption: "A short post about rendering slides.",
    imageUrls: ["https://cdn.example.com/slide-1.jpg"],
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

function fakeClock(start = 1_000_000) {
  let time = start;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
}

const mediaPath = `/v26.0/${IG_ID}/media`;
const publishPath = `/v26.0/${IG_ID}/media_publish`;
const slideUrl = (index: number) => `https://cdn.example.com/slide-${index}.jpg`;

/** A Meta that creates containers, reports FINISHED and publishes. */
function healthyRoute(options: { statuses?: string[]; publishedId?: string } = {}): Route {
  const statuses = [...(options.statuses ?? ["FINISHED"])];
  let containers = 0;

  return (call) => {
    const path = pathOf(call);

    if (path === mediaPath && call.init.method === "POST") {
      containers += 1;
      return json({ id: `container-${containers}` });
    }
    if (path.startsWith(`/v26.0/container-`)) {
      const status = statuses.length > 1 ? statuses.shift() : statuses[0];
      return json({ status_code: status });
    }
    if (path === publishPath) {
      return json({ id: options.publishedId ?? "17890000000000001" });
    }
    return undefined;
  };
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

const fastOptions = () => ({ pollIntervalMs: 1, pollTimeoutMs: 1_000 });

describe("InstagramPublisher", () => {
  it("declares the documented limits", () => {
    const publisher = new InstagramPublisher();
    expect(publisher.platform).toBe("instagram");
    expect(publisher.maxCaptionLength).toBe(INSTAGRAM_MAX_CAPTION);
    expect(publisher.maxImages).toBe(INSTAGRAM_MAX_CAROUSEL_ITEMS);
    expect(INSTAGRAM_MAX_CAPTION).toBe(2_200);
    expect(INSTAGRAM_MAX_CAROUSEL_ITEMS).toBe(10);
  });

  it("creates a container, waits for FINISHED, then publishes", async () => {
    const clock = fakeClock();
    const { fetchImpl, calls } = mockFetch(healthyRoute());
    const publisher = new InstagramPublisher({ fetchImpl, ...fastOptions(), ...clock });

    const result = await publisher.publish(input());

    expect(result.externalPostId).toBe("17890000000000001");
    expect(result.notes).toBeUndefined();

    expect(calls.map((call) => `${call.init.method} ${pathOf(call)}`)).toEqual([
      `POST ${mediaPath}`,
      "GET /v26.0/container-1",
      `POST ${publishPath}`,
    ]);

    const create = form(calls[0]);
    expect(create.get("image_url")).toBe("https://cdn.example.com/slide-1.jpg");
    expect(create.get("caption")).toBe("A short post about rendering slides.");
    expect(create.get("access_token")).toBe(TOKEN);
    expect(create.get("is_carousel_item")).toBeNull();

    const status = new URL(calls[1].url);
    expect(status.searchParams.get("fields")).toBe("status_code");

    const publish = form(calls[2]);
    expect(publish.get("creation_id")).toBe("container-1");
  });

  it("builds a carousel from child containers in slide order", async () => {
    const clock = fakeClock();
    let containers = 0;
    const { fetchImpl, calls } = mockFetch((call) => {
      const path = pathOf(call);
      if (path === mediaPath) {
        containers += 1;
        return json({ id: `container-${containers}` });
      }
      if (path.startsWith("/v26.0/container-")) return json({ status_code: "FINISHED" });
      if (path === publishPath) return json({ id: "17890000000000009" });
      return undefined;
    });
    const publisher = new InstagramPublisher({ fetchImpl, ...fastOptions(), ...clock });

    const result = await publisher.publish(
      input({ imageUrls: [slideUrl(1), slideUrl(2), slideUrl(3)] }),
    );

    expect(result.externalPostId).toBe("17890000000000009");

    const creates = calls.filter((call) => pathOf(call) === mediaPath);
    expect(creates).toHaveLength(4);

    for (const [index, call] of creates.slice(0, 3).entries()) {
      const params = form(call);
      expect(params.get("image_url")).toBe(slideUrl(index + 1));
      expect(params.get("is_carousel_item")).toBe("true");
      // The caption belongs on the parent, not on the children.
      expect(params.get("caption")).toBeNull();
    }

    const parent = form(creates[3]);
    expect(parent.get("media_type")).toBe("CAROUSEL");
    expect(parent.get("children")).toBe("container-1,container-2,container-3");
    expect(parent.get("caption")).toBe("A short post about rendering slides.");

    // The parent container is the one that is polled and published.
    const publish = calls.at(-1) as Call;
    expect(form(publish).get("creation_id")).toBe("container-4");
  });

  it("keeps polling while the container is IN_PROGRESS", async () => {
    const clock = fakeClock();
    const { fetchImpl, calls } = mockFetch(
      healthyRoute({ statuses: ["IN_PROGRESS", "IN_PROGRESS", "FINISHED"] }),
    );
    const publisher = new InstagramPublisher({ fetchImpl, ...fastOptions(), ...clock });

    await publisher.publish(input());

    const statuses = calls.filter((call) => pathOf(call).startsWith("/v26.0/container-"));
    expect(statuses).toHaveLength(3);
    expect(pathOf(calls.at(-1) as Call)).toBe(publishPath);
  });

  it("stops with a non-retryable error when the container fails", async () => {
    const clock = fakeClock();
    const { fetchImpl, calls } = mockFetch(healthyRoute({ statuses: ["ERROR"] }));
    const publisher = new InstagramPublisher({ fetchImpl, ...fastOptions(), ...clock });

    const error = await publishError(publisher.publish(input()));

    expect(error.code).toBe("validation");
    expect(error.retryable).toBe(false);
    expect(calls.some((call) => pathOf(call) === publishPath)).toBe(false);
  });

  it("gives up after the poll timeout with a retryable error", async () => {
    const clock = fakeClock();
    const { fetchImpl, calls } = mockFetch(healthyRoute({ statuses: ["IN_PROGRESS"] }));
    const publisher = new InstagramPublisher({
      fetchImpl,
      pollIntervalMs: 1,
      pollTimeoutMs: 5,
      ...clock,
    });

    const error = await publishError(publisher.publish(input()));

    expect(error.code).toBe("provider_error");
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("still processing");
    expect(calls.some((call) => pathOf(call) === publishPath)).toBe(false);
  });

  it("rejects localhost and plain-http image URLs before any network call", async () => {
    const { fetchImpl, calls } = mockFetch(healthyRoute());
    const publisher = new InstagramPublisher({ fetchImpl, ...fastOptions() });

    const localhost = await publishError(
      publisher.publish(input({ imageUrls: ["http://localhost:3000/uploads/slide-1.png"] })),
    );
    expect(localhost.code).toBe("validation");
    expect(localhost.message).toContain("cannot reach");
    expect(localhost.message).toContain("BLOB_READ_WRITE_TOKEN");

    const insecure = await publishError(
      publisher.publish(input({ imageUrls: ["http://example.com/slide-1.jpg"] })),
    );
    expect(insecure.code).toBe("validation");
    expect(insecure.message).toContain("HTTPS");

    expect(calls).toHaveLength(0);
  });

  it("rejects a text-only post and too many slides", async () => {
    const { fetchImpl, calls } = mockFetch(healthyRoute());
    const publisher = new InstagramPublisher({ fetchImpl, ...fastOptions() });

    const textOnly = await publishError(publisher.publish(input({ imageUrls: [] })));
    expect(textOnly.code).toBe("validation");
    expect(textOnly.message).toContain("no text-only posts");

    const tooMany = await publishError(
      publisher.publish(
        input({
          imageUrls: Array.from(
            { length: INSTAGRAM_MAX_CAROUSEL_ITEMS + 1 },
            (_, index) => slideUrl(index),
          ),
        }),
      ),
    );
    expect(tooMany.code).toBe("validation");

    await expect(publisher.publish(input({ caption: "x".repeat(2_201) }))).rejects.toMatchObject({
      code: "validation",
    });

    expect(calls).toHaveLength(0);
  });

  it("maps the JPEG-only subcode to a clear validation error", async () => {
    const clock = fakeClock();
    const { fetchImpl } = mockFetch(() =>
      json(
        {
          error: {
            message: "Media upload has failed with error code 36001",
            code: 36001,
            error_subcode: 2207005,
          },
        },
        400,
      ),
    );
    const publisher = new InstagramPublisher({ fetchImpl, ...fastOptions(), ...clock });

    const error = await publishError(publisher.publish(input()));

    expect(error.code).toBe("validation");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("JPEG");
  });

  it("retries an expired container, and does not retry a restricted account", async () => {
    const clock = fakeClock();
    const expired = mockFetch(() =>
      json({ error: { message: "expired", code: 400, error_subcode: 2207020 } }, 400),
    );
    const expiredError = await publishError(
      new InstagramPublisher({ fetchImpl: expired.fetchImpl, ...fastOptions(), ...clock }).publish(
        input(),
      ),
    );
    expect(expiredError.code).toBe("provider_error");
    expect(expiredError.retryable).toBe(true);

    const restricted = mockFetch(() =>
      json({ error: { message: "restricted", code: 25, error_subcode: 2207050 } }, 400),
    );
    const restrictedError = await publishError(
      new InstagramPublisher({ fetchImpl: restricted.fetchImpl, ...fastOptions(), ...clock }).publish(
        input(),
      ),
    );
    expect(restrictedError.code).toBe("permission_denied");
    expect(restrictedError.retryable).toBe(false);
    expect(restrictedError.requiresReconnect).toBe(true);
  });

  it("notes the JPEG requirement when the slides are PNG", async () => {
    const clock = fakeClock();
    const png = mockFetch(healthyRoute());
    const pngResult = await new InstagramPublisher({
      fetchImpl: png.fetchImpl,
      ...fastOptions(),
      ...clock,
    }).publish(input({ imageUrls: ["https://cdn.example.com/slide-1.png"] }));
    expect(pngResult.notes?.[0]).toContain("JPEG");

    const jpeg = mockFetch(healthyRoute());
    const jpegResult = await new InstagramPublisher({
      fetchImpl: jpeg.fetchImpl,
      ...fastOptions(),
      ...fakeClock(),
    }).publish(input({ imageUrls: ["https://cdn.example.com/slide-1.jpg"] }));
    expect(jpegResult.notes).toBeUndefined();
  });

  it("fails when Meta returns no container or media id", async () => {
    const clock = fakeClock();
    const noContainer = mockFetch(() => json({}));
    const containerError = await publishError(
      new InstagramPublisher({ fetchImpl: noContainer.fetchImpl, ...fastOptions(), ...clock }).publish(
        input(),
      ),
    );
    expect(containerError.retryable).toBe(false);
    expect(containerError.message).toContain("no container id");

    const noMedia = mockFetch((call) => {
      if (pathOf(call) === mediaPath) return json({ id: "container-1" });
      if (pathOf(call).startsWith("/v26.0/container-")) return json({ status_code: "FINISHED" });
      return json({});
    });
    const mediaError = await publishError(
      new InstagramPublisher({ fetchImpl: noMedia.fetchImpl, ...fastOptions(), ...fakeClock() }).publish(
        input(),
      ),
    );
    expect(mediaError.retryable).toBe(false);
    expect(mediaError.message).toContain("no media id");
  });

  it("never puts the access token in an error", async () => {
    const clock = fakeClock();
    const { fetchImpl } = mockFetch(() =>
      json({ error: { message: `Invalid OAuth access token EAA${"y".repeat(30)}`, code: 190 } }, 401),
    );
    const publisher = new InstagramPublisher({ fetchImpl, ...fastOptions(), ...clock });

    const error = await publishError(publisher.publish(input()));

    expect(error.code).toBe("token_expired");
    expect(error.message).not.toContain(TOKEN);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
  });

  it("refuses an expired token before any network call", async () => {
    const { fetchImpl, calls } = mockFetch(healthyRoute());
    const publisher = new InstagramPublisher({ fetchImpl, ...fastOptions() });

    const error = await publishError(
      publisher.publish(input({ account: account({ expiresAt: new Date(Date.now() - 1_000) }) })),
    );

    expect(error.code).toBe("token_expired");
    expect(error.requiresReconnect).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
