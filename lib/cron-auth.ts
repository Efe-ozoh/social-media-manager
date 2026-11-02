/**
 * Shared-secret check for POST /api/cron/dispatch — SPEC section 12.
 *
 * The comparison is constant-time: both values are hashed to fixed-length
 * SHA-256 digests and compared with timingSafeEqual, so neither the length nor
 * a matching prefix leaks through timing.
 *
 * The cron endpoint is exempt from the session cookie (an external scheduler
 * cannot log in) but never from this secret.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export const CRON_SECRET_ENV_VAR = "CRON_SECRET";
export const CRON_SECRET_HEADER = "x-cron-secret";

export function getCronSecret(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const secret = env[CRON_SECRET_ENV_VAR]?.trim();
  return secret ? secret : null;
}

/** Accepts `x-cron-secret: ...` or `Authorization: Bearer ...`. */
export function cronSecretFromRequest(request: Request): string | null {
  const header = request.headers.get(CRON_SECRET_HEADER)?.trim();
  if (header) return header;

  const authorization = request.headers.get("authorization")?.trim();
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match ? match[1].trim() : null;
}

/** Constant-time comparison of a supplied secret with the configured one. */
export function isCronSecretValid(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!provided || !expected) return false;

  const left = createHash("sha256").update(provided, "utf8").digest();
  const right = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(left, right);
}
