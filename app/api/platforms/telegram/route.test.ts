import { beforeEach, describe, expect, it, vi } from "vitest";

const describeTarget = vi.hoisted(() => vi.fn());

vi.mock("@/lib/publishers/telegram", () => ({
  TelegramPublisher: class {
    describeTarget(...args: unknown[]) {
      return describeTarget(...args);
    }
  },
}));

import { GET } from "./route";

/**
 * getMe and getChat only: the route may describe the bot and the channel, but
 * it must never send a message and must never put the token in a response.
 */

beforeEach(() => {
  describeTarget.mockReset();
});

describe("GET /api/platforms/telegram", () => {
  it("returns the bot and channel names when the check succeeds", async () => {
    describeTarget.mockResolvedValue({
      botName: "CodeSync Bot",
      botUsername: "codesync_bot",
      chatTitle: "CodeSync Channel",
      chatType: "channel",
    });

    const response = await GET();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      configured: true,
      botName: "CodeSync Bot",
      botUsername: "codesync_bot",
      channelTitle: "CodeSync Channel",
      channelType: "channel",
      error: null,
    });
    expect(JSON.stringify(body)).not.toMatch(/token/i);
  });

  it("reports missing configuration without failing the page", async () => {
    describeTarget.mockRejectedValue(
      new Error(
        "Telegram is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID in .env.local",
      ),
    );

    const response = await GET();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ configured: false, botName: null });
    expect(String(body.error)).toContain("not configured");
    // The variable names are fine; a token value never is.
    expect(JSON.stringify(body)).not.toMatch(/bot123|AAH/);
  });

  it("answers 502 with a generic message when Telegram cannot be reached", async () => {
    describeTarget.mockRejectedValue(
      new Error("Reading the bot account could not reach Telegram. https://api.telegram.org/botSECRET"),
    );

    const response = await GET();
    const body = (await response.json()) as { error: string; configured: boolean };

    expect(response.status).toBe(502);
    expect(body.configured).toBe(true);
    expect(body.error).toBe(
      "Could not reach Telegram to read the bot and channel names.",
    );
    expect(JSON.stringify(body)).not.toContain("SECRET");
  });
});
