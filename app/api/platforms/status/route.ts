import { NextResponse } from "next/server";
import { buildPlatformStatus } from "@/lib/platform-status";
import { getPrisma } from "@/lib/prisma";
import { EXPIRY_WARNING_DAYS, listAccountsExpiringWithin } from "@/lib/token-expiry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/platforms/status
 *
 * Safe connection data for Compose and Accounts. Login is enforced by proxy.ts.
 * Tokens and external ids never leave the server; Telegram is read from the
 * environment and needs no account row.
 *
 * `expiring` comes from the token-expiry helper (the same ten-day window the
 * scheduler uses), so the Accounts page warns from one source of truth instead
 * of doing its own date arithmetic.
 */
export async function GET() {
  try {
    const prisma = getPrisma();
    const accounts = await prisma.socialAccount.findMany({
      where: { platform: "linkedin" },
      select: {
        platform: true,
        displayName: true,
        expiresAt: true,
      },
    });

    const expiring = await listAccountsExpiringWithin(EXPIRY_WARNING_DAYS, { prisma });

    return NextResponse.json(
      {
        platforms: buildPlatformStatus({ accounts }),
        expiring: expiring.map((account) => ({
          id: account.id,
          platform: account.platform,
          displayName: account.displayName,
          expiresAt: account.expiresAt ? account.expiresAt.toISOString() : null,
          daysUntilExpiry: account.daysUntilExpiry,
          expired: account.expired,
          requiresReconnect: account.requiresReconnect,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Could not load platform status." },
      { status: 503 },
    );
  }
}
