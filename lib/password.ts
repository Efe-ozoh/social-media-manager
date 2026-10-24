import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

// Stored format: scrypt$<salt-hex>$<hash-hex>
// Generate one with `npm run hash-password -- "your password"`.
const PREFIX = "scrypt";
const KEY_LENGTH = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH);
  return `${PREFIX}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/** Constant-time check against an `scrypt$salt$hash` string. */
export function verifyPassword(password: string, stored: string | undefined): boolean {
  if (!stored) return false;

  const parts = stored.trim().split("$");
  if (parts.length !== 3 || parts[0] !== PREFIX) return false;

  const [, saltHex, hashHex] = parts;
  if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(hashHex)) return false;

  const expected = Buffer.from(hashHex, "hex");
  if (expected.length !== KEY_LENGTH) return false;

  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

export function isPasswordHashConfigured(): boolean {
  return Boolean(process.env.ALLOWED_LOGIN?.trim());
}
