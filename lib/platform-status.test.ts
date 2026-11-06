import { describe, expect, it } from "vitest";
import { buildPlatformStatus } from "./platform-status";

const NOW = new Date("2026-06-01T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const LINKEDIN_ENV = {
  LINKEDIN_CLIENT_ID: "client-id",
  LINKEDIN_CLIENT_SECRET: "client-secret",
  APP_URL: "https://example.com",
  TELEGRAM_BOT_TOKEN: "bot-token",
  TELEGRAM_CHANNEL_ID: "-100123",
};

describe("buildPlatformStatus", () => {
  it("returns connected automated platforms without secrets or external ids", () => {
    const statuses = buildPlatformStatus({
      env: LINKEDIN_ENV,
      now: NOW,
      accounts: [
        {
          platform: "linkedin",
          displayName: "Ada Lovelace",
          expiresAt: new Date(NOW.getTime() + 30 * DAY),
        },
      ],
    });

    expect(statuses.map((status) => status.platform)).toEqual([
      "linkedin",
      "telegram",
    ]);
    expect(statuses[0]).toMatchObject({
      label: "LinkedIn",
      configured: true,
      connected: true,
      canPublish: true,
      displayName: "Ada Lovelace",
      expired: false,
      disabledReason: null,
    });
    expect(statuses[1]).toMatchObject({
      label: "Telegram",
      configured: true,
      connected: true,
      canPublish: true,
      displayName: null,
      disabledReason: null,
    });

    const serialized = JSON.stringify(statuses);
    expect(serialized).not.toContain("client-secret");
    expect(serialized).not.toContain("bot-token");
    expect(serialized).not.toContain("-100123");
    expect(statuses[0]).not.toHaveProperty("externalId");
    expect(statuses[0]).not.toHaveProperty("accessToken");
  });

  it("explains missing configuration without exposing values", () => {
    const statuses = buildPlatformStatus({
      env: {},
      now: NOW,
      accounts: [],
    });

    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toMatchObject({
      configured: false,
      connected: false,
      canPublish: false,
    });
    expect(statuses[0].disabledReason).toContain("LINKEDIN_CLIENT_ID");
    expect(statuses[0].disabledReason).toContain("APP_URL");
    expect(statuses[1].disabledReason).toContain("TELEGRAM_BOT_TOKEN");
    expect(statuses[1].disabledReason).toContain("TELEGRAM_CHANNEL_ID");
  });

  it("disables an expired LinkedIn token and keeps the expiry for display", () => {
    const [linkedin] = buildPlatformStatus({
      env: LINKEDIN_ENV,
      now: NOW,
      accounts: [
        {
          platform: "linkedin",
          displayName: "Ada Lovelace",
          expiresAt: new Date(NOW.getTime() - DAY),
        },
      ],
    });

    expect(linkedin.expired).toBe(true);
    expect(linkedin.canPublish).toBe(false);
    expect(linkedin.expiresAt).toBe("2026-05-31T12:00:00.000Z");
    expect(linkedin.daysUntilExpiry).toBe(-1);
    expect(linkedin.disabledReason).toContain("Reconnect");
  });

  it("warns when a LinkedIn token expires inside ten days", () => {
    const [linkedin] = buildPlatformStatus({
      env: LINKEDIN_ENV,
      now: NOW,
      accounts: [
        {
          platform: "linkedin",
          displayName: "Ada Lovelace",
          expiresAt: new Date(NOW.getTime() + 3 * DAY),
        },
      ],
    });

    expect(linkedin.expiresSoon).toBe(true);
    expect(linkedin.canPublish).toBe(true);
    expect(linkedin.daysUntilExpiry).toBe(3);
  });

  it("requires a connected LinkedIn account when configuration exists", () => {
    const [linkedin] = buildPlatformStatus({
      env: LINKEDIN_ENV,
      now: NOW,
      accounts: [],
    });

    expect(linkedin.configured).toBe(true);
    expect(linkedin.connected).toBe(false);
    expect(linkedin.canPublish).toBe(false);
    expect(linkedin.disabledReason).toContain("Connect LinkedIn");
  });
});
