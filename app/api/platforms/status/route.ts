import { NextResponse } from "next/server";
import { buildPlatformStatus } from "@/lib/platform-status";
import { getPrisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/platforms/status
 *
 * Safe connection data for the Compose page. Login is enforced by proxy.ts.
 * Tokens and external ids never leave the server; Telegram is read from the
 * environment and needs no account row.
 */
export async function GET() {
  try {
    const accounts = await getPrisma().socialAccount.findMany({
      where: { platform: "linkedin" },
      select: {
        platform: true,
        displayName: true,
        expiresAt: true,
      },
    });

    return NextResponse.json(
      { platforms: buildPlatformStatus({ accounts }) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Could not load platform status." },
      { status: 503 },
    );
  }
}
