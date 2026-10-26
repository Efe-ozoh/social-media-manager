import { describe, expect, it } from "vitest";
import { encryptToken } from "@/lib/crypto";
import {
  isFetchableImageUrl,
  isRetryable,
  PublishError,
  redactSecrets,
  toPublishError,
  toSocialAccount,
  validatePublishInput,
  type Publisher,
  type PublishInput,
} from "./types";

const KEY = Buffer.alloc(32, 5);
const ACCESS_TOKEN = "AQV-access-token-value-1234567890";
const REFRESH_TOKEN = "AQV-refresh-token-value-0987654321";

const limits: Pick<Publisher, "platform" | "maxImages" | "maxCaptionLength"> = {
  platform: "linkedin",
  maxImages: 20,
  maxCaptionLength: 3_000,
};

function input(overrides: Partial<PublishInput> = {}): PublishInput {
  return {
    caption: "A perfectly normal caption.",
    imageUrls: [],
    account: {
      id: "acc-1",
      platform: "linkedin",
      externalId: "urn:li:person:abc",
      displayName: "Ada",
      accessToken: ACCESS_TOKEN,
      refreshToken: null,
      expiresAt: null,
    },
    ...overrides,
  };
}

describe("PublishError.fromStatus", () => {
  it("marks auth and permission failures as terminal reconnects", () => {
    for (const status of [401, 403]) {
      const error = PublishError.fromStatus(status, "nope", { platform: "linkedin" });
      expect(error.retryable).toBe(false);
      expect(error.requiresReconnect).toBe(true);
      expect(error.status).toBe(status);
      expect(error.platform).toBe("linkedin");
      expect(error.code).toBe(status === 401 ? "token_expired" : "permission_denied");
    }
  });

  it("treats validation statuses as non-retryable", () => {
    for (const status of [400, 404, 422]) {
      const error = PublishError.fromStatus(status, "bad request");
      expect(error.code).toBe("validation");
      expect(error.retryable).toBe(false);
      expect(error.requiresReconnect).toBe(false);
    }
  });

  it("treats rate limits, timeouts and 5xx as retryable", () => {
    const rateLimited = PublishError.fromStatus(429, "slow down", { retryAfterSeconds: 30 });
    expect(rateLimited.code).toBe("rate_limited");
    expect(rateLimited.retryable).toBe(true);
    expect(rateLimited.retryAfterSeconds).toBe(30);

    for (const status of [408, 500, 502, 503]) {
      const error = PublishError.fromStatus(status, "try later");
      expect(error.code).toBe("provider_error");
      expect(error.retryable).toBe(true);
      expect(error.requiresReconnect).toBe(false);
    }
  });
});

describe("PublishError helpers", () => {
  it("builds the named failures with the right codes", () => {
    expect(PublishError.tokenExpired("linkedin").code).toBe("token_expired");
    expect(PublishError.permissionDenied("linkedin").code).toBe("permission_denied");
    expect(PublishError.validation("linkedin", "bad").code).toBe("validation");
    expect(PublishError.network("linkedin").code).toBe("network");

    const network = PublishError.network("linkedin", "offline", new Error("ECONNRESET"));
    expect(network.retryable).toBe(true);
    expect((network.cause as Error).message).toBe("ECONNRESET");
  });
});

describe("isRetryable / toPublishError", () => {
  it("passes PublishError through and treats unknown errors as retryable", () => {
    const terminal = PublishError.validation("linkedin", "bad");
    expect(isRetryable(terminal)).toBe(false);
    expect(isRetryable(new Error("socket hang up"))).toBe(true);
    expect(isRetryable("a string")).toBe(true);

    expect(toPublishError(terminal)).toBe(terminal);

    const wrapped = toPublishError(new Error("kaboom"), "linkedin");
    expect(wrapped).toBeInstanceOf(PublishError);
    expect(wrapped.code).toBe("provider_error");
    expect(wrapped.retryable).toBe(true);
    expect(wrapped.platform).toBe("linkedin");
    expect(wrapped.message).toBe("kaboom");
  });
});

describe("validatePublishInput", () => {
  it("accepts input inside the limits", () => {
    expect(() => validatePublishInput(limits, input())).not.toThrow();
    expect(() =>
      validatePublishInput(limits, input({ imageUrls: ["https://blobs.example/slide-1.png"] })),
    ).not.toThrow();
  });

  it("rejects an empty caption", () => {
    expect(() => validatePublishInput(limits, input({ caption: "   " }))).toThrow(
      /caption is empty/i,
    );
  });

  it("rejects an over-long caption and says the limit", () => {
    try {
      validatePublishInput(limits, input({ caption: "x".repeat(3_001) }));
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PublishError);
      expect((error as PublishError).code).toBe("validation");
      expect((error as Error).message).toContain("3000");
    }
  });

  it("rejects too many images", () => {
    const urls = Array.from({ length: 21 }, (_, index) => `https://blobs.example/${index}.png`);
    expect(() => validatePublishInput(limits, input({ imageUrls: urls }))).toThrow(/allows 20/);
  });

  it("rejects image URLs a platform could not fetch", () => {
    expect(() =>
      validatePublishInput(limits, input({ imageUrls: ["http://example.com/slide.png"] })),
    ).toThrow(/public https/);
  });
});

describe("isFetchableImageUrl", () => {
  it("accepts https and localhost http", () => {
    expect(isFetchableImageUrl("https://blob.vercel-storage.com/a.png")).toBe(true);
    expect(isFetchableImageUrl("http://localhost:3000/uploads/a.png")).toBe(true);
    expect(isFetchableImageUrl("http://127.0.0.1:3000/uploads/a.png")).toBe(true);
  });

  it("rejects plain http, other schemes and garbage", () => {
    expect(isFetchableImageUrl("http://example.com/a.png")).toBe(false);
    expect(isFetchableImageUrl("ftp://example.com/a.png")).toBe(false);
    expect(isFetchableImageUrl("javascript:alert(1)")).toBe(false);
    expect(isFetchableImageUrl("not a url")).toBe(false);
  });
});

describe("toSocialAccount", () => {
  it("decrypts the stored tokens", () => {
    const account = toSocialAccount(
      {
        id: "acc-1",
        platform: "linkedin",
        externalId: "urn:li:person:abc",
        displayName: "Ada",
        accessTokenEnc: encryptToken(ACCESS_TOKEN, KEY),
        refreshTokenEnc: encryptToken(REFRESH_TOKEN, KEY),
        expiresAt: new Date("2027-01-01T00:00:00Z"),
      },
      KEY,
    );

    expect(account.accessToken).toBe(ACCESS_TOKEN);
    expect(account.refreshToken).toBe(REFRESH_TOKEN);
    expect(account.expiresAt).toEqual(new Date("2027-01-01T00:00:00Z"));
  });

  it("keeps a missing refresh token as null", () => {
    const account = toSocialAccount(
      {
        id: "acc-1",
        platform: "linkedin",
        externalId: "urn:li:person:abc",
        displayName: "Ada",
        accessTokenEnc: encryptToken(ACCESS_TOKEN, KEY),
        refreshTokenEnc: null,
        expiresAt: null,
      },
      KEY,
    );

    expect(account.refreshToken).toBeNull();
  });

  it("fails loudly with the wrong key rather than returning garbage", () => {
    expect(() =>
      toSocialAccount(
        {
          id: "acc-1",
          platform: "linkedin",
          externalId: "urn:li:person:abc",
          displayName: "Ada",
          accessTokenEnc: encryptToken(ACCESS_TOKEN, KEY),
          refreshTokenEnc: null,
          expiresAt: null,
        },
        Buffer.alloc(32, 9),
      ),
    ).toThrow(/could not be decrypted/);
  });
});

describe("redactSecrets", () => {
  it("removes bearer headers and LinkedIn-style tokens", () => {
    expect(redactSecrets(`Bearer ${ACCESS_TOKEN} rejected`)).toBe("Bearer [redacted] rejected");
    expect(redactSecrets(`token ${ACCESS_TOKEN} expired`)).toBe("token [redacted token] expired");
    expect(redactSecrets("no secrets here")).toBe("no secrets here");
  });

  it("removes Meta-style tokens", () => {
    expect(redactSecrets("Invalid token EAAAbCdEf0123456789abcdefXYZ")).toBe(
      "Invalid token [redacted token]",
    );
  });

  it("truncates long provider messages", () => {
    expect(redactSecrets("y".repeat(1_000))).toHaveLength(300);
  });
});
