import { describe, expect, it } from "vitest";
import {
  decodeTokenKey,
  decryptToken,
  encryptToken,
  getTokenKey,
  isEncryptedToken,
  TokenCryptoError,
  TOKEN_KEY_ENV_VAR,
} from "./crypto";

/** A deterministic 32-byte key, base64: 32 bytes of 0x01. */
const KEY_B64 = Buffer.alloc(32, 1).toString("base64");
const OTHER_KEY_B64 = Buffer.alloc(32, 2).toString("base64");
const KEY = Buffer.from(KEY_B64, "base64");
const OTHER_KEY = Buffer.from(OTHER_KEY_B64, "base64");

const SECRET = "AQV-very-secret-access-token-1234567890";

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof TokenCryptoError) return error.code;
    throw error;
  }
  throw new Error("expected a TokenCryptoError");
}

describe("decodeTokenKey", () => {
  it("decodes a 32-byte base64 key", () => {
    expect(decodeTokenKey(KEY_B64)).toEqual(KEY);
    expect(decodeTokenKey(`  ${KEY_B64}  `)).toEqual(KEY);
  });

  it("rejects a missing key with an actionable message", () => {
    for (const value of [undefined, null, "", "   "]) {
      try {
        decodeTokenKey(value);
        throw new Error("expected a throw");
      } catch (error) {
        expect(error).toBeInstanceOf(TokenCryptoError);
        expect((error as TokenCryptoError).code).toBe("missing_key");
        expect((error as Error).message).toContain(TOKEN_KEY_ENV_VAR);
        expect((error as Error).message).toContain("openssl rand -base64 32");
      }
    }
  });

  it("rejects a key of the wrong length and says what was wrong", () => {
    const short = Buffer.alloc(16, 7).toString("base64");
    try {
      decodeTokenKey(short);
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as TokenCryptoError).code).toBe("invalid_key");
      expect((error as Error).message).toContain("32 bytes");
      expect((error as Error).message).toContain("decodes to 16");
    }
  });

  it("rejects values that are not base64", () => {
    expect(codeOf(() => decodeTokenKey("not base64!!"))).toBe("invalid_key");
    expect(codeOf(() => decodeTokenKey("a".repeat(43) + "-"))).toBe("invalid_key");
  });

  it("reads the key from the given env object", () => {
    expect(getTokenKey({ [TOKEN_KEY_ENV_VAR]: KEY_B64 })).toEqual(KEY);
    expect(codeOf(() => getTokenKey({}))).toBe("missing_key");
  });
});

describe("encryptToken / decryptToken", () => {
  it("round-trips plaintext", () => {
    const payload = encryptToken(SECRET, KEY);
    expect(decryptToken(payload, KEY)).toBe(SECRET);
  });

  it("round-trips awkward plaintexts", () => {
    const cases = ["", " ", "a", "ünïcode ✓ 🔐", "line\nbreak\tand\0null", "x".repeat(10_000)];
    for (const plaintext of cases) {
      expect(decryptToken(encryptToken(plaintext, KEY), KEY)).toBe(plaintext);
    }
  });

  it("uses the v1 format and never embeds the plaintext", () => {
    const payload = encryptToken(SECRET, KEY);
    const parts = payload.split(".");

    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
    expect(Buffer.from(parts[1], "base64url")).toHaveLength(12);
    expect(Buffer.from(parts[3], "base64url")).toHaveLength(16);
    expect(payload).not.toContain(SECRET);
    expect(isEncryptedToken(payload)).toBe(true);
  });

  it("uses a fresh IV per message, so equal plaintexts differ", () => {
    const first = encryptToken(SECRET, KEY);
    const second = encryptToken(SECRET, KEY);

    expect(first).not.toBe(second);
    expect(first.split(".")[1]).not.toBe(second.split(".")[1]);
    expect(decryptToken(first, KEY)).toBe(SECRET);
    expect(decryptToken(second, KEY)).toBe(SECRET);
  });

  it("detects a tampered ciphertext", () => {
    const [version, iv, ciphertext, tag] = encryptToken(SECRET, KEY).split(".");
    const bytes = Buffer.from(ciphertext, "base64url");
    bytes[0] ^= 0x01;
    const tampered = [version, iv, bytes.toString("base64url"), tag].join(".");

    expect(codeOf(() => decryptToken(tampered, KEY))).toBe("decrypt_failed");
  });

  it("detects a tampered auth tag", () => {
    const [version, iv, ciphertext, tag] = encryptToken(SECRET, KEY).split(".");
    const bytes = Buffer.from(tag, "base64url");
    bytes[bytes.length - 1] ^= 0x01;

    expect(
      codeOf(() => decryptToken([version, iv, ciphertext, bytes.toString("base64url")].join("."), KEY)),
    ).toBe("decrypt_failed");
  });

  it("rejects an unknown format version instead of guessing", () => {
    const [, iv, ciphertext, tag] = encryptToken(SECRET, KEY).split(".");

    expect(codeOf(() => decryptToken(["v2", iv, ciphertext, tag].join("."), KEY))).toBe(
      "unsupported_version",
    );
  });

  it("fails clearly with the wrong key and leaks neither key nor token", () => {
    const payload = encryptToken(SECRET, KEY);

    try {
      decryptToken(payload, OTHER_KEY);
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(TokenCryptoError);
      expect((error as TokenCryptoError).code).toBe("decrypt_failed");
      const message = (error as Error).message;
      expect(message).toContain("could not be decrypted");
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain(KEY_B64);
      expect(message).not.toContain(payload);
    }
  });

  it("rejects malformed payloads without throwing a TypeError", () => {
    const payload = encryptToken(SECRET, KEY);
    const [, iv, ciphertext, tag] = payload.split(".");

    expect(codeOf(() => decryptToken("", KEY))).toBe("malformed");
    expect(codeOf(() => decryptToken("v1", KEY))).toBe("malformed");
    expect(codeOf(() => decryptToken("v1.a.b", KEY))).toBe("malformed");
    expect(codeOf(() => decryptToken(`${payload}.extra`, KEY))).toBe("malformed");
    // Truncated IV or tag.
    expect(codeOf(() => decryptToken(["v1", "AAAA", ciphertext, tag].join("."), KEY))).toBe(
      "malformed",
    );
    expect(codeOf(() => decryptToken(["v1", iv, ciphertext, "AAAA"].join("."), KEY))).toBe(
      "malformed",
    );
    expect(codeOf(() => decryptToken("x".repeat(20_000), KEY))).toBe("malformed");
  });

  it("rejects a key of the wrong size passed directly", () => {
    expect(codeOf(() => encryptToken(SECRET, Buffer.alloc(16)))).toBe("invalid_key");
    expect(codeOf(() => decryptToken(encryptToken(SECRET, KEY), Buffer.alloc(16)))).toBe(
      "invalid_key",
    );
  });

  it("falls back to TOKEN_ENCRYPTION_KEY when no key is passed", () => {
    const previous = process.env[TOKEN_KEY_ENV_VAR];
    process.env[TOKEN_KEY_ENV_VAR] = KEY_B64;
    try {
      expect(decryptToken(encryptToken(SECRET))).toBe(SECRET);
    } finally {
      if (previous === undefined) delete process.env[TOKEN_KEY_ENV_VAR];
      else process.env[TOKEN_KEY_ENV_VAR] = previous;
    }
  });
});
