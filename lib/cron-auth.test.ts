import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  cronSecretFromRequest,
  getCronSecret,
  isCronSecretValid,
} from "./cron-auth";

const ORIGINAL = process.env.CRON_SECRET;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL;
});

describe("cron secret check", () => {
  it("accepts only the configured secret", () => {
    expect(isCronSecretValid("correct-horse", "correct-horse")).toBe(true);
    expect(isCronSecretValid("wrong", "correct-horse")).toBe(false);
    expect(isCronSecretValid("correct-hors", "correct-horse")).toBe(false);
    expect(isCronSecretValid("correct-horse-and-more", "correct-horse")).toBe(false);
  });

  it("rejects a missing secret on either side", () => {
    expect(isCronSecretValid(null, "expected")).toBe(false);
    expect(isCronSecretValid("provided", null)).toBe(false);
    expect(isCronSecretValid("", "")).toBe(false);
  });

  it("reads x-cron-secret and Authorization: Bearer", () => {
    const header = new NextRequest("http://localhost/api/cron/dispatch", {
      method: "POST",
      headers: { "x-cron-secret": "from-header" },
    });
    expect(cronSecretFromRequest(header)).toBe("from-header");

    const bearer = new NextRequest("http://localhost/api/cron/dispatch", {
      method: "POST",
      headers: { authorization: "Bearer from-bearer" },
    });
    expect(cronSecretFromRequest(bearer)).toBe("from-bearer");
  });

  it("reads the configured secret from an env object", () => {
    expect(getCronSecret({ CRON_SECRET: "  secret  " })).toBe("secret");
    expect(getCronSecret({})).toBeNull();
  });
});

describe("POST /api/cron/dispatch", () => {
  it("declares a 120-second maximum duration", async () => {
    const { maxDuration } = await import("@/app/api/cron/dispatch/route");
    expect(maxDuration).toBe(120);
  });

  it("returns 401 when the secret is wrong or missing", async () => {
    process.env.CRON_SECRET = "expected-secret";
    const { POST } = await import("@/app/api/cron/dispatch/route");

    const missing = await POST(
      new NextRequest("http://localhost/api/cron/dispatch", { method: "POST" }),
    );
    expect(missing.status).toBe(401);

    const wrong = await POST(
      new NextRequest("http://localhost/api/cron/dispatch", {
        method: "POST",
        headers: { "x-cron-secret": "not-the-secret" },
      }),
    );
    expect(wrong.status).toBe(401);
  });

  it("returns 500 when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    const { POST } = await import("@/app/api/cron/dispatch/route");

    const response = await POST(
      new NextRequest("http://localhost/api/cron/dispatch", {
        method: "POST",
        headers: { "x-cron-secret": "anything" },
      }),
    );
    expect(response.status).toBe(500);
  });
});
