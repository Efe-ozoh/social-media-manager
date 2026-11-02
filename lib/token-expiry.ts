/**
 * Token-expiry helper for the dashboard — SPEC section 7 (Meta notes) and the
 * Phase 4 token-refresh requirement.
 *
 * LinkedIn self-service apps cannot refresh tokens, so the app can only warn
 * the owner: accounts expiring within ten days (and accounts already expired)
 * are returned with the number of days left and a reconnect flag.
 */

import type { PrismaClient } from "@/lib/generated/prisma/client";
import { getPrisma } from "./prisma";
import type { PlatformName } from "./platforms";

export const EXPIRY_WARNING_DAYS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ExpiringAccountRow = {
  id: string;
  platform: PlatformName;
  externalId: string;
  displayName: string;
  expiresAt: Date | null;
};

export type ExpiringAccount = ExpiringAccountRow & {
  /** Whole days until expiry; negative once the token has expired. */
  daysUntilExpiry: number;
  expired: boolean;
  /** The owner has to reconnect before this account can publish again. */
  requiresReconnect: boolean;
};

/**
 * Lists accounts whose token expires within `days` (default 10) or has already
 * expired. Accounts without an expiry date are ignored.
 */
export async function listAccountsExpiringWithin(
  days: number = EXPIRY_WARNING_DAYS,
  options: { prisma?: PrismaClient; now?: Date } = {},
): Promise<ExpiringAccount[]> {
  const prisma = options.prisma ?? getPrisma();
  const now = options.now ?? new Date();
  const horizon = new Date(now.getTime() + Math.max(0, days) * DAY_MS);

  const rows = await prisma.socialAccount.findMany({
    where: { expiresAt: { not: null, lte: horizon } },
    orderBy: { expiresAt: "asc" },
    select: {
      id: true,
      platform: true,
      externalId: true,
      displayName: true,
      expiresAt: true,
    },
  });

  return rows
    .filter(
      (row): row is ExpiringAccountRow & { expiresAt: Date } =>
        row.expiresAt !== null,
    )
    .map((row) => {
      const msLeft = row.expiresAt.getTime() - now.getTime();
      const expired = msLeft <= 0;
      return {
        ...row,
        platform: row.platform as PlatformName,
        daysUntilExpiry: Math.floor(msLeft / DAY_MS),
        expired,
        requiresReconnect: expired,
      };
    });
}
