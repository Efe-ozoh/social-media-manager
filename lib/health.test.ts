import { describe, expect, it, vi } from "vitest";
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

  it("adds BLOB_READ_WRITE_TOKEN to production env lists safely", async () => {
    const token = "vercel_blob_rw_production-secret";
    const report = await buildHealthReport({
      env: {
        ...allEnv(),
        NODE_ENV: "production",
        BLOB_READ_WRITE_TOKEN: token,
      },
      checks: okChecks,
    });

    expect(report.ok).toBe(true);
    expect(report.env.present).toContain("BLOB_READ_WRITE_TOKEN");
    expect(report.env.missing).toEqual([]);
    expect(JSON.stringify(report)).not.toContain(token);
  });

  it("fails production health when BLOB_READ_WRITE_TOKEN is missing", async () => {
    const report = await buildHealthReport({
      env: { ...allEnv(), NODE_ENV: "production" },
      checks: {
        database: okChecks.database,
        resvg: okChecks.resvg,
        sharp: okChecks.sharp,
        fonts: okChecks.fonts,
      },
    });

    expect(report.ok).toBe(false);
    expect(report.env.present).not.toContain("BLOB_READ_WRITE_TOKEN");
    expect(report.env.missing).toContain("BLOB_READ_WRITE_TOKEN");
    expect(report.checks.blob).toEqual({
      ok: false,
      message: "BLOB_READ_WRITE_TOKEN is not set",
    });
  });
});

describe("checkBlob", () => {
  it("reports a missing token distinctly and fails only in production", async () => {
    expect(await checkBlob({})).toEqual({
      ok: true,
      message: "BLOB_READ_WRITE_TOKEN is not set",
    });
    expect(await checkBlob({ NODE_ENV: "development" })).toEqual({
      ok: true,
      message: "BLOB_READ_WRITE_TOKEN is not set",
    });
    expect(await checkBlob({ NODE_ENV: "production" })).toEqual({
      ok: false,
      message: "BLOB_READ_WRITE_TOKEN is not set",
    });
  });

  it("logs a redacted summary without tokens or URLs", async () => {
    class BlobHttpError extends Error {
      readonly status = 503;

      constructor(message: string) {
        super(message);
        this.name = "BlobHttpError";
      }
    }

    const token = "vercel_blob_rw_abc123secret";
    const otherToken = "vercel_blob_rw_zzz999secret";
    const url = `https://blob.example.test/upload?token=${token}`;
    const detail = `internal-detail-marker ${url} with ${otherToken} `;
    const store = {
      put: async () => {
        throw new BlobHttpError(detail + "x".repeat(300));
      },
      delete: async () => {},
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const check = await checkBlob(
        { BLOB_READ_WRITE_TOKEN: token },
        () => store,
      );

      expect(check).toEqual({
        ok: false,
        message: "Blob check failed.",
      });
      expect(errorSpy).toHaveBeenCalledTimes(1);

      const summary = errorSpy.mock.calls[0]?.[1] as {
        name?: string;
        httpStatus?: number;
        message: string;
      };
      expect(summary).toMatchObject({
        name: "BlobHttpError",
        httpStatus: 503,
      });
      expect(summary.message).toHaveLength(200);
      expect(summary.message).toContain("[redacted]");
      expect(summary.message).toContain("internal-detail-marker");

      const logged = JSON.stringify(errorSpy.mock.calls);
      const response = JSON.stringify(check);
      for (const value of [token, otherToken, "https://", "blob.example.test"]) {
        expect(logged).not.toContain(value);
        expect(response).not.toContain(value);
      }
      expect(response).not.toContain("internal-detail-marker");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("omits a single-letter error name from the log", async () => {
    class MinifiedError extends Error {
      readonly status = 500;

      constructor() {
        super("minified failure");
        this.name = "x";
      }
    }

    const store = {
      put: async () => {
        throw new MinifiedError();
      },
      delete: async () => {},
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await checkBlob(
        { BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_test" },
        () => store,
      );

      const summary = errorSpy.mock.calls[0]?.[1] as { name?: string };
      expect(summary.name).toBeUndefined();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
