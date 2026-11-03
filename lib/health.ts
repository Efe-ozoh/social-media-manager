import { randomUUID } from "node:crypto";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { keyFromPublicUrl, VercelBlobImageStore } from "./image-store";
import { getPrisma } from "./prisma";
import { bundledFontsAvailable } from "./renderer";

export const HEALTH_CHECK_NAMES = [
  "database",
  "resvg",
  "sharp",
  "fonts",
  "blob",
] as const;

export type HealthCheckName = (typeof HEALTH_CHECK_NAMES)[number];

export const REQUIRED_ENV_NAMES = [
  "DATABASE_URL",
  "AUTH_SECRET",
  "ALLOWED_LOGIN",
  "APP_URL",
  "TOKEN_ENCRYPTION_KEY",
  "CRON_SECRET",
  "LINKEDIN_CLIENT_ID",
  "LINKEDIN_CLIENT_SECRET",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHANNEL_ID",
] as const;

export type HealthCheck = {
  ok: boolean;
  message: string;
};

export type HealthChecks = Record<HealthCheckName, HealthCheck>;

export type HealthReport = {
  ok: boolean;
  checks: HealthChecks;
  env: {
    ok: boolean;
    present: string[];
    missing: string[];
  };
};

export type HealthOptions = {
  env?: Record<string, string | undefined>;
  checks?: Partial<Record<HealthCheckName, () => Promise<HealthCheck>>>;
};

const SAFE_FAILURES: Record<HealthCheckName, string> = {
  database: "Database check failed.",
  resvg: "resvg check failed.",
  sharp: "sharp check failed.",
  fonts: "Bundled font check failed.",
  blob: "Blob check failed.",
};

const TINY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#ffffff"/></svg>';

async function checkDatabase(): Promise<HealthCheck> {
  try {
    await getPrisma().$queryRaw`SELECT 1`;
    return { ok: true, message: "Database query succeeded." };
  } catch {
    return { ok: false, message: "Database query failed." };
  }
}

async function checkResvg(): Promise<HealthCheck> {
  try {
    const png = new Resvg(TINY_SVG).render().asPng();
    return png.length > 0
      ? { ok: true, message: "resvg rendered a test slide." }
      : { ok: false, message: "resvg returned an empty image." };
  } catch {
    return { ok: false, message: "resvg check failed." };
  }
}

async function checkSharp(): Promise<HealthCheck> {
  try {
    const jpeg = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .jpeg({ quality: 80 })
      .toBuffer();

    return jpeg.length > 0 && jpeg[0] === 0xff && jpeg[1] === 0xd8
      ? { ok: true, message: "sharp encoded a test JPEG." }
      : { ok: false, message: "sharp returned an invalid image." };
  } catch {
    return { ok: false, message: "sharp check failed." };
  }
}

async function checkFonts(): Promise<HealthCheck> {
  try {
    return (await bundledFontsAvailable())
      ? { ok: true, message: "Bundled fonts were found." }
      : { ok: false, message: "Bundled fonts are missing." };
  } catch {
    return { ok: false, message: "Bundled font check failed." };
  }
}

export async function checkBlob(
  env: Record<string, string | undefined> = process.env,
): Promise<HealthCheck> {
  const token = env.BLOB_READ_WRITE_TOKEN?.trim();
  if (!token) {
    return {
      ok: true,
      message: "Blob check skipped: BLOB_READ_WRITE_TOKEN is not set.",
    };
  }

  const store = new VercelBlobImageStore(token);

  try {
    const url = await store.put(
      Buffer.from("health-check"),
      `health/${randomUUID()}.txt`,
      "text/plain",
    );
    const key = keyFromPublicUrl(url);
    if (!key) return { ok: false, message: "Blob check failed." };

    await store.delete(key);
    return { ok: true, message: "Blob write and delete succeeded." };
  } catch {
    return { ok: false, message: "Blob check failed." };
  }
}

async function runCheck(
  name: HealthCheckName,
  check: () => Promise<HealthCheck>,
): Promise<HealthCheck> {
  try {
    return await check();
  } catch {
    return { ok: false, message: SAFE_FAILURES[name] };
  }
}

export async function buildHealthReport(
  options: HealthOptions = {},
): Promise<HealthReport> {
  const env = options.env ?? process.env;
  const checkers: Record<HealthCheckName, () => Promise<HealthCheck>> = {
    database: options.checks?.database ?? checkDatabase,
    resvg: options.checks?.resvg ?? checkResvg,
    sharp: options.checks?.sharp ?? checkSharp,
    fonts: options.checks?.fonts ?? checkFonts,
    blob: options.checks?.blob ?? (() => checkBlob(env)),
  };

  const entries = await Promise.all(
    HEALTH_CHECK_NAMES.map(
      async (name) => [name, await runCheck(name, checkers[name])] as const,
    ),
  );
  const checks = Object.fromEntries(entries) as HealthChecks;

  const present: string[] = [];
  const missing: string[] = [];
  for (const name of REQUIRED_ENV_NAMES) {
    if (env[name]?.trim()) present.push(name);
    else missing.push(name);
  }

  const envOk = missing.length === 0;
  const checksOk = HEALTH_CHECK_NAMES.every((name) => checks[name].ok);

  return {
    ok: envOk && checksOk,
    checks,
    env: { ok: envOk, present, missing },
  };
}
