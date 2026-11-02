import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { listAccountsExpiringWithin } from "./token-expiry";

const NOW = new Date("2026-06-01T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

describe("listAccountsExpiringWithin", () => {
  it("returns accounts inside the warning window with days remaining", async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "a1",
        platform: "linkedin",
        externalId: "member-1",
        displayName: "LinkedIn",
        expiresAt: new Date(NOW.getTime() + 3 * DAY),
      },
      {
        id: "a2",
        platform: "linkedin",
        externalId: "member-2",
        displayName: "Old LinkedIn",
        expiresAt: new Date(NOW.getTime() - DAY),
      },
    ]);

    const prisma = { socialAccount: { findMany } } as unknown as PrismaClient;
    const accounts = await listAccountsExpiringWithin(10, { prisma, now: NOW });

    expect(accounts).toHaveLength(2);
    expect(accounts[0]).toMatchObject({
      id: "a1",
      daysUntilExpiry: 3,
      expired: false,
      requiresReconnect: false,
    });
    expect(accounts[1]).toMatchObject({
      id: "a2",
      daysUntilExpiry: -1,
      expired: true,
      requiresReconnect: true,
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          expiresAt: { not: null, lte: new Date(NOW.getTime() + 10 * DAY) },
        },
      }),
    );
  });
});
