/**
 * Cost controls for the AI routes.
 *
 * The per-IP limiter reuses the small in-memory limiter already used by the
 * preview route. The daily cap is a single database row keyed by UTC date and
 * incremented atomically, so it is shared by every serverless instance. The
 * provider dashboard spending limit remains the hard backstop.
 */

import type { PrismaClient } from "@/lib/generated/prisma/client";
import { getPrisma } from "./prisma";
import { rateLimit } from "./rate-limit";

export const AI_RATE_LIMIT = 8;
export const AI_RATE_WINDOW_MS = 10 * 60 * 1000;
export const DEFAULT_GEN_DAILY_CAP = 25;

type BudgetPrisma = Pick<PrismaClient, "$queryRaw">;

export type AiBudgetResult =
  | { ok: true }
  | {
      ok: false;
      reason: "ip" | "daily" | "unavailable";
      retryAfterSeconds: number;
    };

export type AiBudgetOptions = {
  env?: Record<string, string | undefined>;
  now?: number;
  /** Test seam; production uses the shared Prisma client. */
  prisma?: BudgetPrisma;
};

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function secondsUntilUtcMidnight(now: number): number {
  const date = new Date(now);
  const next = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
  );
  return Math.max(1, Math.ceil((next - now) / 1000));
}

/** Reads GEN_DAILY_CAP, clamped so a typo cannot disable the cap. */
export function dailyCap(env: Record<string, string | undefined> = process.env): number {
  const raw = env.GEN_DAILY_CAP?.trim();
  if (!raw) return DEFAULT_GEN_DAILY_CAP;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return DEFAULT_GEN_DAILY_CAP;
  return Math.min(500, Math.max(1, parsed));
}

/**
 * Atomically creates today's row or increments it only while below the cap.
 * A conflict where the cap is already reached returns no row.
 */
async function consumeDailyAllowance(
  prisma: BudgetPrisma,
  day: string,
  cap: number,
): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ count: number }>>`
    INSERT INTO "ai_daily_budgets" ("day", "count")
    VALUES (${day}, 1)
    ON CONFLICT ("day") DO UPDATE
      SET "count" = "ai_daily_budgets"."count" + 1
      WHERE "ai_daily_budgets"."count" < ${cap}
    RETURNING "count"
  `;
  return rows.length > 0;
}

/**
 * Checks the per-IP window first, then consumes one unit of the shared daily
 * budget. A failed per-IP check does not consume the daily allowance.
 */
export async function checkAiBudget(
  ip: string,
  options: AiBudgetOptions = {},
): Promise<AiBudgetResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const perIp = rateLimit(`ai-ip:${ip}`, AI_RATE_LIMIT, AI_RATE_WINDOW_MS);
  if (!perIp.ok) {
    return {
      ok: false,
      reason: "ip",
      retryAfterSeconds: perIp.retryAfterSeconds,
    };
  }

  const day = utcDay(now);
  const cap = dailyCap(env);

  try {
    const prisma = options.prisma ?? getPrisma();
    const allowed = await consumeDailyAllowance(prisma, day, cap);
    if (!allowed) {
      return {
        ok: false,
        reason: "daily",
        retryAfterSeconds: secondsUntilUtcMidnight(now),
      };
    }
  } catch {
    console.error("AI daily budget check failed.");
    return { ok: false, reason: "unavailable", retryAfterSeconds: 60 };
  }

  return { ok: true };
}
