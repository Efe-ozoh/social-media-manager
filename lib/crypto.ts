/**
 * Token encryption at rest — SPEC section 5 and section 12.
 *
 * Platform tokens live in social_accounts as ciphertext (access_token_enc,
 * refresh_token_enc) and are encrypted with AES-256-GCM using a 32-byte key
 * from TOKEN_ENCRYPTION_KEY (base64). Every message gets a fresh random IV,
 * and GCM's auth tag makes tampering detectable.
 *
 * Wire format: `v1.<iv>.<ciphertext>.<tag>`, each part base64url. The version
 * prefix is also fed in as additional authenticated data, so a future v2
 * cannot be mistaken for a v1 payload.
 *
 * Plaintext tokens never appear in error messages or logs.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const TOKEN_KEY_ENV_VAR = "TOKEN_ENCRYPTION_KEY";
export const TOKEN_KEY_BYTES = 32;
export const TOKEN_CIPHER = "aes-256-gcm";

const VERSION = "v1";
const IV_BYTES = 12; // GCM's recommended nonce size
const TAG_BYTES = 16; // full GCM tag
const MAX_PAYLOAD_LENGTH = 16 * 1024;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export type TokenCryptoErrorCode =
  | "missing_key"
  | "invalid_key"
  | "malformed"
  | "unsupported_version"
  | "decrypt_failed";

/** A configuration or decryption problem, with a message safe to log. */
export class TokenCryptoError extends Error {
  readonly code: TokenCryptoErrorCode;

  constructor(code: TokenCryptoErrorCode, message: string) {
    super(message);
    this.name = "TokenCryptoError";
    this.code = code;
  }
}

function invalidKey(message: string): TokenCryptoError {
  return new TokenCryptoError("invalid_key", message);
}

/**
 * Decodes TOKEN_ENCRYPTION_KEY into a raw 32-byte key. Throws a
 * TokenCryptoError (never a bare TypeError) so callers can return a clear
 * "not configured" message instead of a 500 with a stack trace.
 */
export function decodeTokenKey(value: string | null | undefined): Buffer {
  const encoded = value?.trim();
  if (!encoded) {
    throw new TokenCryptoError(
      "missing_key",
      `${TOKEN_KEY_ENV_VAR} is not set. Generate a key with "openssl rand -base64 32" and add it to .env.local.`,
    );
  }

  if (!BASE64_PATTERN.test(encoded)) {
    throw invalidKey(
      `${TOKEN_KEY_ENV_VAR} must be standard base64 (generate it with "openssl rand -base64 32").`,
    );
  }

  const key = Buffer.from(encoded, "base64");
  if (key.length !== TOKEN_KEY_BYTES) {
    throw invalidKey(
      `${TOKEN_KEY_ENV_VAR} must decode to ${TOKEN_KEY_BYTES} bytes for AES-256-GCM, but it decodes to ${key.length}. Generate it with "openssl rand -base64 32".`,
    );
  }

  return key;
}

/** The configured key from the environment (or the given env object). */
export function getTokenKey(
  env: Record<string, string | undefined> = process.env,
): Buffer {
  return decodeTokenKey(env[TOKEN_KEY_ENV_VAR]);
}

function assertKey(key: Buffer): void {
  if (key.length !== TOKEN_KEY_BYTES) {
    throw invalidKey(
      `the AES-256-GCM key must be ${TOKEN_KEY_BYTES} bytes, but it is ${key.length}.`,
    );
  }
}

function aad(): Buffer {
  return Buffer.from(VERSION, "utf8");
}

/**
 * Encrypts a token. `key` defaults to TOKEN_ENCRYPTION_KEY; pass one
 * explicitly in tests.
 */
export function encryptToken(plaintext: string, key?: Buffer): string {
  const resolved = key ?? getTokenKey();
  assertKey(resolved);

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(TOKEN_CIPHER, resolved, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad());

  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
}

/**
 * Decrypts a payload produced by `encryptToken`. Throws a TokenCryptoError
 * with code "decrypt_failed" when the key is wrong or the payload was
 * tampered with — the two are indistinguishable by design.
 */
export function decryptToken(payload: string, key?: Buffer): string {
  const resolved = key ?? getTokenKey();
  assertKey(resolved);

  if (typeof payload !== "string" || payload.length === 0) {
    throw new TokenCryptoError("malformed", "the encrypted token is empty.");
  }
  if (payload.length > MAX_PAYLOAD_LENGTH) {
    throw new TokenCryptoError("malformed", "the encrypted token is unexpectedly large.");
  }

  const parts = payload.split(".");
  if (parts.length !== 4) {
    throw new TokenCryptoError(
      "malformed",
      "the encrypted token is not in the v1.<iv>.<ciphertext>.<tag> format.",
    );
  }

  const [version, ivPart, ciphertextPart, tagPart] = parts;
  if (version !== VERSION) {
    throw new TokenCryptoError(
      "unsupported_version",
      `the encrypted token uses an unsupported format version ("${version.slice(0, 8)}"); expected "${VERSION}".`,
    );
  }

  const iv = Buffer.from(ivPart, "base64url");
  const ciphertext = Buffer.from(ciphertextPart, "base64url");
  const tag = Buffer.from(tagPart, "base64url");

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new TokenCryptoError(
      "malformed",
      "the encrypted token has an invalid IV or auth tag length.",
    );
  }

  try {
    const decipher = createDecipheriv(TOKEN_CIPHER, resolved, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(aad());
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // Never echo the payload or the key: both are secrets.
    throw new TokenCryptoError(
      "decrypt_failed",
      `the stored token could not be decrypted; ${TOKEN_KEY_ENV_VAR} is wrong or the token was modified.`,
    );
  }
}

/** True when a stored value looks like a v1 encrypted token. */
export function isEncryptedToken(value: string): boolean {
  return value.startsWith(`${VERSION}.`) && value.split(".").length === 4;
}
