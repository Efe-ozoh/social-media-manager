import { NextResponse } from "next/server";
import { TelegramPublisher } from "@/lib/publishers/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/platforms/telegram
 *
 * The Accounts page wants the bot and channel names. Telegram has no OAuth, so
 * the only safe read-only check is the Bot API's own: getMe for the bot and
 * getChat for the channel. Nothing is sent to the channel, and the bot token
 * never leaves the server — the publisher deliberately keeps it out of every
 * message it throws.
 *
 * Login is enforced by proxy.ts. A failure to reach Telegram is reported as a
 * 502 with a generic message, because a provider error could quote the request.
 */
export async function GET() {
  const publisher = new TelegramPublisher();

  try {
    const info = await publisher.describeTarget();

    return NextResponse.json(
      {
        configured: true,
        botName: info.botName || null,
        botUsername: info.botUsername || null,
        channelTitle: info.chatTitle || null,
        channelType: info.chatType || null,
        error: null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const configured = !/not configured/i.test(message);

    return NextResponse.json(
      {
        configured,
        botName: null,
        botUsername: null,
        channelTitle: null,
        channelType: null,
        error: configured
          ? "Could not reach Telegram to read the bot and channel names."
          : "Telegram is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID.",
      },
      {
        status: configured ? 502 : 200,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
