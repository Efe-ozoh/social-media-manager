import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AI_RATE_LIMIT,
  checkAiBudget,
  dailyCap,
  type AiBudgetOptions,
} from "./ai-budget";

const NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

type BudgetPrisma = NonNullable<AiBudgetOptions["prisma"]>;

function fakeBudgetDb() {
  let day = "";
  let count = 0;
  let queries = 0;

  const prisma = {
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      queries += 1;
      const [valueDay, valueCap] = values as [string, number];
      if (valueDay !== day) {
        day = valueDay;
        count = 0;
      }
      if (count >= valueCap) return [];
      count += 1;
      return [{ count }];
    },
  } as unknown as BudgetPrisma;

  return {
    prisma,
    count: () => count,
    queries: () => queries,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dailyCap", () => {
  it("defaults and clamps the environment value", () => {
    expect(dailyCap({})).toBe(25);
    expect(dailyCap({ GEN_DAILY_CAP: "nope" })).toBe(25);
    expect(dailyCap({ GEN_DAILY_CAP: "0" })).toBe(1);
    expect(dailyCap({ GEN_DAILY_CAP: "9999" })).toBe(500);
    expect(dailyCap({ GEN_DAILY_CAP: "7" })).toBe(7);
  });
});

describe("checkAiBudget", () => {
  it("enforces the daily cap across IPs in the database", async () => {
    const db = fakeBudgetDb();
    const options = { env: { GEN_DAILY_CAP: "2" }, now: NOW, prisma: db.prisma };

    await expect(checkAiBudget("daily-a", options)).resolves.toEqual({ ok: true });
    await expect(checkAiBudget("daily-b", options)).resolves.toEqual({ ok: true });

    const blocked = await checkAiBudget("daily-c", options);
    expect(blocked).toMatchObject({ ok: false, reason: "daily" });
    if (!blocked.ok) {
      expect(blocked.retryAfterSeconds).toBe(43_200);
    }
    expect(db.count()).toBe(2);
  });

  it("starts a fresh row on a new UTC day", async () => {
    const db = fakeBudgetDb();
    const options = { env: { GEN_DAILY_CAP: "1" }, now: NOW, prisma: db.prisma };

    await expect(checkAiBudget("midnight-a", options)).resolves.toEqual({
      ok: true,
    });
    await expect(checkAiBudget("midnight-b", options)).resolves.toMatchObject({
      ok: false,
      reason: "daily",
    });

    await expect(
      checkAiBudget("midnight-c", {
        ...options,
        now: NOW + 12 * 60 * 60 * 1000,
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("limits repeated requests from one IP without spending the daily cap", async () => {
    const db = fakeBudgetDb();
    const options = { env: { GEN_DAILY_CAP: "500" }, now: NOW, prisma: db.prisma };

    for (let index = 0; index < AI_RATE_LIMIT; index += 1) {
      await expect(checkAiBudget("same-ip", options)).resolves.toEqual({
        ok: true,
      });
    }

    await expect(checkAiBudget("same-ip", options)).resolves.toMatchObject({
      ok: false,
      reason: "ip",
    });
    expect(db.queries()).toBe(AI_RATE_LIMIT);

    await expect(checkAiBudget("other-ip", options)).resolves.toEqual({
      ok: true,
    });
    expect(db.queries()).toBe(AI_RATE_LIMIT + 1);
  });

  it("fails closed when the database is unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const prisma = {
      $queryRaw: async () => {
        throw new Error("database offline");
      },
    } as unknown as BudgetPrisma;

    await expect(
      checkAiBudget("db-down", { env: { GEN_DAILY_CAP: "25" }, now: NOW, prisma }),
    ).resolves.toEqual({
      ok: false,
      reason: "unavailable",
      retryAfterSeconds: 60,
    });
  });
});
