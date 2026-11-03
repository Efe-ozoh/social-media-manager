import { describe, expect, it } from "vitest";
import {
  buildHealthReport,
  checkBlob,
  HEALTH_CHECK_NAMES,
  REQUIRED_ENV_NAMES,
  type HealthCheck,
  type HealthCheckName,
} from "./health";

const okChecks: Record<HealthCheckName, () => Promise<HealthCheck>> = {
  database: async () => ({ ok: true, message: "database ok" }),
  resvg: async () => ({ ok: true, message: "resvg ok" }),
  sharp: async () => ({ ok: true, message: "sharp ok" }),
  fonts: async () => ({ ok: true, message: "fonts ok" }),
  blob: async () => ({ ok: true, message: "blob ok" }),
};

function allEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of REQUIRED_ENV_NAMES) env[name] = `configured-${name}`;
  return env;
}

describe("buildHealthReport", () => {
  it("returns safe check booleans and only environment names", async () => {
    const env = allEnv();
    env.DATABASE_URL = "postgres://user:password@example.test/app";
    env.AUTH_SECRET = "do-not-leak-this-secret";
    delete env.TELEGRAM_CHANNEL_ID;

    const report = await buildHealthReport({ env, checks: okChecks });

    expect(report.ok).toBe(false);
    expect(report.env).toEqual({
      ok: false,
      present: REQUIRED_ENV_NAMES.filter(
        (name) => name !== "TELEGRAM_CHANNEL_ID",
      ),
      missing: ["TELEGRAM_CHANNEL_ID"],
    });

    for (const name of HEALTH_CHECK_NAMES) {
      expect(report.checks[name]).toEqual({ ok: true, message: `${name} ok` });
    }

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("do-not-leak-this-secret");
    expect(serialized).not.toContain("postgres://");
    expect(serialized).not.toContain("configured-");
  });

  it("is healthy when every check and required name is present", async () => {
    const report = await buildHealthReport({
      env: allEnv(),
      checks: okChecks,
    });

    expect(report).toEqual({
      ok: true,
      checks: {
        database: { ok: true, message: "database ok" },
        resvg: { ok: true, message: "resvg ok" },
        sharp: { ok: true, message: "sharp ok" },
        fonts: { ok: true, message: "fonts ok" },
        blob: { ok: true, message: "blob ok" },
      },
      env: {
        ok: true,
        present: [...REQUIRED_ENV_NAMES],
        missing: [],
      },
    });
  });

  it("turns a thrown check into a safe failure message", async () => {
    const report = await buildHealthReport({
      env: allEnv(),
      checks: {
        ...okChecks,
        database: async () => {
          throw new Error("password=do-not-leak-this-secret");
        },
      },
    });

    expect(report.ok).toBe(false);
    expect(report.checks.database).toEqual({
      ok: false,
      message: "Database check failed.",
    });
    expect(JSON.stringify(report)).not.toContain("do-not-leak-this-secret");
  });
});

describe("checkBlob", () => {
  it("skips without a token and never reports the token value", async () => {
    const check = await checkBlob({});

    expect(check).toEqual({
      ok: true,
      message: "Blob check skipped: BLOB_READ_WRITE_TOKEN is not set.",
    });
    expect(JSON.stringify(check)).not.toContain("BLOB_READ_WRITE_TOKEN=");
  });
});
