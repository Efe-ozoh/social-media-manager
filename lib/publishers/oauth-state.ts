/**
 * OAuth CSRF state helpers, shared by every platform's connect flow.
 *
 * A 256-bit random value goes into a short-lived httpOnly cookie when the flow
 * starts and is compared, in constant time, when the provider redirects back.
 * A mismatch means the callback did not start in this browser, so no token
 * exchange is attempted at all.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

/** A 256-bit random CSRF token (43 base64url characters). */
export function createOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Constant-time comparison of the state cookie with the returned state.
 * A missing or empty value never matches.
 */
export function statesMatch(
  expected: string | null | undefined,
  received: string | null | undefined,
): boolean {
  if (!expected || !received) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
