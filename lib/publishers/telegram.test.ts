import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  escapeHtml,
  getTelegramConfig,
  TELEGRAM_MAX_CAPTION,
  TELEGRAM_MAX_MEDIA_GROUP,
  TELEGRAM_MAX_PHOTO_BYTES,
  TELEGRAM_MAX_TEXT,
  TelegramConfigError,
  TelegramPublisher,
  type TelegramPublisherOptions,
} from "./telegram";
import { PublishError, type PublishInput, type SocialAccount } from "./types";

/**
 * Everything here runs offline: fetch is mocked, and the publisher is given an
 * explicit token/chat id so the tests never read the real environment.
 */

const TOKEN = "123456789:AAHtest-token-do-not-leak-0123456789ab";
const CHAT_ID = "-1001234567890";

/** A tiny JPEG; the publisher only sniffs the first bytes. */
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "codesync-telegram-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

type Call = { url: string; init: RequestInit; body: FormData | string | null };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function ok(result: unknown): Response {
  return json({ ok: true, result });
}

function denied(status: number, description: string, parameters?: unknown): Response {
  return json({ ok: false, error_code: status, description, ...(parameters ? { parameters } : {}) }, status);
}

function image(): Response {
  return new Response(new Uint8Array(JPEG), { headers: { "content-type": "image/jpeg" } });
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
      init.body instanceof FormData
        ? init.body
        : typeof init.body === "string"
          ? init.body
          : null;

    const call: Call = { url, init, body };
    calls.push(call);

    const response = await route(call);
    if (!response) {
      // Only the method: the request URL carries the bot token.
      throw new Error(`unexpected request: ${url.split("/").pop()}`);
    }
    return response;
  }) as typeof fetch;

  return { fetchImpl, calls };
}

/** Last path segment: the Bot API method name. */
function methodOf(call: Call): string {
  return call.url.split("/").pop() ?? "";
}

function formOf(call: Call): FormData {
  if (!(call.body instanceof FormData)) throw new Error(`${methodOf(call)} was not multipart`);
  return call.body;
}

function jsonOf(call: Call): Record<string, string> {
  if (typeof call.body !== "string") throw new Error(`${methodOf(call)} was not JSON`);
  return JSON.parse(call.body) as Record<string, string>;
}

function account(overrides: Partial<SocialAccount> = {}): SocialAccount {
  return {
    id: "tg-1",
    platform: "telegram",
    externalId: CHAT_ID,
    displayName: "CodeSync Hub",
    // Telegram's token comes from the environment, not the account row.
    accessToken: "",
    refreshToken: null,
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

function publisher(
  fetchImpl: typeof fetch,
  options: Pick<TelegramPublisherOptions, "localUploadRoot"> = {},
): TelegramPublisher {
  return new TelegramPublisher({
    fetchImpl,
    config: { botToken: TOKEN, chatId: CHAT_ID },
    ...options,
  });
}

const slide = (index: number) => `https://cdn.example.com/slide-${index}.jpg`;

/** Serves any slide URL with JPEG bytes. */
function imageRoute(call: Call): Response | undefined {
  return call.url.startsWith("https://cdn.example.com/") ? image() : undefined;
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

describe("TelegramPublisher limits", () => {
  it("declares the documented limits", () => {
    const { fetchImpl } = mockFetch(() => undefined);
    const instance = publisher(fetchImpl);

    // sendMediaGroup: 2-10 items; the text message is the caption ceiling.
    expect(instance.maxImages).toBe(TELEGRAM_MAX_MEDIA_GROUP);
    expect(instance.maxCaptionLength).toBe(TELEGRAM_MAX_TEXT);
    expect(TELEGRAM_MAX_TEXT).toBe(4_096);
    expect(TELEGRAM_MAX_CAPTION).toBe(1_024);
    expect(TELEGRAM_MAX_PHOTO_BYTES).toBe(10 * 1024 * 1024);
  });

  it("rejects more images than one album holds, before any network call", async () => {
    const { fetchImpl, calls } = mockFetch(() => image());
    const urls = Array.from({ length: 11 }, (_, index) => slide(index));

    const error = await publishError(publisher(fetchImpl).publish(input({ imageUrls: urls })));

    expect(error.code).toBe("validation");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("10");
    expect(calls).toHaveLength(0);
  });

  it("rejects a caption longer than a text message", async () => {
    const { fetchImpl, calls } = mockFetch(() => ok({ message_id: 1 }));

    const error = await publishError(
      publisher(fetchImpl).publish(input({ caption: "x".repeat(TELEGRAM_MAX_TEXT + 1) })),
    );

    expect(error.code).toBe("validation");
    expect(error.message).toContain(String(TELEGRAM_MAX_TEXT));
    expect(calls).toHaveLength(0);
  });

  it("rejects a photo over Telegram's 10 MB upload limit", async () => {
    const { fetchImpl } = mockFetch((call) =>
      call.url.startsWith("https://cdn.example.com/")
        ? new Response(new Uint8Array(TELEGRAM_MAX_PHOTO_BYTES + 1))
        : ok({ message_id: 1 }),
    );

    const error = await publishError(publisher(fetchImpl).publish(input({ imageUrls: [slide(0)] })));

    expect(error.code).toBe("validation");
    expect(error.message).toContain("10 MB");
  });
});

describe("TelegramPublisher text posts", () => {
  it("sends a text-only post with HTML parse mode", async () => {
    const { fetchImpl, calls } = mockFetch(() => ok({ message_id: 42 }));

    const result = await publisher(fetchImpl).publish(input({ caption: "Hello Telegram" }));

    expect(result.externalPostId).toBe("42");
    expect(result.notes).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(methodOf(calls[0])).toBe("sendMessage");

    const body = jsonOf(calls[0]);
    expect(body.chat_id).toBe(CHAT_ID);
    expect(body.parse_mode).toBe("HTML");
    expect(body.text).toBe("Hello Telegram");
  });

  it("escapes the three HTML characters in user text", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
    expect(escapeHtml("<b>bold</b>")).toBe("&lt;b&gt;bold&lt;/b&gt;");
    // The ampersand of an entity we just created must not be escaped again.
    expect(escapeHtml("a & <b>")).toBe("a &amp; &lt;b&gt;");
    expect(escapeHtml('he said "hi"')).toBe('he said "hi"');
  });

  it("cannot be broken by markup in the caption", async () => {
    const caption = '</b><script>alert("x")</script> & <unclosed';
    const { fetchImpl, calls } = mockFetch(() => ok({ message_id: 7 }));

    await publisher(fetchImpl).publish(input({ caption }));

    const sent = jsonOf(calls[0]).text;
    expect(sent).not.toContain("<");
    expect(sent).toContain("&lt;/b&gt;");
    expect(sent).toContain("&amp;");
    // The parsed text is still exactly what the owner wrote.
    expect(sent.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")).toBe(caption);
  });
});

describe("TelegramPublisher images", () => {
  it("uploads one image as multipart with an escaped caption", async () => {
    const { fetchImpl, calls } = mockFetch((call) =>
      imageRoute(call) ?? ok({ message_id: 11 }),
    );

    const result = await publisher(fetchImpl).publish(
      input({ caption: "Slide one & <two>", imageUrls: [slide(0)] }),
    );

    expect(result.externalPostId).toBe("11");
    expect(result.notes).toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(methodOf(calls[1])).toBe("sendPhoto");

    const form = formOf(calls[1]);
    expect(form.get("chat_id")).toBe(CHAT_ID);
    expect(form.get("caption")).toBe("Slide one &amp; &lt;two&gt;");
    expect(form.get("parse_mode")).toBe("HTML");

    const photo = form.get("photo");
    expect(photo).toBeInstanceOf(Blob);
    expect(new Uint8Array(await (photo as Blob).arrayBuffer())).toEqual(JPEG);
  });

  it("reads a local-disk slide from disk without fetching it over HTTP", async () => {
    const root = await makeTempRoot();
    const key = "posts/p1/abc/slide-1.jpg";
    await mkdir(path.join(root, path.dirname(key)), { recursive: true });
    await writeFile(path.join(root, key), JPEG);

    const localUrl = `http://localhost:3000/uploads/${key}`;
    const { fetchImpl, calls } = mockFetch((call) =>
      methodOf(call) === "sendPhoto" ? ok({ message_id: 5 }) : undefined,
    );

    const result = await publisher(fetchImpl, { localUploadRoot: root }).publish(
      input({ imageUrls: [localUrl] }),
    );

    expect(result.externalPostId).toBe("5");
    // Only the Bot API call: the slide URL itself was never fetched.
    expect(calls).toHaveLength(1);
    expect(methodOf(calls[0])).toBe("sendPhoto");
    const photo = formOf(calls[0]).get("photo") as Blob;
    expect(new Uint8Array(await photo.arrayBuffer())).toEqual(JPEG);
  });

  it("sends the images and the text separately when the caption exceeds 1024", async () => {
    const caption = "y".repeat(1_500);
    const { fetchImpl, calls } = mockFetch((call) =>
      imageRoute(call) ?? ok({ message_id: 12 }),
    );

    const result = await publisher(fetchImpl).publish(input({ caption, imageUrls: [slide(0)] }));

    expect(calls.map(methodOf)).toEqual(["slide-0.jpg", "sendPhoto", "sendMessage"]);
    // The photo goes out without a caption; the text follows whole.
    expect(formOf(calls[1]).get("caption")).toBeNull();
    expect(jsonOf(calls[2]).text).toBe(caption);

    expect(result.notes?.[0]).toContain("1024");
    expect(result.notes?.[0]).toContain("separate message");
    expect(result.externalPostId).toBe("12");
  });

  it("sends two images as an album with the caption on the first item", async () => {
    const { fetchImpl, calls } = mockFetch((call) =>
      imageRoute(call) ?? ok([{ message_id: 21 }, { message_id: 22 }]),
    );

    const result = await publisher(fetchImpl).publish(
      input({ caption: "Two slides", imageUrls: [slide(0), slide(1)] }),
    );

    expect(result.externalPostId).toBe("21");
    expect(methodOf(calls[2])).toBe("sendMediaGroup");

    const form = formOf(calls[2]);
    const media = JSON.parse(form.get("media") as string) as Record<string, string>[];
    expect(media).toHaveLength(2);
    expect(media[0]).toEqual({
      type: "photo",
      media: "attach://photo0",
      caption: "Two slides",
      parse_mode: "HTML",
    });
    expect(media[1]).toEqual({ type: "photo", media: "attach://photo1" });
    expect(form.get("photo0")).toBeInstanceOf(Blob);
    expect(form.get("photo1")).toBeInstanceOf(Blob);
  });

  it("keeps an album captionless and follows with the text when it is too long", async () => {
    const caption = "z".repeat(1_200);
    const { fetchImpl, calls } = mockFetch((call) =>
      imageRoute(call) ?? ok([{ message_id: 31 }]),
    );

    const result = await publisher(fetchImpl).publish(
      input({ caption, imageUrls: [slide(0), slide(1), slide(2)] }),
    );

    expect(calls.map(methodOf)).toEqual([
      "slide-0.jpg",
      "slide-1.jpg",
      "slide-2.jpg",
      "sendMediaGroup",
      "sendMessage",
    ]);

    const media = JSON.parse(formOf(calls[3]).get("media") as string) as Record<string, string>[];
    expect(media).toHaveLength(3);
    expect(media.every((item) => item.caption === undefined)).toBe(true);
    expect(jsonOf(calls[4]).text).toBe(caption);
    expect(result.notes).toHaveLength(1);
  });
});

describe("TelegramPublisher error mapping", () => {
  it("treats an invalid token as non-retryable and says which variable to fix", async () => {
    const { fetchImpl } = mockFetch(() => denied(401, "Unauthorized"));

    const error = await publishError(publisher(fetchImpl).publish(input()));

    expect(error.code).toBe("token_invalid");
    expect(error.retryable).toBe(false);
    expect(error.requiresReconnect).toBe(true);
    expect(error.message).toContain("TELEGRAM_BOT_TOKEN");
  });

  it("treats a bot removed from the channel as non-retryable", async () => {
    const { fetchImpl } = mockFetch(() =>
      denied(403, "Forbidden: bot is not a member of the channel chat"),
    );

    const error = await publishError(publisher(fetchImpl).publish(input()));

    expect(error.code).toBe("permission_denied");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("administrator");
  });

  it("treats missing rights as non-retryable with the fix", async () => {
    const { fetchImpl } = mockFetch(() => denied(400, "Bad Request: not enough rights to send photos"));

    const error = await publishError(publisher(fetchImpl).publish(input()));

    expect(error.code).toBe("permission_denied");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("Post messages");
  });

  it("treats an unknown chat as non-retryable and names the variable", async () => {
    const { fetchImpl } = mockFetch(() => denied(400, "Bad Request: chat not found"));

    const error = await publishError(publisher(fetchImpl).publish(input()));

    expect(error.code).toBe("validation");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("TELEGRAM_CHANNEL_ID");
  });

  it("honours retry_after on 429", async () => {
    const { fetchImpl } = mockFetch(() =>
      denied(429, "Too Many Requests: retry after 17", { retry_after: 17 }),
    );

    const error = await publishError(publisher(fetchImpl).publish(input()));

    expect(error.code).toBe("rate_limited");
    expect(error.retryable).toBe(true);
    expect(error.retryAfterSeconds).toBe(17);
    expect(error.message).toContain("17");
  });

  it("retries a server error", async () => {
    const { fetchImpl } = mockFetch(() => denied(502, "Bad Gateway"));

    const error = await publishError(publisher(fetchImpl).publish(input()));

    expect(error.code).toBe("provider_error");
    expect(error.retryable).toBe(true);
  });

  it("retries a network failure without leaking the tokenised URL", async () => {
    const fetchImpl = (async () => {
      throw new Error(`connect ECONNREFUSED ${TOKEN}`);
    }) as typeof fetch;

    const error = await publishError(publisher(fetchImpl).publish(input()));

    expect(error.code).toBe("network");
    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain(TOKEN);
    expect(error.cause).toBeUndefined();
  });

  it("never puts the bot token in an error message or detail", async () => {
    const { fetchImpl } = mockFetch(() => denied(401, `Unauthorized: token ${TOKEN} is invalid`));

    const error = await publishError(publisher(fetchImpl).publish(input()));

    expect(error.message).not.toContain(TOKEN);
    expect(error.detail ?? "").not.toContain(TOKEN);
    expect(error.detail).toContain("[redacted token]");
    expect(String(error)).not.toContain(TOKEN);
  });

  it("refuses an account from another platform", async () => {
    const { fetchImpl, calls } = mockFetch(() => ok({ message_id: 1 }));

    const error = await publishError(
      publisher(fetchImpl).publish(
        input({ account: account({ platform: "linkedin", externalId: "urn:li:person:1" }) }),
      ),
    );

    expect(error.code).toBe("validation");
    expect(error.message).toContain("linkedin");
    expect(calls).toHaveLength(0);
  });
});

describe("Telegram configuration", () => {
  it("names every missing variable", () => {
    expect(() => getTelegramConfig({})).toThrow(TelegramConfigError);
    try {
      getTelegramConfig({});
    } catch (error) {
      const configError = error as TelegramConfigError;
      expect(configError.missing).toEqual(["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHANNEL_ID"]);
      expect(configError.message).toContain("TELEGRAM_BOT_TOKEN");
      expect(configError.message).toContain("TELEGRAM_CHANNEL_ID");
    }

    try {
      getTelegramConfig({ TELEGRAM_BOT_TOKEN: "1:abc" });
    } catch (error) {
      expect((error as TelegramConfigError).missing).toEqual(["TELEGRAM_CHANNEL_ID"]);
    }
  });

  it("fails a publish clearly when the env is missing", async () => {
    const { fetchImpl, calls } = mockFetch(() => ok({ message_id: 1 }));
    // No injected config, so the publisher falls back to the real environment,
    // which the test process deliberately does not set.
    const withoutConfig = new TelegramPublisher({ fetchImpl });

    const error = await publishError(withoutConfig.publish(input()));

    expect(error.code).toBe("validation");
    expect(error.retryable).toBe(false);
    expect(error.message).toContain("TELEGRAM");
    expect(calls).toHaveLength(0);
  });
});

describe("TelegramPublisher.describeTarget", () => {
  it("checks the token with getMe and the channel with getChat", async () => {
    const { fetchImpl, calls } = mockFetch((call) =>
      methodOf(call) === "getMe"
        ? ok({
            id: 1234,
            is_bot: true,
            first_name: "CodeSync",
            username: "codesync_hub_bot",
          })
        : ok({ id: CHAT_ID, type: "channel", title: "CodeSync Hub Channel" }),
    );

    const target = await publisher(fetchImpl).describeTarget();

    expect(target).toEqual({
      botUsername: "codesync_hub_bot",
      botName: "CodeSync",
      chatTitle: "CodeSync Hub Channel",
      chatType: "channel",
    });
    expect(calls.map(methodOf)).toEqual(["getMe", "getChat"]);
    expect(jsonOf(calls[1]).chat_id).toBe(CHAT_ID);
  });

  it("reports a chat the bot cannot see", async () => {
    const { fetchImpl } = mockFetch((call) =>
      methodOf(call) === "getMe"
        ? ok({ id: 1, is_bot: true, first_name: "CodeSync" })
        : denied(400, "Bad Request: chat not found"),
    );

    const error = await publishError(publisher(fetchImpl).describeTarget());

    expect(error.code).toBe("validation");
    expect(error.message).toContain("TELEGRAM_CHANNEL_ID");
  });
});
